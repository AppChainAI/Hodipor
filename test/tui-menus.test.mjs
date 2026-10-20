import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { ChoiceSelector } from "../src/tui/choice-selector.mjs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { runCommand } from "../src/tui/commands.mjs";

initTheme();

function fixture() {
	const models = createModels();
	models.setProvider(fauxProvider({ models: [{ id: "menu-model", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }] }).provider);
	const model = { ...models.getModel("faux", "menu-model"), thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
	const changes = [], errors = [];
	let component;
	let refreshSignal;
	const app = {
		models: {
			getAvailableSnapshot: () => [model], getModel: () => model,
			refresh: ({ signal }) => {
				refreshSignal = signal;
				return new Promise(resolve => signal.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), { once: true }));
			},
		},
		tui: { requestRender() {} },
		currentModel: () => model,
		conversation: () => ({ agent: async () => ({ thinkingLevel: "off" }), configure: async (change) => changes.push(change) }),
		swapEditor(value) { component = value; },
		restoreEditor(expected) { if (!expected || expected === component) component = undefined; },
		notify: (message) => errors.push(message), refreshStatus() {},
	};
	return { app, changes, errors, current: () => component, refreshSignal: () => refreshSignal };
}

test("model menu uses the same editor slot as login and cancels its background refresh", async () => {
	const f = fixture();
	await runCommand(f.app, "model");
	assert.ok(f.current(), f.errors.join("\n"));
	assert.equal(f.current().constructor.name, "ModelSelectorComponent");
	f.current().handleInput("\x1b");
	assert.equal(f.current(), undefined);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.refreshSignal().aborted, true);
	assert.deepEqual(f.errors, []);
});

test("choice menus bound long lists, keep one cursor and fit narrow terminals", () => {
	const menu = new ChoiceSelector("Resume session", Array.from({ length: 100 }, (_, i) => ({ value: String(i), label: `session-${i}` })), () => {}, () => {});
	menu.focused = true;
	for (const width of [35, 80, 160]) {
		const lines = menu.render(width);
		assert.ok(lines.length < 24);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
		assert.ok(!lines.join("").includes("to set as default"));
	}
});

test("resume without an ID opens a searchable picker instead of silently switching sessions", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hodipor-resume-menu-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const id of ["first", "second"]) {
		await mkdir(join(dir, id));
		await writeFile(join(dir, id, "state.sqlite"), "");
	}
	const restarts = [];
	const app = {
		paths: { sessionsDir: dir }, sessionId: "first",
		swapEditor(menu) { menu.handleInput("second"); menu.handleInput("\r"); },
		restoreEditor() {}, restart: async (request) => restarts.push(request),
		notify: (text) => assert.fail(text),
	};
	await runCommand(app, "resume");
	assert.deepEqual(restarts, [{ pickSession: "second" }]);
});

test("non-reasoning models do not offer unsupported thinking levels", async () => {
	const f = fixture();
	f.app.currentModel = () => ({ reasoning: false });
	await runCommand(f.app, "thinking");
	const lines = f.current().render(100).join("\n");
	assert.match(lines, /off/);
	assert.doesNotMatch(lines, /minimal|high|max|to set as default/);
	f.current().handleInput("\r");
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.changes, [{ thinkingLevel: "off" }]);
});

test("thinking menu is inline and offers the current model's extended levels", async () => {
	const f = fixture();
	await runCommand(f.app, "thinking");
	assert.ok(f.current(), f.errors.join("\n"));
	const menu = f.current();
	menu.handleInput("max");
	menu.handleInput("\r");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.current(), undefined);
	assert.deepEqual(f.changes, [{ thinkingLevel: "max" }]);
	assert.deepEqual(f.errors, []);
});
