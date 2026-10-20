import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HodiporFooter, contextDisplayStats } from "../src/tui/footer.mjs";
import { activeTheme } from "../src/tui/theme.mjs";

initTheme("dark");
const usage = { input: 20, output: 10, cacheRead: 30, cacheWrite: 0, totalTokens: 60, cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0, total: 0.3 } };

test("footer uses the native two-line cwd/stats/model layout and includes tool usage", () => {
	const state = { cwd: "/tmp/workspace", sessionId: "acceptance", model: { provider: "faux", id: "faux-1", reasoning: true, contextWindow: 1000 }, thinkingLevel: "high", contextTokens: 800, cacheHitRate: 60, usage: { models: { "faux/faux-1": usage }, tools: { billable: usage } } };
	const footer = new HodiporFooter(() => state);
	const lines = footer.render(120);
	assert.equal(lines.length, 2);
	assert.match(plain(lines[0]), /\/tmp\/workspace • acceptance/);
	assert.match(plain(lines[1]), /↑40 ↓20 R60 CH60.0% \$0.600 80.0%\/1.0k/);
	assert.match(plain(lines[1]), /\(faux\) faux-1 • high$/);
	const warningPrefix = activeTheme().fg("warning", "TOKEN").split("TOKEN")[0];
	assert(lines[1].includes(warningPrefix));
	for (const width of [1, 8, 35, 80]) assert(footer.render(width).every(line => visibleWidth(line) <= width));
	state.contextTokens = 950;
	assert(footer.render(120)[1].includes(activeTheme().fg("error", "TOKEN").split("TOKEN")[0]));
});

test("new-session footer has zero context, no old spend, and follows theme changes", () => {
	const footer = new HodiporFooter(() => ({ cwd: "/tmp/new", sessionId: "NEW_SESSION", contextTokens: 0, model: { id: "faux-1", provider: "faux", reasoning: true, contextWindow: 1000 } }));
	const dark = footer.render(100);
	assert.match(plain(dark.join("\n")), /0.0%\/1.0k.*thinking off/);
	assert.doesNotMatch(plain(dark.join("\n")), /↑|↓|\$|working|Ctrl\+T todos/);
	initTheme("light");
	try {
		const light = footer.render(100);
		assert.equal(plain(dark.join("\n")), plain(light.join("\n")));
		assert.notEqual(dark.join("\n"), light.join("\n"));
	} finally { initTheme("dark"); }
});

test("context display uses committed model messages and treats pre-compaction usage as unknown", () => {
	const assistant = { role: "assistant", content: [{ type: "text", text: "reply" }], usage, stopReason: "stop" };
	const context = { messages: [assistant], entries: [{ id: 1, kind: "pi.assistant", model: [assistant] }], contributions: [[assistant]], head: undefined };
	assert.deepEqual(contextDisplayStats(context), { contextTokens: 60, cacheHitRate: 60 });
	const head = { id: 2, kind: "pi.compaction" };
	assert.equal(contextDisplayStats({ ...context, head }).contextTokens, null);
	assert.equal(contextDisplayStats({ ...context, head, entries: [{ ...context.entries[0], id: 3 }] }).contextTokens, 60);
	assert.deepEqual(contextDisplayStats({ messages: [], entries: [], contributions: [], head: undefined }), { contextTokens: 0, cacheHitRate: undefined });
});
