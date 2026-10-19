import { ExtensionSelectorComponent, LoginDialogComponent, ModelSelectorComponent, OAuthSelectorComponent } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { ChoiceSelector } from "./choice-selector.mjs";
import { listSessions } from "../session.mjs";
import { resolveModelRef } from "../models.mjs";
import { expandSkillInvocation, expandPromptTemplate, listSkills } from "../resources.mjs";

/** @param {string} cwd @returns {import("@earendil-works/pi-tui").AutocompleteProvider} */
export function createCommandAutocomplete(cwd) {
	const provider = new CombinedAutocompleteProvider(commandList(), cwd);
	return {
		async getSuggestions(lines, row, col, options) {
			const suggestions = await provider.getSuggestions(lines, row, col, options);
			// Empty file prefixes after punctuation/whitespace must not hijack Enter in ordinary prompts.
			return !options.force && suggestions?.prefix === "" ? null : suggestions;
		},
		applyCompletion: provider.applyCompletion.bind(provider),
		shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion.bind(provider),
	};
}

/** @param {TuiApp} app @param {string} text */
export async function handleInput(app, text) {
	const value = text.trim();
	if (!value) return;
	try {
		if (value.startsWith("/") && await runCommand(app, value.slice(1))) return;
		const template = await expandPromptTemplate(app.paths.agentDir, value);
		if (value.startsWith("/") && template === undefined && !value.startsWith("/skill:")) {
			app.notify(`unknown command: ${value.split(/\s+/)[0]}`, "error");
			return;
		}
		const content = template ?? await expandSkillInvocation(listSkills(app.paths), value);
		await app.conversation().submit({ type: "input", content }, app.context);
	} catch (error) {
		app.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

/**
 * The TUI app surface commands use; the real object is assembled in app.mjs.
 * @typedef {Object} TuiApp
 * @property {import("@earendil-works/pi-durable").Harness} harness
 * @property {string} sessionId
 * @property {{ names(): string[]; selection(): string; set(name: string): Promise<void> }} themes
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
 * @property {(component: import("@earendil-works/pi-tui").Component, expected?: import("@earendil-works/pi-tui").Component) => void} swapEditor
 * @property {(expected?: import("@earendil-works/pi-tui").Component) => void} restoreEditor
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
		{ name: "theme", description: "Select terminal theme", argumentHint: "[name or light/dark pair]" },
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
	try {
		return await dispatchCommand(app, line);
	} catch (error) {
		app.notify(error instanceof Error ? error.message : String(error), "error");
		return true;
	}
}

/** @param {TuiApp} app @param {string} line */
async function dispatchCommand(app, line) {
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
		case "theme":
			await commandTheme(app, argument);
			return true;
		case "new":
			await app.restart({ newSession: true });
			return true;
		case "resume":
			await commandResume(app, argument);
			return true;
		case "fork":
			await commandFork(app);
			return true;
		case "compact": {
			const taskId = await app.conversation().compact(argument || undefined, app.context);
			app.notify("compacting…");
			const task = await app.harness.waitForTask(taskId, app.context);
			const outcome = task.state.outcome;
			if (outcome.status === "completed") {
				app.notify(outcome.result.entryId !== undefined || outcome.result.submissionId !== undefined ? "context compacted" : "nothing to compact");
			} else {
				app.notify(`compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? outcome.status}`, "error");
			}
			return true;
		}
		case "reset":
			await app.conversation().reset(argument || undefined, app.context);
			return true;
		case "todos":
			await app.showTodos();
			return true;
		case "exit":
		case "quit":
			app.requestExit();
			return true;
		default:
			return false;
	}
}

/** @param {TuiApp} app @param {string} providerId @param {"oauth" | "api_key"} [selectedAuthType] */
async function commandLogin(app, providerId, selectedAuthType) {
	const runtime = app.models;
	if (typeof runtime?.login !== "function") {
		app.notify("login requires the model runtime", "error");
		return;
	}
	if (!providerId) {
		/** @type {ConstructorParameters<typeof OAuthSelectorComponent>[1]} */
		const choices = [];
		for (const provider of runtime.getProviders()) {
			const status = runtime.getProviderAuthStatus?.(provider.id);
			for (const authType of /** @type {("oauth" | "api_key")[]} */ (["oauth", "api_key"])) {
				const method = authType === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
				if (!method || (authType === "api_key" && !method.login)) continue;
				choices.push({
					id: provider.id, name: provider.name ?? provider.id, authType, method,
					subscription: provider.auth?.oauth?.isSubscription === true,
					status: status?.configured ? {
						type: runtime.isUsingOAuth?.(provider.id) ? "oauth" : "api_key",
						source: status.label ?? status.source,
					} : undefined,
				});
			}
		}
		if (choices.length === 0) {
			app.notify("no login-capable providers registered");
			return;
		}
		choices.sort((a, b) => a.name.localeCompare(b.name));
		/** @type {{ id: string; authType: "oauth" | "api_key" } | undefined} */
		const selected = await new Promise((resolve) => {
			const selector = new OAuthSelectorComponent("login", choices,
				(id, authType) => { app.restoreEditor(selector); resolve({ id, authType }); },
				() => { app.restoreEditor(selector); resolve(undefined); });
			app.swapEditor(selector);
		});
		if (selected) await commandLogin(app, selected.id, selected.authType);
		return;
	}
	const provider = /** @type {{ id: string } | undefined} */ (runtime.getProvider(providerId));
	if (!provider) {
		app.notify(`unknown provider: ${providerId}`, "error");
		return;
	}
	const auth = /** @type {any} */ (provider).auth;
	const authType = selectedAuthType ?? (auth?.oauth ? "oauth" : auth?.apiKey?.login ? "api_key" : undefined);
	if (!authType) {
		app.notify(`provider does not support interactive login: ${providerId}`, "error");
		return;
	}
	const dialog = new LoginDialogComponent(app.tui, providerId, () => {});
	app.swapEditor(dialog);
	try {
		await runtime.login(providerId, authType, {
			signal: dialog.signal,
			prompt: (/** @type {import("@earendil-works/pi-ai").AuthPrompt} */ prompt) => showAuthPrompt(app, dialog, prompt),
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
		app.restoreEditor(dialog);
	}
}

/** @param {TuiApp} app @param {LoginDialogComponent} dialog @param {import("@earendil-works/pi-ai").AuthPrompt} prompt */
async function showAuthPrompt(app, dialog, prompt) {
	if (prompt.signal?.aborted) throw new Error("Login cancelled");
	/** @type {ExtensionSelectorComponent | undefined} */
	let selector;
	const response = prompt.type === "select"
		? new Promise((resolve, reject) => {
			selector = new ExtensionSelectorComponent(prompt.message, prompt.options.map((option) => option.label), (label) => {
				const option = prompt.options.find((option) => option.label === label);
				if (option) resolve(option.id);
				else reject(new Error("Login cancelled"));
			}, () => reject(new Error("Login cancelled")));
			app.swapEditor(selector);
		})
		: prompt.type === "manual_code" ? dialog.showManualInput(prompt.message) : dialog.showPrompt(prompt.message, prompt.placeholder);
	/** @type {(() => void) | undefined} */
	let onAbort;
	try {
		if (!prompt.signal) return await response;
		const signal = prompt.signal;
		return await Promise.race([response, new Promise((_, reject) => {
			onAbort = () => reject(new Error("Login cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		})]);
	} finally {
		if (onAbort) prompt.signal?.removeEventListener("abort", onAbort);
		if (selector) app.swapEditor(dialog, selector);
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
		app.restoreEditor(selector);
		try {
			await app.conversation().configure({ model: { provider: model.provider, modelId: model.id } }, app.context);
			app.refreshStatus();
		} catch (error) {
			app.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}, () => app.restoreEditor(selector));
	app.swapEditor(selector);
}

/** @param {TuiApp} app @param {string} spec */
async function applyModelSpec(app, spec) {
	const ref = resolveModelRef(app.models, spec);
	if (!ref) return;
	await app.conversation().configure(/** @type {any} */ ({ model: ref.model, ...(ref.thinkingLevel ? { thinkingLevel: ref.thinkingLevel } : {}) }), app.context);
	app.refreshStatus();
}

/** @param {TuiApp} app */
async function commandThinking(app) {
	const model = app.currentModel();
	const levels = model ? getSupportedThinkingLevels(model) : /** @type {const} */ (["off"]);
	const agent = await app.conversation().agent(app.context);
	const selector = new ChoiceSelector("Thinking Level", levels.map(level => ({ value: level, label: level })), async (level) => {
		app.restoreEditor(selector);
		try {
			await app.conversation().configure({ thinkingLevel: /** @type {import("@earendil-works/pi-ai").ModelThinkingLevel} */ (level) }, app.context);
			app.refreshStatus();
		} catch (error) {
			app.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}, () => app.restoreEditor(selector), agent.thinkingLevel);
	app.swapEditor(selector);
}

/** @param {TuiApp} app @param {string} name */
async function commandTheme(app, name) {
	if (!name) {
		name = await new Promise((resolve) => {
			const selector = new ChoiceSelector("Theme", app.themes.names().map(value => ({ value, label: value })),
				value => { app.restoreEditor(selector); resolve(value); },
				() => { app.restoreEditor(selector); resolve(""); }, app.themes.selection());
			app.swapEditor(selector);
		});
	}
	if (name) {
		await app.themes.set(name);
		app.notify(`theme: ${name}`, "success");
	}
}

/** @param {TuiApp} app @param {string} id */
async function commandResume(app, id) {
	if (id) return app.restart({ pickSession: id });
	const ids = listSessions(app.paths.sessionsDir);
	if (ids.length === 0) {
		app.notify("no sessions to resume");
		return;
	}
	/** @type {string | undefined} */
	const selected = await new Promise((resolve) => {
		const selector = new ChoiceSelector("Resume session", ids.map(value => ({ value, label: value, description: value === app.sessionId ? "current" : undefined })),
			value => { app.restoreEditor(selector); resolve(value); },
			() => { app.restoreEditor(selector); resolve(undefined); }, app.sessionId);
		app.swapEditor(selector);
	});
	if (selected && selected !== app.sessionId) await app.restart({ pickSession: selected });
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
	await app.switchConversation(fork);
	app.notify(`forked to a new conversation`);
}
