import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCommandAutocomplete, handleInput, runCommand } from "../src/tui/commands.mjs";
import { resolveModelRef } from "../src/models.mjs";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme();

test("ordinary text ending in Chinese punctuation cannot silently complete a filename", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "hodipor-completion-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "llm-intro.md"), "fixture");
	const provider = createCommandAutocomplete(cwd);
	for (const line of ["请只回复完成。", "hello "]) {
		assert.equal(await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal }), null);
	}
	const line = "./llm";
	const forced = await provider.getSuggestions([line], 0, line.length, { force: true, signal: new AbortController().signal });
	assert(forced.items.some(item => item.value.endsWith("llm-intro.md")));
});

test("input dispatch reaches skill bodies and templates, reports missing commands", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "hodipor-input-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, "skills", "demo"), { recursive: true });
	await mkdir(join(home, "prompts"));
	await writeFile(join(home, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\nSKILL_BODY\n");
	await writeFile(join(home, "prompts", "brief.md"), "Template $ARGUMENTS");
	const submitted = [], notices = [];
	const app = {
		paths: { agentDir: home, cwd: home },
		conversation: () => ({ submit: async (input) => submitted.push(input.content) }),
		notify: (text) => notices.push(text),
	};
	await handleInput(app, "/skill:demo question");
	await handleInput(app, "/brief subject");
	await handleInput(app, "/missing");
	await handleInput(app, "/skill:missing");
	assert.match(submitted[0], /SKILL_BODY[\s\S]*question/);
	assert.equal(submitted[1], "Template subject");
	assert.equal(submitted.length, 2);
	assert.match(notices[0], /unknown command/);
	assert.match(notices[1], /unknown skill/);
});

test("login picker searches providers and preserves the selected authentication method", async () => {
	const providers = [
		{ id: "a-provider", name: "A Provider", auth: { apiKey: { login() {} } } },
		{ id: "z-provider", name: "Z Provider", auth: { oauth: {}, apiKey: { login() {} } } },
	];
	const calls = [];
	let restores = 0;
	const app = {
		models: {
			getProviders: () => providers,
			getProvider: (id) => providers.find(p => p.id === id),
			login: async (id, type) => calls.push([id, type]),
		},
		tui: { requestRender() {} },
		swapEditor(component) {
			if (component.constructor.name !== "OAuthSelectorComponent") return;
			assert.match(component.render(100).join("\n"), /Select provider/);
			component.handleInput("z-provider");
			component.handleInput("\x1b[B"); // OAuth and API key are separate selectable rows.
			component.handleInput("\r");
		},
		restoreEditor() { restores++; }, notify() {},
	};
	await runCommand(app, "login");
	assert.deepEqual(calls, [["z-provider", "api_key"]]);
	assert.equal(restores, 2);
});

test("escaping the provider picker restores the editor without starting login", async () => {
	let restored = false;
	const app = {
		models: {
			getProviders: () => [{ id: "provider", auth: { oauth: {} } }],
			login: async () => assert.fail("cancel must not start authentication"),
		},
		swapEditor(component) { component.handleInput("\x1b"); },
		restoreEditor() { restored = true; },
		notify: (text) => assert.fail(text),
	};
	assert.equal(await runCommand(app, "login"), true);
	assert.ok(restored);
});

test("login uses API-key authentication for an API-key-only provider", async () => {
	const calls = [];
	const notices = [];
	const app = {
		models: {
			getProvider: () => ({ id: "key-provider", auth: { apiKey: { login() {} } } }),
			login: async (id, type) => calls.push([id, type]),
		},
		tui: { requestRender() {} }, swapEditor() {}, restoreEditor() {},
		notify: (text) => notices.push(text),
	};
	await runCommand(app, "login key-provider");
	assert.deepEqual(calls, [["key-provider", "api_key"]]);
	assert.match(notices[0], /logged in/);
});

test("login selection returns option IDs and per-prompt abort cancels a pending prompt", async () => {
	const notices = [];
	const controller = new AbortController();
	const app = {
		models: {
			getProvider: () => ({ id: "oauth-provider", auth: { oauth: {} } }),
			login: async (_, type, interaction) => {
				assert.equal(type, "oauth");
				const answer = await interaction.prompt({ type: "select", message: "Choose", options: [{ id: "choice-id", label: "Choice label" }] });
				assert.equal(answer, "choice-id");
				queueMicrotask(() => controller.abort());
				await interaction.prompt({ type: "text", message: "Waiting", signal: controller.signal });
			},
		},
		tui: { requestRender() {} },
		swapEditor(component) { if (component.constructor.name === "ExtensionSelectorComponent") component.handleInput("\r"); },
		restoreEditor() {}, notify: (text) => notices.push(text),
	};
	await runCommand(app, "login oauth-provider");
	assert.match(notices.at(-1), /Login cancelled/);
});

test("compact reports completion, no-op and failure instead of leaving a start-only status", async () => {
	for (const [outcome, expected] of [
		[{ status: "completed", result: {} }, "nothing to compact"],
		[{ status: "completed", result: { submissionId: 1 } }, "context compacted"],
		[{ status: "failed", error: { message: "summary failed" } }, "compaction failed: summary failed"],
	]) {
		const messages = [];
		const app = {
			conversation: () => ({ compact: async () => 1 }),
			harness: { waitForTask: async () => ({ state: { outcome } }) },
			notify: (text) => messages.push(text),
		};
		assert.equal(await runCommand(app, "compact"), true);
		assert.deepEqual(messages, ["compacting…", expected]);
	}
});

// Exercise Pi's actual completion contract, not a hand-built completed string.
test("slash completion adds exactly one slash and dispatches login", async () => {
	const provider = createCommandAutocomplete(process.cwd());
	const suggestions = await provider.getSuggestions(["/"], 0, 1, {});
	const login = suggestions.items.find((item) => item.value === "login");
	assert.ok(login);
	const completed = provider.applyCompletion(["/"], 0, 1, login, suggestions.prefix).lines[0];
	assert.equal(completed.trim(), "/login");
	const notices = [];
	assert.equal(await runCommand({ models: {}, notify: (text) => notices.push(text) }, completed.slice(1)), true);
	assert.match(notices[0], /login requires/);
});

test("model references preserve slashes and keep thinking outside the model reference", () => {
	const models = { getModel: (provider, id) => provider === "router" && id === "vendor/model" ? {} : undefined };
	assert.deepEqual(resolveModelRef(models, "router/vendor/model:high"), {
		model: { provider: "router", modelId: "vendor/model" }, thinkingLevel: "high", modelName: "router/vendor/model",
	});
	assert.throws(() => resolveModelRef(models, "router/vendor/model:bogus"), /thinking/);
});

test("model command handles slash-containing IDs and reports configuration failures", async () => {
	const changes = [];
	const notices = [];
	const app = {
		models: { getModel: (_, id) => id === "vendor/model" ? {} : undefined },
		conversation: () => ({ configure: async (change) => changes.push(change) }),
		notify: (text) => notices.push(text), refreshStatus() {},
	};
	await runCommand(app, "model router/vendor/model:high");
	assert.deepEqual(changes, [{ model: { provider: "router", modelId: "vendor/model" }, thinkingLevel: "high" }]);
	app.conversation = () => ({ compact: async () => { throw new Error("cannot compact"); } });
	assert.equal(await runCommand(app, "compact"), true);
	assert.match(notices.at(-1), /cannot compact/);
});
