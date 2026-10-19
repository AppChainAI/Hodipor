import { watchEvents } from "@earendil-works/pi-durable";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { RUN_CONTEXT } from "../runtime.mjs";
import { nativeToolRenderers, ThemedText } from "./pi-display.mjs";
import { activeTheme } from "./theme.mjs";
import { createTodoRenderers } from "../../extensions/todo/ui.mjs";

/**
 * Transcript projection: the container's children ARE the display. Initialized
 * from the committed snapshot, then updated incrementally from event batches;
 * a snapshot delivered on overflow rebuilds the whole projection (the design's
 * reconnect/slow-consumer rule). UI state lives only here, never in durable.
 */
/**
 * @param {{ harness: import("@earendil-works/pi-durable").Harness; conversationId: any; container: import("@earendil-works/pi-tui").Container; tui: import("@earendil-works/pi-tui").TUI; onBusyChange?: (busy: boolean) => void; onSnapshotMeta?: (snapshot: any) => void; onActivityChange?: (activity: import("./run-status.mjs").Activity | undefined) => void; onEvent?: (event: import("@earendil-works/pi-durable").AgentEvent) => void; getTodos?: () => { tasks: any[] }; expandedTools?: boolean; hideThinking?: boolean }} args
 */
export async function attachTranscript({ harness, conversationId, container, tui, onBusyChange, onSnapshotMeta, onActivityChange, onEvent, getTodos, expandedTools = false, hideThinking = false }) {
	const projection = new Projection(container, tui, { onBusyChange, onActivityChange, getTodos });
	projection.expandedTools = expandedTools;
	projection.hideThinking = hideThinking;
	const stream = await watchEvents(harness, conversationId, RUN_CONTEXT);
	projection.applySnapshot(stream.snapshot);
	let meta = stream.snapshot;
	onSnapshotMeta?.(meta);
	await stream.start(async (batch) => {
		for (const event of batch) {
			if (event.type === "snapshot") {
				projection.applySnapshot(event);
				meta = event;
				onSnapshotMeta?.(meta);
			} else {
				projection.applyEvent(event);
				if (event.type === "agent_changed" || event.type === "usage_changed") {
					meta = { ...meta, ...(event.type === "agent_changed" ? { agent: event.agent } : { usage: event.usage }) };
					onSnapshotMeta?.(meta);
				}
			}
			onEvent?.(event);
		}
		tui.requestRender();
	});
	return {
		detach: async () => {
			await stream.stop().catch(() => {});
			projection.stopToolTimers();
		},
		setToolsExpanded: (/** @type {boolean} */ expanded) => projection.setToolsExpanded(expanded),
		setHideThinking: (/** @type {boolean} */ hidden) => projection.setHideThinking(hidden),
		conversationId,
	};
}

class Projection {
	/**
	 * @param {import("@earendil-works/pi-tui").Container} container
	 * @param {import("@earendil-works/pi-tui").TUI} tui
	 * @param {{ onBusyChange?: (busy: boolean) => void; onActivityChange?: (activity: import("./run-status.mjs").Activity | undefined) => void; getTodos?: () => { tasks: any[] } }} callbacks
	 */
	constructor(container, tui, { onBusyChange, onActivityChange, getTodos = () => ({ tasks: [] }) }) {
		this.container = container;
		this.tui = tui;
		this.onBusyChange = onBusyChange;
		this.onActivityChange = onActivityChange;
		this.getTodos = getTodos;
		/** Display index by stable key: entry id, toolCallId, or "stream". */
		this.index = new Map();
		this.tools = new Map(); // toolCallId -> ToolExecutionComponent
		this.toolOutputs = new Map();
		this.toolResults = new Map();
		this.toolNames = new Map();
		this.groupOf = new Map();
		this.groupCalls = new Map();
		this.cwd = process.cwd();
		this.expandedTools = false;
		this.hideThinking = false;
		this.message = undefined;
		this.streaming = undefined;
		/** @type {boolean | undefined} */
		this.busy = undefined;
		this.running = false;
		this.compactions = new Map();
		/** @type {{ attempt: number; at: number } | undefined} */
		this.retry = undefined;
		/** @type {number | undefined} */
		this.deferredAt = undefined;
		/** @type {string | undefined} */
		this.activityKey = "";
	}

