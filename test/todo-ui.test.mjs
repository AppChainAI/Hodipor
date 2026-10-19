import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TodoPanel, todoRenderers, createTodoRenderers } from "../extensions/todo/ui.mjs";
import { activeTheme } from "../src/tui/theme.mjs";

initTheme("dark");

test("todo panel uses status colors, strikes completed subjects and bounds its height", () => {
	let struck = 0;
	const panel = new TodoPanel(() => ({
		fg: (token, text) => activeTheme().fg(token, text),
		strikethrough: (text) => { struck++; return activeTheme().strikethrough(text); },
		style: (text, attrs) => { if (attrs.strikethrough) struck++; return activeTheme().style(text, attrs); },
	}));
	panel.setState({ tasks: [
		{ id: 1, subject: "已完成任务", status: "completed" },
		{ id: 2, subject: "进行中的\n任务", status: "in_progress", activeForm: "验证中\t",  blockedBy: [1] },
		...Array.from({ length: 12 }, (_, i) => ({ id: i + 3, subject: "待办".repeat(40), status: "pending" })),
	] });
	const lines = panel.render(35);
	assert(lines.length <= 14);
	assert(lines.every(line => visibleWidth(line) <= 35));
	const plain = stripVTControlCharacters(lines.join("\n"));
	assert.match(plain, /Todos \(1\/14\)/);
	assert.match(plain, /验证中/);
	assert.match(plain, /more/);
	panel.toggle();
	assert.equal(panel.render(80).length, 4);
	assert.match(stripVTControlCharacters(panel.render(80)[2]), /ctrl\+shift\+t to expand/);
	panel.setState({ tasks: [{ id: 1, subject: "完成", status: "completed" }] });
	panel.toggle();
	const completed = panel.render(80).join("\n");
	assert.equal(struck, 1);
	assert.match(completed, /\x1b\[9m/);
});

test("todo panel preserves the original tree, task order, conditional IDs and spacers", () => {
	const panel = new TodoPanel(activeTheme);
	panel.setState({ tasks: [
		{ id: 1, subject: "first", status: "completed" },
		{ id: 2, subject: "second", status: "in_progress", activeForm: "working" },
		{ id: 3, subject: "third", status: "pending" },
	], nextId: 4 });
	assert.deepEqual(panel.render(80).map(line => stripVTControlCharacters(line).trimEnd()), [
		"", "● Todos (1/3)", "├─ ✓ first", "├─ ◐ second (working)", "└─ ○ third", "",
	]);
});

test("completed rows disappear on the next run, not the current one, and can return", () => {
	const panel = new TodoPanel(activeTheme);
	const task = { id: 1, subject: "done", status: "completed" };
	panel.setState({ tasks: [task], nextId: 2 });
	assert.match(panel.render(80).join("\n"), /done/);
	panel.hideCompletedTasksFromPreviousTurn();
	assert.deepEqual(panel.render(80), []);
	panel.setState({ tasks: [{ ...task, status: "pending" }], nextId: 2 });
	assert.match(panel.render(80).join("\n"), /done/);
	panel.setState({ tasks: [task], nextId: 2 });
	assert.match(panel.render(80).join("\n"), /done/);
});

test("todo status echoes distinguish completed tool results from overlay checkmarks", () => {
	const result = { content: [], details: { action: "update", params: { id: 3, status: "completed" }, tasks: [{ id: 3, status: "completed" }] } };
	const node = todoRenderers.renderResult(result, { expanded: false, isPartial: false }, activeTheme(), {});
	assert.equal(stripVTControlCharacters(node.render(80).join("\n")).trimEnd(), "● completed");
});

test("todo tool calls resolve update/get/delete subjects and keep query results compact", () => {
	const renderers = createTodoRenderers(() => ({ tasks: [{ id: 3, subject: "REAL_TITLE" }] }));
	for (const action of ["update", "get", "delete"]) {
		const call = renderers.renderCall({ action, id: 3 }, activeTheme(), {});
		assert.match(stripVTControlCharacters(call.render(80).join("\n")), /REAL_TITLE/);
	}
	const result = { content: [], details: { action: "get", params: { id: 3 }, tasks: [{ id: 3, status: "completed" }] } };
	assert.equal(stripVTControlCharacters(renderers.renderResult(result, { expanded: true }, activeTheme(), {}).render(80).join("\n")).trimEnd(), "✓");
});

test("overflow drops completed rows before unfinished tasks, and Ctrl+O shows all in original order", () => {
	const panel = new TodoPanel(activeTheme);
	panel.setState({ tasks: [
		{ id: 1, subject: "OLD_DONE", status: "completed" },
		...Array.from({ length: 12 }, (_, i) => ({ id: i + 2, subject: `PENDING_${i}`, status: "pending" })),
		{ id: 14, subject: "NEW_DONE", status: "completed" },
	], nextId: 15 });
	const compact = stripVTControlCharacters(panel.render(100).join("\n"));
	assert.match(compact, /\+4 more \(2 completed, 2 pending\)/);
	assert.doesNotMatch(compact, /OLD_DONE|NEW_DONE/);
	panel.setToolsExpanded(true);
	const expanded = stripVTControlCharacters(panel.render(100).join("\n"));
	assert(expanded.indexOf("OLD_DONE") < expanded.indexOf("PENDING_0"));
	assert.match(expanded, /PENDING_11/);
	assert.match(expanded, /└─ ✓ NEW_DONE/);
	assert.doesNotMatch(expanded, /#\d/);
	panel.setState({ tasks: [{ id: 1, subject: "fresh", status: "pending", blockedBy: [2] }], nextId: 2 });
	assert.match(stripVTControlCharacters(panel.render(100).join("\n")), /#1 fresh ⛓ #2/);
});

test("collapsed completed tasks are not hidden before being displayed, and reset reveals them", () => {
	const panel = new TodoPanel(activeTheme);
	panel.setState({ tasks: [{ id: 1, subject: "COMPLETE", status: "completed" }], nextId: 2 });
	panel.toggle(); panel.render(80); panel.hideCompletedTasksFromPreviousTurn(); panel.toggle();
	assert.match(panel.render(80).join("\n"), /COMPLETE/);
	panel.hideCompletedTasksFromPreviousTurn();
	assert.deepEqual(panel.render(80), []);
	panel.resetCompletedDisplayState();
	assert.match(panel.render(80).join("\n"), /COMPLETE/);
});

test("todo cards use a compact call/status and show full errors rather than success", () => {
	const theme = activeTheme();
	const call = todoRenderers.renderCall({ action: "create", subject: "TASK_TITLE" }, theme, {});
	assert.match(stripVTControlCharacters(call.render(80).join("\n")), /todo \+ TASK_TITLE/);
	const result = { content: [{ type: "text", text: "Error: rejected mutation" }] };
	const error = todoRenderers.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: true });
	const text = stripVTControlCharacters(error.render(80).join("\n"));
	assert.match(text, /rejected mutation/);
	assert.doesNotMatch(text, /✓/);
});
