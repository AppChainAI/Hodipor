import { join } from "node:path";
import process from "node:process";
import { CustomEditor, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Container,
	KeybindingsManager,
	Text,
	TUI_KEYBINDINGS,
	TuiMainScreen,
	ProcessTerminal,
} from "@earendil-works/pi-tui";
import { attachTranscript } from "./transcript.mjs";
import { commandList, runCommand } from "./commands.mjs";
import { RUN_CONTEXT } from "../runtime.mjs";
import { nextSessionId, openSession } from "../session.mjs";
import { TodoDoc, formatTodoSummary, renderTodoPanel } from "../../extensions/todo/index.mjs";

/** App-level defaults CustomEditor matches beyond the TUI's own editor keys. */
const APP_KEYS = {
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
};

/** @returns {{ fg?: (token: string, text: string) => string }} */
function activeTheme() {
	const globals = /** @type {Record<symbol, { fg?: (token: string, text: string) => string }>} */ (globalThis);
	return globals[Symbol.for("@earendil-works/pi-coding-agent:theme")] ?? {};
}

/**
 * @typedef {Object} TuiArgs
 * @property {import("@earendil-works/pi-durable").Harness} TuiArgs.harness
 * @property {import("@earendil-works/pi-durable").Conversation} TuiArgs.root
 * @property {import("@earendil-works/pi-ai").Models} TuiArgs.models
 * @property {{ home: string; cwd: string; agentDir: string; sessionsDir: string }} TuiArgs.paths
 * @property {string} TuiArgs.sessionId
 * @property {{ print?: boolean; model?: string; cwd?: string; prompt?: string }} TuiArgs.options
 * @property {() => void} TuiArgs.releaseLock
 */

/** @typedef {{ model?: { provider: string; modelId: string }; thinkingLevel?: string }} AgentCache */

/**
 * The Siftory TUI: layout, focus, input, and command assembly. Conversation and
 * todo state live in durable; this function holds display state only.
 * @param {TuiArgs} args
 */
