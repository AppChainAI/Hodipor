import { join } from "node:path";
import process from "node:process";
import { CustomEditor, getSelectListTheme, initTheme, rawKeyHint } from "@earendil-works/pi-coding-agent";
import {
	Container,
	KeybindingsManager,
	Key,
	matchesKey,
	Text,
	TUI_KEYBINDINGS,
	getKeybindings,
	setKeybindings,
	TuiMainScreen,
	ProcessTerminal,
} from "@earendil-works/pi-tui";
import { attachTranscript } from "./transcript.mjs";
import { createEditorSlot } from "./editor-slot.mjs";
import { activeTheme, createThemeController } from "./theme.mjs";
import { createCommandAutocomplete, handleInput, runCommand } from "./commands.mjs";
import { RUN_CONTEXT } from "../runtime.mjs";
import { nextSessionId } from "../session.mjs";
import { TodoDoc, formatTodoSummary } from "../../extensions/todo/index.mjs";
import { TodoPanel } from "../../extensions/todo/ui.mjs";
import { RunStatus } from "./run-status.mjs";
import { SiftoryFooter, contextDisplayStats } from "./footer.mjs";
import { ThemedText } from "./pi-display.mjs";

/** App-level defaults CustomEditor matches beyond the TUI's own editor keys. */
const APP_KEYS = {
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand or collapse tool details" },
};

/**
 * @typedef {Object} TuiArgs
 * @property {import("@earendil-works/pi-durable").Harness} TuiArgs.harness
 * @property {import("@earendil-works/pi-durable").Conversation} TuiArgs.root
 * @property {import("@earendil-works/pi-ai").Models} TuiArgs.models
 * @property {{ home: string; cwd: string; agentDir: string; sessionsDir: string }} TuiArgs.paths
 * @property {string} TuiArgs.sessionId
 * @property {{ print?: boolean; model?: string; cwd?: string; prompt?: string }} TuiArgs.options
 */

/** @typedef {{ model?: { provider: string; modelId: string }; thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel; cwd?: string }} AgentCache */

/**
 * The Siftory TUI: layout, focus, input, and command assembly. Conversation and
 * todo state live in durable; this function holds display state only.
 * @param {TuiArgs} args
 */
