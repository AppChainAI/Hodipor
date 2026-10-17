import { LoginDialogComponent, ModelSelectorComponent, ThinkingSelectorComponent } from "@earendil-works/pi-coding-agent";

/**
 * The TUI app surface commands use; the real object is assembled in app.mjs.
 * @typedef {Object} TuiApp
 * @property {import("@earendil-works/pi-durable").Harness} harness
 * @property {any} models
 * @property {{ home: string; cwd: string; agentDir: string; sessionsDir: string }} paths
 * @property {import("@earendil-works/pi-tui").TUI} tui
 * @property {any} editor
 * @property {any} context
 * @property {() => import("@earendil-works/pi-durable").Conversation} conversation
 * @property {() => any} currentModel
 * @property {() => void} requestExit
 * @property {(request: { newSession?: boolean; pickSession?: boolean | string }) => Promise<void>} restart
 * @property {(message: string, kind?: "error" | "success" | "info") => void} notify
 * @property {() => void} refreshStatus
 * @property {(component: import("@earendil-works/pi-tui").Component) => void} swapEditor
 * @property {() => void} restoreEditor
 * @property {(component: import("@earendil-works/pi-tui").Component) => void} showOverlay
 * @property {(...args: any[]) => void} closeOverlay
 * @property {(conversation: import("@earendil-works/pi-durable").Conversation) => Promise<void>} switchConversation
 * @property {() => Promise<void>} showTodos
 */

/** Slash commands the Siftory host registers (the durable runtime has none of its own). */
export function commandList() {
	return [
		{ name: "help", description: "Show commands" },
		{ name: "login", description: "Log in to a provider", argumentHint: "[provider]" },
		{ name: "logout", description: "Log out of a provider", argumentHint: "<provider>" },
		{ name: "model", description: "Select model" },
		{ name: "thinking", description: "Select thinking level" },
		{ name: "new", description: "Start a new session (fresh storage)" },
		{ name: "resume", description: "List sessions and resume one", argumentHint: "[id]" },
		{ name: "fork", description: "Fork the conversation at its latest entry" },
		{ name: "compact", description: "Compact the conversation context", argumentHint: "[instructions]" },
		{ name: "reset", description: "Start a new context, optionally with handoff text", argumentHint: "[handoff]" },
		{ name: "todos", description: "Show the todo panel" },
		{ name: "exit", description: "Exit Siftory" },
	];
}