	/** @param {any} snapshot */
	applySnapshot(snapshot) {
		this.stopToolTimers();
		this.container.clear();
		this.index.clear();
		this.tools.clear();
		this.toolOutputs.clear();
		this.toolResults.clear();
		this.toolNames.clear();
		this.groupOf.clear();
		this.groupCalls.clear();
		this.cwd = snapshot.agent?.cwd ?? this.cwd;
		this.message = undefined;
		this.streaming = undefined;
		for (const entry of /** @type {any[]} */ (snapshot.entries)) this.appendEntry(entry);
		if (snapshot.generation?.message) this.beginStream(snapshot.generation.message);
		const results = new Map(/** @type {any[]} */ (snapshot.entries).map((entry) => [entry.id, entry.model?.[0]]));
		for (const slot of snapshot.tools) {
			if (!this.tools.has(slot.callId)) this.toolStart(slot.callId, slot.name, {}, true);
			const component = this.tools.get(slot.callId);
			if (component && slot.status !== "done") {
				this.toolOutputs.set(slot.callId, slot.output ?? "");
				this.setToolResult(slot.callId, { content: [{ type: "text", text: slot.output ?? "" }], details: slot.details, isError: false }, true);
			}
			if (component && slot.status === "done") {
				const result = results.get(slot.entry) ?? { content: [{ type: "text", text: "result unavailable" }], isError: true };
				this.setToolResult(slot.callId, result, false);
			}
		}
		for (const slot of snapshot.nestedTools ?? []) {
			this.toolStart(slot.callId, slot.name, slot.arguments, true, slot.parentCallId);
			if (this.groupOf.has(slot.callId)) {
				if (slot.status === "done") this.finishGroupedCall(slot.callId, slot.summary);
			} else {
				this.setToolResult(slot.callId, { content: [{ type: "text", text: slot.output ?? slot.summary?.error ?? (slot.status === "done" && !slot.summary ? "result unavailable" : "") }], details: slot.details, isError: slot.summary?.isError ?? (slot.status === "done"), durationMs: slot.summary?.durationMs }, slot.status !== "done");
			}
		}
		this.running = Boolean(snapshot.run || snapshot.generation || snapshot.tools.some((/** @type {any} */ slot) => slot.status !== "done"));
		this.compactions = new Map(snapshot.compactions.map((/** @type {any} */ item) => [item.taskId, item.reason]));
		this.retry = snapshot.generation?.retry ? { attempt: snapshot.generation.attempt, at: snapshot.generation.retry.at } : undefined;
		this.deferredAt = snapshot.generation?.deferred?.pollAt;
		this.updateBusy();
	}

