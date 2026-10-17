import { watchEvents } from "@earendil-works/pi-durable";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { RUN_CONTEXT } from "../runtime.mjs";

/**
 * Transcript projection: the container's children ARE the display. Initialized
 * from the committed snapshot, then updated incrementally from event batches;
 * a snapshot delivered on overflow rebuilds the whole projection (the design's
 * reconnect/slow-consumer rule). UI state lives only here, never in durable.
 */
/**
 * @param {{ harness: import("@earendil-works/pi-durable").Harness; conversationId: any; container: import("@earendil-works/pi-tui").Container; tui: import("@earendil-works/pi-tui").TUI; onBusyChange?: (busy: boolean) => void; onSnapshotMeta?: (snapshot: any) => void }} args
 */
export async function attachTranscript({ harness, conversationId, container, tui, onBusyChange, onSnapshotMeta }) {
	const projection = new Projection(container, tui, onBusyChange);
	const stream = await watchEvents(harness, conversationId, RUN_CONTEXT);
	projection.applySnapshot(stream.snapshot);
	onSnapshotMeta?.(stream.snapshot);
	await stream.start(async (batch) => {
		for (const event of batch) {
			if (event.type === "snapshot") {
				projection.applySnapshot(event);
				onSnapshotMeta?.(event);
			} else {
				projection.applyEvent(event);
			}
		}
		tui.requestRender();
	});
	return {
		detach: () => stream.stop().catch(() => {}),
		conversationId,
	};
}

class Projection {
	/**
	 * @param {import("@earendil-works/pi-tui").Container} container
	 * @param {import("@earendil-works/pi-tui").TUI} tui
	 * @param {(busy: boolean) => void} [onBusyChange]
	 */
	constructor(container, tui, onBusyChange) {
		this.container = container;
		this.tui = tui;
		this.onBusyChange = onBusyChange;
		/** Display index by stable key: entry id, toolCallId, or "stream". */
		this.index = new Map();
		this.tools = new Map(); // toolCallId -> ToolExecutionComponent
		this.streaming = undefined;
		/** @type {boolean | undefined} */
		this.busy = undefined;
	}

	/** @param {any} snapshot */
	applySnapshot(snapshot) {
		this.container.clear();
		this.index.clear();
		this.tools.clear();
		this.streaming = undefined;
		for (const entry of /** @type {any[]} */ (snapshot.entries)) this.appendEntry(entry);
		if (snapshot.generation?.message) this.beginStream(snapshot.generation.message);
		const results = new Map(/** @type {any[]} */ (snapshot.entries).map((entry) => [entry.id, entry.model?.[0]]));
		for (const slot of snapshot.tools) {
			if (!this.tools.has(slot.callId)) this.toolStart(slot.callId, slot.name, {}, true);
			const component = this.tools.get(slot.callId);
			if (component && slot.output) component.updateResult({ content: [{ type: "text", text: slot.output }], isError: false }, true);
			if (component && slot.status === "done" && slot.entry) {
				const result = results.get(slot.entry);
				if (result) component.updateResult({ content: result.content, isError: Boolean(result.isError), durationMs: result.durationMs }, false);
			}
		}
		this.setBusy(Boolean(snapshot.generation || snapshot.tools.length > 0 || snapshot.compactions.length > 0));
	}

	/** @param {any} event */
	applyEvent(event) {
		switch (event.type) {
			case "run_start":
				this.setBusy(true);
				break;
			case "run_end":
				this.setBusy(false);
				break;
			case "message_start":
				if (event.message.role === "assistant") this.beginStream(event.message);
				break;
			case "message_update":
				if (this.streaming) {
					this.streaming.updateContent(
					/** @type {any} */ (latestMessage(event.changes, this.streaming)),
					true,
				);
				}
				break;
			case "message_end":
				if (this.streaming) {
					this.container.removeChild(this.streaming);
					this.index.delete("stream");
					this.streaming = undefined;
				}
				this.appendEntry(event.entry);
				break;
			case "entry_appended":
				if (!this.index.has(event.entry.id)) this.appendEntry(event.entry);
				break;
			case "tool_execution_start":
				this.toolStart(event.toolCallId, event.toolName, event.args, false);
				break;
			case "tool_execution_update": {
				const component = this.tools.get(event.toolCallId);
				if (component) {
					const text = event.output ? ("set" in event.output ? event.output.set : (event.output.append ?? "")) : undefined;
					if (text !== undefined) component.updateResult({ content: [{ type: "text", text }], isError: false }, true);
				}
				break;
			}
			case "tool_execution_end": {
				const component = this.tools.get(event.toolCallId);
				if (component && event.entry?.model) {
					const result = event.entry.model[0];
					component.updateResult(
						{ content: result.content, isError: Boolean(result.isError), durationMs: result.durationMs },
						false,
					);
				} else if (component) {
					component.updateResult({ content: [{ type: "text", text: "interrupted" }], isError: true }, false);
				}
				break;
			}
		}
	}

	/** @param {boolean} busy */
	setBusy(busy) {
		if (this.busy !== busy) {
			this.busy = busy;
			this.onBusyChange?.(busy);
		}
	}