/** @param {TuiApp} app @param {string} line */
export async function runCommand(app, line) {
	const trimmed = line.trim();
	const [name, ...rest] = trimmed.split(/\s+/);
	const argument = rest.join(" ");
	switch (name) {
		case "help":
			app.notify(commandList().map((c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}`).join("\n"));
			return true;
		case "login":
			await commandLogin(app, argument);
			return true;
		case "logout":
			await commandLogout(app, argument);
			return true;
		case "model":
			await commandModel(app, argument);
			return true;
		case "thinking":
			await commandThinking(app);
			return true;
		case "new":
			await app.restart({ newSession: true });
			return true;
		case "resume":
			await app.restart({ pickSession: argument || true });
			return true;
		case "fork":
			await commandFork(app);
			return true;
		case "compact":
			await app.conversation().compact(argument || undefined, app.context);
			app.notify("compacting…");
			return true;
		case "reset":
			await app.conversation().reset(argument || undefined, app.context);
			return true;
		case "todos":
			app.showTodos();
			return true;
		case "exit":
		case "quit":
			app.requestExit();
			return true;
		default:
			return false;
	}
}

/** @param {TuiApp} app @param {string} providerId */
async function commandLogin(app, providerId) {
	const runtime = app.models;
	if (typeof runtime?.login !== "function") {
		app.notify("login requires the model runtime", "error");
		return;
	}
	if (!providerId) {
		const providers = /** @type {{ id: string; auth?: unknown }[]} */ (runtime.getProviders()).filter((p) => p.auth);
		if (providers.length === 0) {
			app.notify("no login-capable providers registered");
			return;
		}
		// One configured provider skips the pick; otherwise list and ask again.
		if (providers.length === 1) return commandLogin(app, providers[0].id);
		void providers;
		app.notify(`providers: ${providers.map((p) => p.id).join(", ")}\n/login <provider>`);
		return;
	}
	const provider = /** @type {{ id: string } | undefined} */ (runtime.getProvider(providerId));
	if (!provider) {
		app.notify(`unknown provider: ${providerId}`, "error");
		return;
	}
	const dialog = new LoginDialogComponent(app.tui, providerId, () => {});
	app.swapEditor(dialog);
	try {
		await runtime.login(providerId, "oauth", {
			signal: dialog.signal,
			prompt: async (/** @type {{ message: string; placeholder?: string }} */ prompt) => dialog.showPrompt(prompt.message, prompt.placeholder),
			notify: (/** @type {any} */ event) => {
				if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
				else if (event.type === "device_code") dialog.showDeviceCode(event);
				else if (event.type === "info") dialog.showInfo(event.message, event.links);
				else dialog.showProgress?.(event.message);
			},
		});
		app.notify(`logged in to ${providerId}`, "success");
	} catch (error) {
		app.notify(`login failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		app.restoreEditor();
	}
}

/** @param {TuiApp} app @param {string} providerId */
async function commandLogout(app, providerId) {
	if (!providerId) {
		app.notify("/logout <provider>");
		return;
	}
	try {
		await app.models.logout(providerId);
		app.notify(`logged out of ${providerId}`);
	} catch (error) {
		app.notify(`logout failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/** @param {TuiApp} app @param {string} argument */
async function commandModel(app, argument) {
	const runtime = app.models;
	if (typeof runtime?.getAvailableSnapshot !== "function" || !(runtime instanceof Object)) {
		if (argument) return applyModelSpec(app, argument);
		app.notify("model selection requires the model runtime; use /model provider/model", "error");
		return;
	}
	if (argument) return applyModelSpec(app, argument);
	const current = app.currentModel();
	const selector = new ModelSelectorComponent(app.tui, current, runtime, [], async (model) => {
		app.closeOverlay(selector);
		await app.conversation().configure({ model: { provider: model.provider, modelId: model.id } }, app.context);
		app.refreshStatus();
	}, () => app.closeOverlay(selector));
	app.showOverlay(selector);
}

/** @param {TuiApp} app @param {string} spec */
async function applyModelSpec(app, spec) {
	const [provider, rest] = spec.split("/");
	if (!provider || !rest) {
		app.notify("usage: /model provider/model[:thinking]", "error");
		return;
	}
	const [modelId, thinkingLevel] = rest.split(":");
	if (!app.models.getModel?.(provider, modelId)) {
		app.notify(`unknown model: ${spec}`, "error");
		return;
	}
	await app.conversation().configure(
		/** @type {any} */ ({ model: { provider, modelId }, ...(thinkingLevel ? { thinkingLevel } : {}) }),
		app.context,
	);
	app.refreshStatus();
}

/** @param {TuiApp} app */
async function commandThinking(app) {
	const levels = /** @type {any[]} */ (["off", "minimal", "low", "medium", "high"]);
	const agent = await app.conversation().agent(app.context);
	const selector = new ThinkingSelectorComponent(agent.thinkingLevel, levels, async (level) => {
		app.closeOverlay(selector);
		await app.conversation().configure({ thinkingLevel: level }, app.context);
		app.refreshStatus();
	}, () => app.closeOverlay(selector));
	app.showOverlay(selector);
}

/** @param {TuiApp} app */
async function commandFork(app) {
	const conversation = app.conversation();
	const page = await conversation.entries({ order: "descending" }, 1, undefined, app.context);
	const at = page.items[0]?.id;
	if (!at) {
		app.notify("nothing to fork from", "error");
		return;
	}
	const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, app.context);
	app.switchConversation(fork);
	app.notify(`forked to a new conversation`);
}