export async function runTui({ harness, root, models, paths, sessionId, options, releaseLock }) {
	initTheme();
	const keybindings = new KeybindingsManager(
		/** @type {import("@earendil-works/pi-tui").KeybindingDefinitions} */ ({ ...TUI_KEYBINDINGS, ...APP_KEYS }),
	);

	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal, false, join(paths.home, "logs"));

	const transcriptContainer = new Container();
	const statusContainer = new Container();
	const widgetContainer = new Container();
	const editorContainer = new Container();
	const footerContainer = new Container();

	const statusLine = new Text("", 1, 0);
	statusContainer.addChild(statusLine);
	const footer = new Text("", 1, 0);
	footerContainer.addChild(footer);

	const theme = activeTheme();
	const editor = new CustomEditor(
		tui,
		{ borderColor: (text) => theme.fg?.("borderMuted", text) ?? text, selectList: getSelectListTheme() },
		/** @type {import("@earendil-works/pi-coding-agent").KeybindingsManager} */ (/** @type {unknown} */ (keybindings)),
	);
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			commandList().map((c) => ({ name: `/${c.name}`, description: c.description })),
			paths.cwd,
		),
	);
	editorContainer.addChild(editor);

	/** @type {{ current: import("@earendil-works/pi-durable").Conversation; busy: boolean; agent: AgentCache; usage: { models?: Record<string, { totalTokens?: number }> } | undefined; exiting: boolean; restartRequest: { newSession?: boolean; pickSession?: boolean | string } | undefined; overlay: import("@earendil-works/pi-tui").OverlayHandle | undefined }} */
	const state = {
		current: root,
		busy: false,
		agent: {},
		usage: undefined,
		exiting: false,
		restartRequest: undefined,
		overlay: undefined,
	};

	const app = {
		harness,
		models,
		paths,
		tui,
		editor,
		context: RUN_CONTEXT,
		/** @returns {import("@earendil-works/pi-durable").Conversation} */
		conversation: () => state.current,
		currentModel: () => {
			const model = state.agent.model;
			return model ? /** @type {any} */ (models).getModel?.(model.provider, model.modelId) : undefined;
		},
		requestExit: () => {
			state.exiting = true;
		},
		/** @param {{ newSession?: boolean; pickSession?: boolean | string }} request */
		restart: async (request) => {
			state.restartRequest = request;
			state.exiting = true;
		},
		/** @param {string} message @param {"error" | "success" | "info"} [kind] */
		notify: (message, kind) => notify(message, kind),
		refreshStatus: () => updateFooter(),
		/** @param {import("@earendil-works/pi-tui").Component} component */
		swapEditor: (component) => {
			editorContainer.clear();
			editorContainer.addChild(component);
			tui.setFocus(component);
			tui.requestRender();
		},
		restoreEditor: () => {
			editorContainer.clear();
			editorContainer.addChild(editor);
			tui.setFocus(editor);
			tui.requestRender();
		},
		/** @param {import("@earendil-works/pi-tui").Component} component */
		showOverlay: (component) => {
			state.overlay = tui.showOverlay(component, { anchor: "center", width: "60%" });
			tui.setFocus(component);
			tui.requestRender();
		},
		closeOverlay: () => {
			state.overlay?.hide();
			state.overlay = undefined;
			tui.setFocus(editor);
			tui.requestRender();
		},
		/** @param {import("@earendil-works/pi-durable").Conversation} conversation */
		switchConversation: async (conversation) => {
			state.current = conversation;
			state.agent = {};
			state.usage = undefined;
			await rebindTranscript();
		},
		showTodos: async () => {
			const todo = await harness.snapshot(TodoDoc, state.current.id, RUN_CONTEXT);
			appendTranscriptText(formatTodoSummary(todo ?? { tasks: [], nextId: 1 }));
		},
	};

	const timers = /** @type {{ status?: ReturnType<typeof setTimeout> }} */ ({});
	/** @type {{ transcript?: { detach(): Promise<unknown> }; todoWatch?: { stop(): Promise<unknown> } }} */
	const handles = {};

	/** @param {string} message @param {"error" | "success" | "info"} [kind] */
	function notify(message, kind) {
		const t = activeTheme();
		const color = kind === "error" ? "error" : kind === "success" ? "success" : "muted";
		statusLine.setText(t.fg ? t.fg(color, message) : message);
		if (timers.status) clearTimeout(timers.status);
		if (kind !== "error") timers.status = setTimeout(() => statusLine.setText(""), 4000);
		tui.requestRender();
	}

	function updateFooter() {
		const parts = [];
		const model = state.agent.model;
		if (model) parts.push(`${model.provider}/${model.modelId}`);
		if (state.agent.thinkingLevel) parts.push(String(state.agent.thinkingLevel));
		parts.push(sessionId);
		if (state.usage) {
			const total = Object.values(state.usage.models ?? {}).reduce((sum, usage) => sum + Number(usage.totalTokens ?? 0), 0);
			if (total > 0) parts.push(`${formatTokens(total)} tok`);
		}
		if (state.busy) parts.push("working… esc to abort");
		footer.setText(parts.join("  ·  "));
		tui.requestRender();
	}

	async function rebindTranscript() {
		await handles.transcript?.detach();
		transcriptContainer.clear();
		await rebindTodo();
		handles.transcript = await attachTranscript({
			harness,
			conversationId: /** @type {any} */ (state.current.id),
			container: transcriptContainer,
			tui,
			onBusyChange: (busy) => {
				state.busy = busy;
				updateFooter();
			},
			onSnapshotMeta: (snapshot) => {
				state.agent = snapshot.agent ?? {};
				state.usage = snapshot.usage;
				updateFooter();
			},
		});
		updateFooter();
	}

	async function rebindTodo() {
		await handles.todoWatch?.stop().catch(() => {});
		const watch = await harness.watchDoc(TodoDoc, state.current.id, RUN_CONTEXT);
		handles.todoWatch = watch;
		if (!watch) return;
		/** @param {{ tasks: { status: string; subject: string; activeForm?: string }[]; nextId: number } | null} value */
		const paint = (value) => {
			const lines = value ? renderTodoPanel(value) : [];
			todoPanel.setText(lines.join("\n"));
			tui.requestRender();
		};
		paint(watch.value);
		watch.start(async (value) => {
			paint(value);
		});
	}

	const todoPanel = new Text("", 1, 0);
	widgetContainer.addChild(todoPanel);

	/** Append a read-only text block to the transcript (for /todos and similar). */
	/** @param {string} text */
	function appendTranscriptText(text) {
		transcriptContainer.addChild(new Text(text, 1, 0));
		tui.requestRender();
	}

	editor.onSubmit = async (text) => {
		const value = text.trim();
		if (!value) return;
		if (value.startsWith("/")) {
			const handled = await runCommand(app, value.slice(1));
			if (!handled) notify(`unknown command: ${value.split(/\s+/)[0]}`, "error");
			return;
		}
		try {
			const { expandSkillInvocation, expandPromptTemplate, listSkills } = await import("../resources.mjs");
			const template = await expandPromptTemplate(paths.agentDir, value);
			const content = template ?? (await expandSkillInvocation(listSkills({ cwd: paths.cwd, agentDir: paths.agentDir }), value));
			await state.current.submit({ type: "input", content }, RUN_CONTEXT);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
	};
	editor.onEscape = () => {
		if (state.busy) state.current.abort(RUN_CONTEXT).catch((error) => notify(String(error), "error"));
	};
	editor.onCtrlD = () => {
		if (!state.busy && editor.getText() === "") state.exiting = true;
	};
	// Todo shortcut: Ctrl+T (or "t" on an empty editor) shows the todo list.
	editor.onExtensionShortcut = (data) => {
		if (data === "\x14" || (data === "t" && editor.getText() === "")) {
			app.showTodos();
			return true;
		}
		return false;
	};
	const onSigint = () => {
		if (state.busy) state.current.abort(RUN_CONTEXT).catch(() => {});
		else state.exiting = true;
	};
	process.on("SIGINT", onSigint);

	tui.addChild(transcriptContainer);
	tui.addChild(statusContainer);
	tui.addChild(widgetContainer);
	tui.addChild(editorContainer);
	tui.addChild(footerContainer);
	tui.start();
	tui.setFocus(editor);
	await rebindTranscript();
	tui.requestRender();

	await /** @type {Promise<void>} */ (new Promise((resolve) => {
		const check = setInterval(() => {
			if (state.exiting) {
				clearInterval(check);
				resolve();
			}
		}, 100);
	}));

	process.off("SIGINT", onSigint);
	await handles.transcript?.detach();
	await handles.todoWatch?.stop().catch(() => {});
	state.overlay?.hide();
	tui.stop();

	if (state.restartRequest) {
		const targetId = nextSessionId(paths.sessionsDir, state.restartRequest);
		releaseLock();
		return openSession({ home: paths.home, sessionId: targetId, models, options, pickModel: () => Promise.resolve(undefined) });
	}
	return 0;
}

/** @param {number} total */
function formatTokens(total) {
	if (total >= 1000000) return `${(total / 1000000).toFixed(1)}M`;
	if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
	return String(total);
}