	/** @param {any} message */
	beginStream(message) {
		this.endStream();
		const component = new AssistantMessageComponent(
			/** @type {import("@earendil-works/pi-ai").AssistantMessage} */ (structuredClone(message)),
			false,
			getMarkdownTheme(),
			undefined,
			1,
		);
		component.updateContent(/** @type {import("@earendil-works/pi-ai").AssistantMessage} */ (message), true);
		this.streaming = component;
		this.index.set("stream", this.container.children.length);
		this.container.addChild(component);
	}

	endStream() {
		if (this.streaming) {
			this.container.removeChild(this.streaming);
			this.index.delete("stream");
			this.streaming = undefined;
		}
	}

	/** @param {string} callId @param {string} toolName @param {any} args @param {boolean} fromSnapshot */
	toolStart(callId, toolName, args, fromSnapshot) {
		if (this.tools.has(callId)) return;
		const component = new ToolExecutionComponent(toolName, callId, args, { showImages: false }, undefined, this.tui, process.cwd());
		component.markExecutionStarted();
		component.setArgsComplete();
		this.tools.set(callId, component);
		this.container.addChild(component);
		if (!fromSnapshot) this.setBusy(true);
	}

	/** @param {{ id: string; kind: string; model?: unknown[] }} entry */
	appendEntry(entry) {
		if (this.index.has(entry.id)) return;
		const component = this.entryComponent(entry);
		if (!component) return;
		this.index.set(entry.id, this.container.children.length);
		this.container.addChild(component);
	}

	/** @param {{ id: string; kind: string; model?: unknown[] }} entry */
	entryComponent(entry) {
		const message = /** @type {any} */ (entry.model?.[0]);
		switch (entry.kind) {
			case "pi.user":
				return new UserMessageComponent(textOfUser(message), getMarkdownTheme(), 1);
			case "pi.assistant": {
				// A tool-call-only assistant entry is represented by its ToolExecutionComponents.
				const assistant = /** @type {any} */ (entry.model?.[0]);
				const hasVisible = /** @type {{ type: string }[]} */ (assistant?.content ?? []).some(
					(block) => block.type === "text" || block.type === "thinking",
				);
				return hasVisible
					? new AssistantMessageComponent(/** @type {import("@earendil-works/pi-ai").AssistantMessage} */ (assistant), false, getMarkdownTheme(), undefined, 1)
					: null;
			}
			case "pi.tool-result":
				return null; // rendered by the tool component that owns the call
			case "pi.system":
				return null;
			case "pi.reset":
				return new Text(dim("── new context ──"), 0, 1);
			case "pi.compaction":
				return new Text(dim("── context compacted ──"), 0, 1);
			default:
				return new Text(dim(`── ${entry.kind} ──`), 0, 1);
		}
	}
}

/**
 * Tool slots and events carry the message in pieces; rebuild the newest partial.
 * @param {any[]} changes @param {any} previous
 */
function latestMessage(changes, previous) {
	const message = structuredClone(previous);
	for (const change of changes) {
		const typed = /** @type {{ type: string; contentIndex?: number; block?: unknown; delta?: string; path?: readonly (string | number)[]; message?: { content: unknown[] } }} */ (change);
		switch (typed.type) {
			case "message":
				return typed.message;
			case "block":
				grow(message, typed.contentIndex ?? 0)[typed.contentIndex ?? 0] = typed.block;
				break;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta": {
				const block = /** @type {{ type?: string; text?: string; thinking?: string }} */ (
					grow(message, typed.contentIndex ?? 0)[typed.contentIndex ?? 0]
				);
				if (typed.type === "text_delta" && block?.type === "text") block.text = (block.text ?? "") + typed.delta;
				else if (typed.type === "thinking_delta" && block?.type === "thinking") block.thinking = (block.thinking ?? "") + typed.delta;
				else if (typed.type === "toolcall_delta" && block?.type === "toolCall" && typed.path)
					applyToolcallDelta(/** @type {Record<string, unknown>} */ (block), typed.path, typed.delta ?? "");
				break;
			}
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
				grow(message, typed.contentIndex ?? 0)[typed.contentIndex ?? 0] = typed.block;
				break;
		}
	}
	return message;
}

/** @param {{ content: unknown[] }} message @param {number} contentIndex */
function grow(message, contentIndex) {
	while (message.content.length <= contentIndex) message.content.push({ type: "text", text: "" });
	return message.content;
}

/**
 * @param {Record<string, unknown>} block
 * @param {readonly (string | number)[]} path
 * @param {string} delta
 */
function applyToolcallDelta(block, path, delta) {
	let node = block;
	for (let i = 0; i < path.length - 1; i++) node = /** @type {Record<string, unknown>} */ (node[path[i]]);
	const last = path[path.length - 1];
	if (typeof last === "number" && Array.isArray(node)) node[last] = String(node[last] ?? "") + delta;
	else if (node && typeof node === "object" && typeof last === "string") node[last] = String(node[last] ?? "") + delta;
}

/** @param {{ content: string | Array<{ type: string; text?: string }> } | undefined} message */
function textOfUser(message) {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "[image]")).join("");
}

/** @param {string} text */
function dim(text) {
	// The active theme is a global after initTheme(); dim via its muted token.
	const globals = /** @type {Record<symbol, { fg?: (token: string, text: string) => string }>} */ (globalThis);
	const theme = globals[Symbol.for("@earendil-works/pi-coding-agent:theme")];
	return theme?.fg ? theme.fg("muted", text) : text;
}
