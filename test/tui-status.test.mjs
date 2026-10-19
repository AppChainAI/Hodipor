import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { Container } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { RunStatus } from "../src/tui/run-status.mjs";
import { activeTheme } from "../src/tui/theme.mjs";

initTheme("dark");

function fixture(t) {
	let renders = 0;
	const tui = { requestRender() { renders++; } };
	const editor = { indicator: undefined, borderColor: text => activeTheme().getThinkingBorderColor("high")(text), setWorkingStatusIndicator(value) { this.indicator = value; } };
	const fallback = new Container();
	const status = new RunStatus(tui, editor, fallback);
	t.after(() => { status.dispose(); initTheme("dark"); });
	return { editor, fallback, status, renders: () => renders };
}

test("native working indicator animates, moves to selectors and stops on idle/exit", async t => {
	const f = fixture(t);
	f.status.set({ kind: "working" });
	const indicator = f.editor.indicator;
	assert.match(plain(indicator.renderInBorder(100)), /Working \(esc to interrupt\)/);
	const before = indicator.renderSpinnerInBorder(10);
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.notEqual(indicator.renderSpinnerInBorder(10), before);
	f.status.set({ kind: "working" });
	assert.equal(f.editor.indicator, indicator, "same phase must not restart animation");
	f.status.setEmbedded(false);
	assert.equal(f.editor.indicator, undefined);
	assert.equal(f.fallback.children[0], indicator);
	f.status.setEmbedded(true);
	assert.equal(f.editor.indicator, indicator);
	assert.equal(f.fallback.children.length, 0);
	f.status.set(undefined);
	assert.equal(indicator.intervalId, null);
	assert.equal(f.editor.indicator, undefined);
	f.status.dispose();
	const count = f.renders();
	f.status.set({ kind: "working" }); f.status.setEmbedded(false);
	assert.equal(f.renders(), count, "late callbacks after disposal must not repaint");
});

test("compaction, retry deadline and deferred waiting use distinct statuses and clear timers", t => {
	const f = fixture(t);
	f.status.set({ kind: "compaction", reason: "overflow" });
	const compact = f.editor.indicator;
	assert.match(plain(compact.renderInBorder(120)), /Context overflow detected, Auto-compacting/);
	f.status.set({ kind: "retry", attempt: 2, at: Date.now() + 10000 });
	assert.equal(compact.intervalId, null);
	const retry = f.editor.indicator;
	assert.match(plain(retry.renderInBorder(120)), /Retrying \(2\) in \d+s/);
	assert.doesNotMatch(plain(retry.renderInBorder(120)), /undefined/);
	f.status.set({ kind: "deferred", at: Date.now() + 1000 });
	assert.equal(retry.intervalId, null);
	assert.equal(f.status.countdown, undefined);
	assert.match(plain(f.editor.indicator.renderInBorder(120)), /Waiting for provider/);
});

test("embedded working text re-reads the active thinking-border color on theme change", t => {
	const f = fixture(t);
	f.status.set({ kind: "working" });
	f.editor.indicator.setIndicator({ frames: ["STATIC"] });
	const dark = f.editor.indicator.renderInBorder(100);
	initTheme("light");
	f.status.invalidate();
	const light = f.editor.indicator.renderInBorder(100);
	assert.equal(plain(dark), plain(light));
	assert.notEqual(dark, light);
});
