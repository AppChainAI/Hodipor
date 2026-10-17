// @ts-nocheck
// Ported from @juicesharp/rpiv-todo@2.13.8 (MIT, © 2026 juicesharp):
// tool/response-envelope.ts and view/format.ts, plus a compact host panel.

import { deriveBlocks, selectTasksByStatus, selectTodoCounts } from "./reducer.mjs";

function sanitizeTerminalText(text) {
	// Control characters have no business in a terminal label.
	return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function formatListLine(t) {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

function formatGetLines(task, state) {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	return lines.join("\n");
}

/** Pure formatter: (op, state) → model-facing text. */
export function formatContent(op, state) {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			if (!t) return `Created #${op.taskId}`;
			return `Created #${t.id}: ${sanitizeTerminalText(t.subject)} (pending)`;
		}
		case "update": {
			if (!op.changed) return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/** Host panel: compact lines for the widget above the editor. */
export function renderTodoPanel(state) {
	const visible = state.tasks.filter((t) => t.status !== "deleted");
	if (visible.length === 0) return [];
	const counts = selectTodoCounts(state);
	const lines = [`Todos ${counts.completed}/${counts.total}`];
	const mark = { pending: "○", in_progress: "◐", completed: "✓" };
	for (const status of ["in_progress", "pending", "completed"]) {
		for (const task of visible.filter((t) => t.status === status)) {
			const form = task.status === "in_progress" && task.activeForm ? ` — ${sanitizeTerminalText(task.activeForm)}` : "";
			lines.push(`${mark[task.status]} #${task.id} ${sanitizeTerminalText(task.subject)}${form}`);
		}
	}
	return lines;
}

/** /todos command body. */
export function formatTodoSummary(state) {
	const visible = state.tasks.filter((t) => t.status !== "deleted");
	if (visible.length === 0) return "No todos yet. Ask the agent to add some!";
	const counts = selectTodoCounts(state);
	const groups = selectTasksByStatus(state);
	const lines = [`${counts.completed}/${counts.total} completed · ${counts.inProgress} in progress · ${counts.pending} pending`];
	for (const [label, tasks] of [["Pending", groups.pending], ["In progress", groups.inProgress], ["Completed", groups.completed]]) {
		if (tasks.length === 0) continue;
		lines.push(`── ${label} ──`);
		for (const task of tasks) lines.push(formatListLine(task));
	}
	return lines.join("\n");
}
