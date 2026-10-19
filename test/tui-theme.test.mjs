import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTheme, createThemeController } from "../src/tui/theme.mjs";

async function fixture(t, settings) {
	const home = await mkdtemp(join(tmpdir(), "siftory-theme-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const agentDir = join(home, "agent");
	await mkdir(join(agentDir, "themes"), { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	const errors = [];
	let changes = 0, lateReply, schemeListener, unsubscribed = false;
	const tui = {
		queryTerminalColors: async ({ onLateReply }) => { lateReply = onLateReply; return { background: { r: 20, g: 20, b: 20 }, foreground: { r: 240, g: 240, b: 240 } }; },
		onTerminalColorSchemeChange(listener) { schemeListener = listener; return () => { unsubscribed = true; }; },
		setTerminalColorSchemeNotifications() {},
	};
	const open = () => createThemeController(tui, { cwd: home, agentDir, onChanged: () => changes++, onError: text => errors.push(text) });
	return { home, agentDir, open, errors, changes: () => changes, lateReply: (...args) => lateReply(...args), unsubscribed: () => unsubscribed };
}

test("theme config is isolated, preserves unrelated settings, and persists selection", async (t) => {
	const f = await fixture(t, { theme: "dark", unrelated: "preserve-me" });
	const controller = f.open();
	t.after(() => controller.dispose());
	assert.equal(activeTheme().name, "dark");
	await controller.start();
	await controller.set("light");
	assert.equal(activeTheme().name, "light");
	const saved = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"));
	assert.equal(saved.unrelated, "preserve-me");
	assert.equal(saved.theme, "light");
	assert.deepEqual(f.errors, []);
	await assert.rejects(() => controller.set("../../personal"), /unknown theme/);
	assert.equal(activeTheme().name, "light");
});

test("home custom themes and light/dark pairs use Pi validation and terminal color replies", async (t) => {
	const f = await fixture(t, { theme: "fixture" });
	const base = JSON.parse(await readFile(new URL("./modes/interactive/theme/dark.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8"));
	base.name = "fixture";
	base.colors.toolTitle = "#abcdef";
	await writeFile(join(f.agentDir, "themes", "fixture.json"), JSON.stringify(base));
	const controller = f.open();
	assert.equal(activeTheme().name, "fixture");
	assert.ok(controller.names().includes("fixture"));
	await controller.start();
	await controller.set("light/dark");
	assert.equal(activeTheme().name, "dark");
	f.lateReply({ background: { r: 255, g: 255, b: 255 }, foreground: { r: 0, g: 0, b: 0 } });
	assert.equal(activeTheme().name, "light");
	controller.dispose();
	const changes = f.changes();
	f.lateReply({ background: { r: 0, g: 0, b: 0 } });
	assert.equal(f.changes(), changes);
	assert.ok(f.unsubscribed());
	assert.deepEqual(f.errors, []);
});

test("unknown saved themes fall back visibly rather than loading personal Pi themes", async (t) => {
	const f = await fixture(t, { theme: "personal-only" });
	const controller = f.open();
	t.after(() => controller.dispose());
	assert.equal(controller.selection(), "system");
	assert.equal(activeTheme().name, "system");
	assert.match(f.errors.join("\n"), /unknown theme: personal-only/);
	assert.equal(JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")).theme, "personal-only");
});
