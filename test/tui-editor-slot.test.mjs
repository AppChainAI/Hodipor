import assert from "node:assert/strict";
import test from "node:test";
import { Container, CURSOR_MARKER, Input, visibleWidth } from "@earendil-works/pi-tui";
import { createEditorSlot } from "../src/tui/editor-slot.mjs";

function fixture() {
	const container = new Container();
	const editor = new Input();
	let focused;
	const tui = {
		setFocus(component) {
			if (focused) focused.focused = false;
			focused = component;
			component.focused = true;
		},
		requestRender() {},
	};
	container.addChild(editor);
	tui.setFocus(editor);
	return { container, editor, slot: createEditorSlot(tui, container, editor) };
}

test("the editor slot mounts one full-width input and restores focus at narrow and wide widths", () => {
	const { slot, container, editor } = fixture();
	const menu = new Input();
	slot.show(menu);
	assert.equal(editor.focused, false);
	assert.equal(menu.focused, true);
	assert.deepEqual(container.children, [menu]);
	for (const width of [30, 80, 160]) {
		const lines = container.render(width);
		assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
		assert(lines.every(line => visibleWidth(line) <= width));
	}
	slot.restore(menu);
	assert.equal(editor.focused, true);
	assert.equal(menu.focused, false);
	assert.deepEqual(container.children, [editor]);
});

test("replacement disposes the previous selector; stale completion and shutdown cannot steal focus", () => {
	const { slot, container, editor } = fixture();
	let disposed = 0;
	const old = { render: () => [], dispose: () => disposed++ };
	const next = new Input();
	slot.show(old);
	slot.show(next);
	assert.equal(disposed, 1);
	slot.restore(old);
	assert.deepEqual(container.children, [next]);
	slot.show(old, old);
	assert.deepEqual(container.children, [next]);
	slot.dispose();
	slot.restore(next);
	assert.deepEqual(container.children, [next]);
	assert.equal(editor.focused, false);
});

test("cancelling an interaction invokes its escape path and disposes only once", () => {
	const { slot, container, editor } = fixture();
	let disposed = 0;
	const menu = {
		render: () => [], dispose: () => disposed++,
		handleInput(key) { assert.equal(key, "\x1b"); slot.restore(menu); },
	};
	slot.show(menu);
	slot.cancel();
	assert.deepEqual(container.children, [editor]);
	assert.equal(disposed, 1);
	slot.dispose();
	slot.dispose();
	assert.equal(disposed, 1);
});