	/** @param {any} event */
	applyEvent(event) {
		switch (event.type) {
			case "run_start":
				this.running = true;
				this.updateBusy();
				break;
			case "run_end":
				this.running = false;
				this.retry = undefined;
				this.deferredAt = undefined;
				this.updateBusy();
				break;
			case "auto_retry_start":
				this.retry = { attempt: event.attempt, at: event.at };
				this.updateBusy();
				break;
			case "auto_retry_end":
				this.retry = undefined;
				this.updateBusy();
				break;
			case "deferred_poll":
				this.deferredAt = event.pollAt;
				this.updateBusy();
				break;
			case "compaction_start":
				this.compactions.set(event.taskId, event.reason);
				this.updateBusy();
				break;
			case "compaction_end":
				this.compactions.delete(event.taskId);
				this.updateBusy();
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					this.retry = undefined;
					this.deferredAt = undefined;
					this.beginStream(event.message);
					this.updateBusy();
				}
				break;
			case "message_update":
				if (this.streaming) {
					this.message = latestMessage(event.changes, this.message);
					this.streaming.updateContent(/** @type {any} */ (this.message), true);
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
				this.toolStart(event.toolCallId, event.toolName, event.args, false, event.parentToolCallId);
				break;
			case "tool_execution_update": {
				const component = this.tools.get(event.toolCallId);
				if (component) {
					const text = event.output ? ("set" in event.output ? event.output.set : (this.toolOutputs.get(event.toolCallId) ?? "").slice(event.output.trimStart ?? 0) + (event.output.append ?? "")) : undefined;
					if (text !== undefined) this.toolOutputs.set(event.toolCallId, text);
					const previous = this.toolResults.get(event.toolCallId) ?? { content: [], isError: false };
					this.setToolResult(event.toolCallId, { ...previous, ...(text === undefined ? {} : { content: [{ type: "text", text }] }), ...(event.details === undefined ? {} : { details: event.details }) }, true);
				}
				break;
			}
			case "tool_execution_end": {
				if (this.groupOf.has(event.toolCallId)) {
					this.finishGroupedCall(event.toolCallId, event.result);
				} else {
					const result = event.entry?.model?.[0] ?? (event.result ? nestedToolResult(event.result) : { content: [{ type: "text", text: "result unavailable" }], isError: true });
					this.setToolResult(event.toolCallId, result, false);
				}
				break;
			}
		}
	}

	/** @param {string} callId @param {any} result @param {boolean} partial */
	setToolResult(callId, result, partial) {
		this.toolResults.set(callId, result);
		this.tools.get(callId)?.updateResult({ content: result.content ?? [], details: result.details, isError: Boolean(result.isError), durationMs: result.durationMs }, partial);
	}

	/** @param {string} group */
	paintGroupedCalls(group) {
		const previous = this.toolResults.get(group) ?? { content: [], isError: false };
		this.setToolResult(group, { ...previous, details: { ...previous.details, calls: [...this.groupCalls.get(group).values()] } }, true);
	}

	/** @param {string} callId @param {any} result */
	finishGroupedCall(callId, result) {
		const group = this.groupOf.get(callId);
		const call = this.groupCalls.get(group)?.get(callId);
		if (!call) return;
		call.status = !result || result.isError ? "error" : "ok";
		call.durationMs = result?.durationMs;
		call.error = !result ? "result unavailable" : result.error ?? result.diagnostics?.filter((/** @type {any} */ item) => item.severity === "error").map((/** @type {any} */ item) => item.message).join("\n");
		this.paintGroupedCalls(group);
	}

	/** @param {boolean} expanded */
	setToolsExpanded(expanded) {
		this.expandedTools = expanded;
		for (const component of this.tools.values()) component.setExpanded(expanded);
		this.tui.requestRender();
	}

	/** @param {boolean} hidden */
	setHideThinking(hidden) {
		this.hideThinking = hidden;
		for (const component of this.container.children) {
			if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(hidden);
		}
		this.tui.requestRender();
	}

	stopToolTimers() {
		// Native shell/codemode previews start elapsed-time intervals; settle the detached display only.
		for (const [callId, component] of this.tools) {
			const result = this.toolResults.get(callId);
			component.updateResult({ content: result?.content ?? [], details: result?.details, isError: Boolean(result?.isError), durationMs: result?.durationMs }, false);
		}
	}