export async function runTui({ harness, root, models, paths, sessionId, options }) {
	initTheme();
	const keybindings = new KeybindingsManager(
		/** @type {import("@earendil-works/pi-tui").KeybindingDefinitions} */ ({ ...TUI_KEYBINDINGS, ...APP_KEYS, "tui.select.cancel": { defaultKeys: "escape", description: "Cancel selection" } }),
	);

	const previousKeybindings = getKeybindings();
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal, false, join(paths.home, "logs"));

	const header = new ThemedText(() => {
		const theme = activeTheme();
		const hints = toolsExpanded
			? [["esc", "to interrupt"], ["ctrl+c", "to exit"], ["ctrl+d", "to exit (empty editor)"], ["/", "for commands"], ["ctrl+o", "to expand tools and todos"], ["ctrl+t", "to expand thinking"], ["ctrl+shift+t", "to collapse todos"]].map(([key, description]) => rawKeyHint(key, description)).join("\n")
			: [["esc", "interrupt"], ["ctrl+c", "exit"], ["/", "commands"], ["ctrl+o", "more"]].map(([key, description]) => rawKeyHint(key, description)).join(theme.fg("muted", " · "));
		return `${theme.fg("accent", theme.bold("Siftory"))}\n${hints}`;
	}, 1, 1);
	const transcriptContainer = new Container();
	const statusContainer = new Container();
	const widgetContainer = new Container();
	const editorContainer = new Container();
	const footerContainer = new Container();
	const workingContainer = new Container();

	const statusLine = new Text("", 1, 0);
	statusContainer.addChild(statusLine);
	const footer = new SiftoryFooter(() => {
		const model = state.agent.model;
		const definition = model ? models.getModel(model.provider, model.modelId) : undefined;
		return { cwd: state.agent.cwd ?? paths.cwd, sessionId, usage: state.usage, thinkingLevel: state.agent.thinkingLevel,
			...contextStats, model: model ? { id: model.modelId, provider: model.provider, reasoning: definition?.reasoning, contextWindow: definition?.contextWindow } : undefined };
	});
	footerContainer.addChild(footer);
	const editor = new CustomEditor(
		tui,
		{ borderColor: (text) => activeTheme().getThinkingBorderColor(state.agent.thinkingLevel ?? "off")(text), selectList: getSelectListTheme() },
		/** @type {import("@earendil-works/pi-coding-agent").KeybindingsManager} */ (/** @type {unknown} */ (keybindings)),
		{ embedWorkingStatus: true },
	);
	editor.setAutocompleteProvider(createCommandAutocomplete(paths.cwd));
	editorContainer.addChild(editor);

	/** @type {{ current: import("@earendil-works/pi-durable").Conversation; busy: boolean; agent: AgentCache; usage: import("@earendil-works/pi-durable").UsageState | undefined; exiting: boolean; restartRequest: { newSession?: boolean; pickSession?: boolean | string } | undefined }} */
	const state = {
		current: root,
		busy: false,
		agent: {},
		usage: undefined,
		exiting: false,
		restartRequest: undefined,
	};

	// The terminal can receive commands before the first transcript frame arrives.
	state.agent = await root.agent(RUN_CONTEXT);
	let toolsExpanded = false;
	let hideThinking = false;
	/** @type {import("./run-status.mjs").Activity | undefined} */
	let activity;
	let contextRead = 0;
	/** @type {{ contextTokens: number | null; cacheHitRate?: number }} */
	let contextStats = { contextTokens: null };
	/** @type {{ message: string; kind?: "error" | "success" | "info" } | undefined} */
	let notification;
	const runStatus = new RunStatus(tui, editor, workingContainer);
	const editorSlot = createEditorSlot(tui, editorContainer, editor, active => runStatus.setEmbedded(active === editor));
	const app = {
		harness,
		models,
		paths,
		sessionId,
		tui,
		editor,
		context: RUN_CONTEXT,
		themes: {
			names: () => themeController.names(),
			selection: () => themeController.selection(),
			set: (/** @type {string} */ name) => themeController.set(name),
		},
		/** @returns {import("@earendil-works/pi-durable").Conversation} */
		conversation: () => state.current,
		currentModel: () => {
			const model = state.agent.model;
			return model ? /** @type {any} */ (models).getModel?.(model.provider, model.modelId) : undefined;
		},
		requestExit: () => {
			if (state.exiting) return;
			state.exiting = true;
			editorSlot.cancel();
		},
		/** @param {{ newSession?: boolean; pickSession?: boolean | string }} request */
		restart: async (request) => {
			if (typeof request.pickSession === "string") nextSessionId(paths.sessionsDir, request);
			state.restartRequest = request;
			state.exiting = true;
		},
		/** @param {string} message @param {"error" | "success" | "info"} [kind] */
		notify: (message, kind) => notify(message, kind),
		refreshStatus: () => updateFooter(),
		swapEditor: editorSlot.show,
		restoreEditor: editorSlot.restore,
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

	const timers = /** @type {{ status?: ReturnType<typeof setTimeout>; footer?: ReturnType<typeof setTimeout> }} */ ({});
	/** @type {{ transcript?: { detach(): Promise<unknown>; setToolsExpanded(value: boolean): void; setHideThinking(value: boolean): void };  todoWatch?: { stop(): Promise<unknown> } }} */
	const handles = {};

	/** @param {string} message @param {"error" | "success" | "info"} [kind] */
	function notify(message, kind) {
		if (state.exiting) return;
		notification = { message, kind };
		paintStatus();
		if (timers.status) clearTimeout(timers.status);
		if (kind !== "error") timers.status = setTimeout(() => {
			notification = undefined;
			paintStatus();
			tui.requestRender();
		}, 4000);
		tui.requestRender();
	}

	function paintStatus() {
		const color = notification?.kind === "error" ? "error" : notification?.kind === "success" ? "success" : "muted";
		statusLine.setText(notification ? activeTheme().fg(color, notification.message) : "");
	}

	function updateFooter() {
		runStatus.invalidate();
		footer.invalidate();
		tui.requestRender();
	}

	function refreshContextStats() {
		if (timers.footer) clearTimeout(timers.footer);
		const sequence = ++contextRead;
		const conversation = state.current;
		timers.footer = setTimeout(async () => {
			try {
				const context = await conversation.context(RUN_CONTEXT);
				if (state.exiting || sequence !== contextRead || conversation !== state.current) return;
				contextStats = contextDisplayStats(context);
				updateFooter();
			} catch (error) {
				if (!state.exiting && sequence === contextRead) {
					contextStats = { contextTokens: null };
					notify(`context display: ${String(error)}`, "error");
				}
			}
		}, 0);
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
			expandedTools: toolsExpanded,
			hideThinking,
			getTodos: () => todoPanel.state,
			onActivityChange: next => { activity = next; runStatus.set(next); },
			onEvent: event => {
				if (event.type === "run_start") todoPanel.hideCompletedTasksFromPreviousTurn();
				if (event.type === "snapshot" || (event.type === "entry_appended" && event.entry.kind === "pi.compaction")) todoPanel.resetCompletedDisplayState();
				if (["entry_appended", "message_end", "run_end"].includes(event.type)) refreshContextStats();
			},
			onBusyChange: (busy) => {
				state.busy = busy;
				terminal.setProgress(busy);
				terminal.setProgramStatus({ state: busy ? "working" : "idle", app: "siftory" });
				updateFooter();
			},
			onSnapshotMeta: (snapshot) => {
				state.agent = snapshot.agent ?? {};
				state.usage = snapshot.usage;
				refreshContextStats();
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
			todoPanel.setState(value ?? { tasks: [] });
			tui.requestRender();
		};
		paint(watch.value);
		watch.start(async (value) => {
			paint(value);
		});
	}

	const todoPanel = new TodoPanel(activeTheme);
	widgetContainer.addChild(todoPanel);
	const themeController = createThemeController(tui, {
		cwd: paths.cwd, agentDir: paths.agentDir,
		onError: (message) => notify(message, "error"),
		onChanged: () => { tui.invalidate(); paintStatus(); updateFooter(); },
	});

	/** Append a read-only text block to the transcript (for /todos and similar). */
	/** @param {string} text */
	function appendTranscriptText(text) {
		transcriptContainer.addChild(new ThemedText(() => activeTheme().fg("text", text), 1, 0));
		tui.requestRender();
	}

	editor.onSubmit = (text) => handleInput(app, text);
	editor.onEscape = () => {
		if (!state.busy) return;
		const pending = [state.current.abort(RUN_CONTEXT)];
		if (activity?.kind === "compaction" && activity.taskId !== undefined) pending.push(harness.abortTask(activity.taskId, RUN_CONTEXT).then(() => {}));
		Promise.all(pending).catch(error => notify(String(error), "error"));
	};
	editor.onCtrlD = () => {
		if (!state.busy && editor.getText() === "") state.exiting = true;
	};
	// Display-only folds never mutate the committed conversation or todo document.
	editor.onExtensionShortcut = (data) => {
		if (matchesKey(data, Key.ctrl("o"))) {
			toolsExpanded = !toolsExpanded;
			header.invalidate();
			handles.transcript?.setToolsExpanded(toolsExpanded);
			todoPanel.setToolsExpanded(toolsExpanded);
			tui.requestRender(true);
			return true;
		}
		if (matchesKey(data, "ctrl+shift+t")) {
			todoPanel.toggle();
			tui.requestRender(true);
			return true;
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			hideThinking = !hideThinking;
			handles.transcript?.setHideThinking(hideThinking);
			return true;
		}
		return false;
	};
	const onSigint = () => app.requestExit();
	// Raw-mode Ctrl+C is input, not SIGINT; intercept before any focused dialog.
	const removeInputListener = tui.addInputListener((data) => {
		if (state.exiting) return { consume: true };
		if (!matchesKey(data, Key.ctrl("c"))) return;
		app.requestExit();
		return { consume: true };
	});
	process.on("SIGINT", onSigint);

	tui.addChild(header);
	tui.addChild(transcriptContainer);
	tui.addChild(statusContainer);
	tui.addChild(widgetContainer);
	tui.addChild(workingContainer);
	tui.addChild(editorContainer);
	tui.addChild(footerContainer);
	try {
		setKeybindings(keybindings);
		tui.start();
		tui.setFocus(editor);
		await themeController.start();
		await rebindTranscript();
		// First run: no model configured and no explicit prompt. Jump straight into
		// model selection when credentials already exist, else into provider login.
		if (!state.agent.model && !options.prompt?.trim()) {
			const available = await models.getAvailable().catch(() => /** @type {readonly unknown[]} */ ([]));
			notify(available.length > 0 ? "no model selected — pick one to get started" : "set up a provider to get started", "info");
			void runCommand(app, available.length > 0 ? "model" : "login");
		}
		if (options.prompt?.trim()) void handleInput(app, options.prompt);
		tui.requestRender();

		await /** @type {Promise<void>} */ (new Promise((resolve) => {
			const check = setInterval(() => {
				if (state.exiting) {
					clearInterval(check);
					resolve();
				}
			}, 100);
		}));

	} finally {
		process.off("SIGINT", onSigint);
		if (timers.status) clearTimeout(timers.status);
		if (timers.footer) clearTimeout(timers.footer);
		contextRead++;
		await handles.transcript?.detach();
		await handles.todoWatch?.stop().catch(() => {});
		editorSlot.dispose();
		runStatus.dispose();
		themeController.dispose();
		await terminal.drainInput(1000);
		removeInputListener();
		tui.stop();
		// Keep the current origin: absolute home can paint behind Warp's pinned command header.
		if (state.restartRequest) terminal.write("\x1b[2J");
		setKeybindings(previousKeybindings);
	}
	return state.restartRequest ?? 0;
}
