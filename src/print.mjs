import { watchEvents } from "@earendil-works/pi-durable";
import { RUN_CONTEXT } from "./runtime.mjs";

/**
 * Print mode: submit one prompt, stream the answer to stdout, exit. Tool
 * executions render as one line each; thinking is not shown. Ctrl-C aborts the
 * run and exits non-zero.
 */
/**
 * @param {{ harness: import("@earendil-works/pi-durable").Harness; root: import("@earendil-works/pi-durable").Conversation; prompt: string; signal?: AbortSignal }} args
 */
export async function runPrint({ harness, root, prompt, signal }) {
	const events = await watchEvents(harness, root.id, RUN_CONTEXT);
	const submission = await root.submit({ type: "input", content: prompt }, RUN_CONTEXT);

	let inText = false;
	let interrupted = false;
	const onInterrupt = async () => {
		interrupted = true;
		await root.abort(RUN_CONTEXT).catch(() => {});
	};
	if (signal) {
		if (signal.aborted) onInterrupt();
		else signal.addEventListener("abort", onInterrupt, { once: true });
	} else {
		process.on("SIGINT", () => void onInterrupt());
	}

	const settled = await new Promise((resolve) => {
		events.start(async (batch) => {
			for (const event of batch) renderEvent(event);
			// The batch that settles the submission also carries its answer's entry events, so
			// resolving from the stream (not submission.wait) keeps rendering race-free.
			const record = /** @type {any} */ (
				batch.find(
					(event) => event.type === "submission" && /** @type {any} */ (event).record.id === submission.id && isSettled(/** @type {any} */ (event).record),
				)
			)?.record;
			if (record) resolve(record);
		});
	});

	if (inText) process.stdout.write("\n");
	await events.stop().catch(() => {});
	if (settled.status === "unanswered") {
		const reason = interrupted ? "interrupted" : settled.reason;
		process.stderr.write(`siftory: ${reason}\n`);
		return 1;
	}
	return 0;

	/** @param {any} event */
	function renderEvent(event) {
		switch (event.type) {
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "text_delta") {
						process.stdout.write(change.delta);
						inText = true;
					} else if (change.type === "block" && change.block.type === "text" && !inText) {
						// A completed block the deltas never carried (fast commits): print once.
						process.stdout.write(change.block.text);
						inText = true;
					}
				}
				break;
			case "message_end":
				if (inText) {
				process.stdout.write("\n");
				inText = false;
				break;
				}
				// Fast commits never stream deltas; print the committed answer text once.
				if (event.entry.kind === "pi.assistant") {
					const message = event.entry.model?.[0];
					const text = /** @type {{ type: string; text?: string }[]} */ (message?.content ?? [])
						.filter((block) => block.type === "text")
						.map((block) => block.text ?? "")
						.join("");
					if (text) process.stdout.write(`${text}\n`);
				}
				break;
			case "tool_execution_start":
				process.stdout.write(`● ${event.toolName}${summarizeArgs(event.args)}\n`);
				break;
			case "tool_execution_end":
				if (event.entry?.model) {
					const result = event.entry.model[0];
					if (result?.type === "toolResult" && result.isError) process.stdout.write(`  error: ${textOf(result.content)}\n`);
				}
				break;
		}
	}
}

/** @param {any} record */
function isSettled(record) {
	return record.status === "done" || record.status === "unanswered";
}

/** @param {any} args */
function summarizeArgs(args) {
	const command = args?.command ?? args?.path;
	return command ? `(${truncate(String(command), 60)})` : "";
}

/** @param {string} text @param {number} max */
function truncate(text, max) {
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** @param {any} content */
function textOf(content) {
	if (typeof content === "string") return truncate(content, 200);
	if (Array.isArray(content)) return truncate(content.filter((part) => part.type === "text").map((part) => part.text).join(""), 200);
	return "";
}