	updateBusy() {
		this.setBusy(this.running || this.compactions.size > 0);
		/** @type {import("./run-status.mjs").Activity | undefined} */
		const activity = this.compactions.size ? { kind: "compaction", reason: this.compactions.values().next().value, taskId: this.compactions.keys().next().value }
			: !this.running ? undefined
			: this.retry ? { kind: "retry", ...this.retry }
			: this.deferredAt !== undefined ? { kind: "deferred", at: this.deferredAt }
			: { kind: "working" };
		const key = JSON.stringify(activity);
		if (key !== this.activityKey) {
			this.activityKey = key;
			this.onActivityChange?.(activity);
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
		this.message = structuredClone(message);
		const component = new AssistantMessageComponent(
			/** @type {import("@earendil-works/pi-ai").AssistantMessage} */ (structuredClone(message)),
			this.hideThinking,
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

	/** @param {string} callId @param {string} toolName @param {any} args @param {boolean} fromSnapshot @param {string} [parentCallId] */
	toolStart(callId, toolName, args, fromSnapshot, parentCallId) {
		if (this.tools.has(callId) || this.groupOf.has(callId)) return;
		this.toolNames.set(callId, toolName);
		const group = parentCallId && (this.toolNames.get(parentCallId) === "codemode" ? parentCallId : this.groupOf.get(parentCallId));
		if (group) {
			this.groupOf.set(callId, group);
			const calls = this.groupCalls.get(group) ?? new Map();
			const argsText = JSON.stringify(args);
			const preview = argsText.length > 200 ? `${argsText.slice(0, 197)}...` : argsText;
			calls.set(callId, { id: calls.size, name: toolName, args: preview, status: "running" });
			this.groupCalls.set(group, calls);
			this.paintGroupedCalls(group);
			return;
		}
		const component = new ToolExecutionComponent(toolName, callId, args, { showImages: false }, toolName === "todo" ? createTodoRenderers(() => this.toolResults.get(callId)?.details ?? this.getTodos()) : nativeToolRenderers(toolName), this.tui, this.cwd);
		component.setExpanded(this.expandedTools);
		component.markExecutionStarted();
		component.setArgsComplete();
		this.tools.set(callId, component);
		this.container.addChild(component);
		if (!fromSnapshot) {
			this.running = true;
			this.updateBusy();
		}
	}

	/** @param {{ id: string; kind: string; model?: unknown[] }} entry */
	appendEntry(entry) {
		if (this.index.has(entry.id)) return;
		const component = this.entryComponent(entry);
		this.index.set(entry.id, this.container.children.length);
		if (component) this.container.addChild(component);
		const message = /** @type {any} */ (entry.model?.[0]);
		if (entry.kind === "pi.assistant") {
			for (const block of message?.content ?? []) {
				if (block.type === "toolCall") this.toolStart(block.id, block.name, block.arguments, true);
			}
		} else if (entry.kind === "pi.tool-result" && message) {
			this.toolStart(message.toolCallId, message.toolName, {}, true);
			this.setToolResult(message.toolCallId, message, false);
		}
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
					? new AssistantMessageComponent(/** @type {import("@earendil-works/pi-ai").AssistantMessage} */ (assistant), this.hideThinking, getMarkdownTheme(), undefined, 1)
					: null;
			}
			case "pi.tool-result":
				return null; // rendered by the tool component that owns the call
			case "pi.system":
				return null;
			case "pi.reset":
				return new ThemedText(() => dim("── new context ──"), 0, 1);
			case "pi.compaction":
				return new ThemedText(() => dim("── context compacted ──"), 0, 1);
			default:
				return new ThemedText(() => dim(`── ${entry.kind} ──`), 0, 1);
		}
	}
}

/** The nested contract carries structuredOutput, not a transcript ToolResultMessage. */
/** @param {any} result */
function nestedToolResult(result) {
	const value = result.structuredOutput;
	const content = typeof value === "string" ? [{ type: "text", text: value }]
		: Array.isArray(value) && value.every(item => item?.type === "text" || item?.type === "image") ? [...value]
		: value?.type === "image" ? [value]
		: value === undefined ? [] : [{ type: "text", text: JSON.stringify(value) }];
	for (const diagnostic of result.diagnostics ?? []) content.push({ type: "text", text: `[${diagnostic.severity}] ${diagnostic.message}` });
	return { content, details: result.details, isError: result.isError, durationMs: result.durationMs };
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
	return activeTheme().fg("muted", text);
}
