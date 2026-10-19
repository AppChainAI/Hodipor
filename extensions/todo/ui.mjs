import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { selectTodoCounts, selectVisibleTasks } from "./reducer.mjs";
import { sanitizeTerminalText } from "./view.mjs";

// Ported from rpiv-todo 2.13.8 view/format.ts, state/selectors.ts and todo-overlay.ts
// (MIT, © 2026 juicesharp). Only the state/lifecycle source changes to durable.
/** @type {Record<string, { glyph: string; color: import("@earendil-works/pi-coding-agent").ThemeColor }>} */
const STATUS = {
	pending: { glyph: "○", color: "dim" },
	in_progress: { glyph: "◐", color: "warning" },
	completed: { glyph: "●", color: "success" },
	deleted: { glyph: "⊘", color: "muted" },
};
/** @type {Record<string, string>} */
const ACTION = { create: "+", update: "→", delete: "×", get: "›", list: "☰", clear: "∅" };
/** @param {unknown} value */
const label = (value) => sanitizeTerminalText(value).replace(/[\r\n\t]/g, " ");
/** @param {string} status */
const statusLabel = (status) => status === "in_progress" ? "in progress" : status;

/** @param {() => { tasks: any[] }} [getState] @returns {import("@earendil-works/pi-coding-agent").ToolRenderers} */
export function createTodoRenderers(getState = () => ({ tasks: [] })) {
	return {
		renderCall(rawArgs, theme) {
			const args = /** @type {Record<string, any>} */ (rawArgs && typeof rawArgs === "object" ? rawArgs : {});
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", ACTION[args.action] ?? args.action ?? "");
			if (args.action === "create" && args.subject) {
				text += ` ${theme.fg("dim", label(args.subject))}`;
			} else if (["update", "get", "delete"].includes(args.action) && args.id !== undefined) {
				const subject = getState().tasks.find(task => task.id === args.id)?.subject;
				text += ` ${theme.fg("accent", subject ? label(subject) : `#${args.id}`)}`;
			} else if (args.action === "list" && args.status) {
				text += ` ${theme.fg("muted", statusLabel(args.status))}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			const details = /** @type {any} */ (result.details);
			const text = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
			if (context.isError) return new Text(theme.fg("error", text || "todo failed"), 0, 0);
			if (options.isPartial) return new Text(theme.fg("muted", "…"), 0, 0);
			let status;
			if (details?.action === "create") status = details.tasks?.at(-1)?.status;
			else if (details?.action === "update") status = details.params?.status ?? details.tasks?.find((/** @type {any} */ task) => task.id === details.params?.id)?.status;
			else if (details?.action === "delete") status = details.tasks?.find((/** @type {any} */ task) => task.id === details.params?.id)?.status;
			const style = STATUS[status];
			return new Text(style ? theme.fg(style.color, `${style.glyph} ${statusLabel(status)}`) : theme.fg("success", "✓"), 0, 0);
		},
	};
}
export const todoRenderers = createTodoRenderers();

/** @param {any[]} tasks @param {number} budget */
function overlayLayout(tasks, budget) {
	if (tasks.length <= budget) return { visible: tasks, hiddenCompleted: 0, truncatedTail: 0 };
	const innerBudget = budget - 1; // Reserve the overflow summary, after the heading.
	const unfinished = tasks.filter(task => task.status !== "completed");
	const totalCompleted = tasks.length - unfinished.length;
	if (unfinished.length <= innerBudget) {
		const kept = new Set(unfinished);
		for (const task of tasks) {
			if (kept.size >= innerBudget) break;
			if (task.status === "completed") kept.add(task);
		}
		const visible = tasks.filter(task => kept.has(task));
		return { visible, hiddenCompleted: totalCompleted - visible.filter(task => task.status === "completed").length, truncatedTail: 0 };
	}
	return { visible: unfinished.slice(0, innerBudget), hiddenCompleted: totalCompleted, truncatedTail: unfinished.length - innerBudget };
}

/** Persistent display only; the committed todo document remains authoritative. */
export class TodoPanel {
	/** @param {() => import("@earendil-works/pi-coding-agent").Theme} getTheme */
	constructor(getTheme) {
		this.getTheme = getTheme;
		/** @type {{ tasks: any[]; nextId?: number }} */
		this.state = { tasks: [] };
		this.collapsed = false;
		this.toolsExpanded = false;
		/** @type {Set<number>} */
		this.pendingHide = new Set();
		/** @type {Set<number>} */
		this.hidden = new Set();
	}
	/** @param {{ tasks: any[]; nextId?: number }} state */
	setState(state) {
		if (this.state.nextId !== undefined && state.nextId !== undefined && state.nextId < this.state.nextId) this.resetCompletedDisplayState();
		this.state = state;
		const completed = new Set(state.tasks.filter(task => task.status === "completed").map(task => task.id));
		for (const id of this.pendingHide) if (!completed.has(id)) this.pendingHide.delete(id);
		for (const id of this.hidden) if (!completed.has(id)) this.hidden.delete(id);
	}
	resetCompletedDisplayState() { this.pendingHide.clear(); this.hidden.clear(); }
	hideCompletedTasksFromPreviousTurn() {
		for (const id of this.pendingHide) this.hidden.add(id);
		this.pendingHide.clear();
	}
	toggle() { this.collapsed = !this.collapsed; }
	/** @param {boolean} expanded */
	setToolsExpanded(expanded) { this.toolsExpanded = expanded; }
	invalidate() {} // No cached theme strings or rows.
	/** @param {number} width */
	render(width) {
		const theme = this.getTheme();
		const tasks = /** @type {any[]} */ (selectVisibleTasks(this.state)).filter(task => task.status !== "completed" || !this.hidden.has(task.id));
		if (!tasks.length) return [];
		const counts = selectTodoCounts({ tasks });
		const active = tasks.some(task => task.status === "pending" || task.status === "in_progress");
		const color = active ? "accent" : "dim";
		const heading = `${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, `Todos (${counts.completed}/${counts.total})`)}`;
		const lines = ["", heading]; // Pi's widget host supplies the leading spacer.
		if (this.collapsed) {
			lines.push(`${theme.fg("dim", "└─")} ${theme.fg("dim", "ctrl+shift+t to expand")}`);
		} else {
			const showIds = tasks.some(task => task.blockedBy?.length);
			const layout = overlayLayout(tasks, this.toolsExpanded ? tasks.length : 11);
			for (const task of layout.visible) {
				const style = STATUS[task.status];
				let subject = theme.fg(task.status === "in_progress" ? "accent" : task.status === "completed" ? "muted" : "text", label(task.subject));
				if (task.status === "completed") subject = theme.style(subject, { strikethrough: true });
				const glyph = task.status === "completed" ? "✓" : style.glyph;
				const id = showIds ? ` ${theme.fg("dim", `#${task.id}`)}` : "";
				const form = task.status === "in_progress" && task.activeForm ? ` ${theme.fg("muted", `(${label(task.activeForm)})`)}` : "";
				const blocked = task.blockedBy?.length ? ` ${theme.fg("muted", `⛓ ${task.blockedBy.map((/** @type {number} */ id) => `#${id}`).join(",")}`)}` : "";
				lines.push(`${theme.fg("dim", "├─")} ${theme.fg(style.color, glyph)}${id} ${subject}${form}${blocked}`);
			}
			for (const task of tasks) if (task.status === "completed") this.pendingHide.add(task.id);
			const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
			if (totalHidden) {
				const parts = [];
				if (layout.hiddenCompleted) parts.push(`${layout.hiddenCompleted} completed`);
				if (layout.truncatedTail) parts.push(`${layout.truncatedTail} pending`);
				lines.push(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${totalHidden} more (${parts.join(", ")})`)}`);
			} else lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
		}
		lines.push("");
		return lines.map(line => truncateToWidth(line, Math.max(1, width), "…"));
	}
}
