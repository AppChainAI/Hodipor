// @ts-nocheck
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { TodoParamsSchema, TOOL_NAME, applyTaskMutation } from "./reducer.mjs";
import { mutateTodo, stripReceipts, TodoDoc } from "./state.mjs";
import { formatContent, formatTodoSummary, renderTodoPanel } from "./view.mjs";

export { TOOL_NAME, TodoDoc, applyTaskMutation, formatContent, formatTodoSummary, renderTodoPanel, stripReceipts };

const GUIDANCE = `Manage a task list to track multi-step progress.

Guidelines:
- Use \`todo\` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.
- When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.
- Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.
- Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.
- To change a task's status, call update with the task id and the target status. status is the field that changes the task; an update without a mutable field is rejected.
- Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.
- list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them.`;

/**
 * The durable-native todo extension: tool + prompt section over the
 * conversation-scoped todo document. Ported from @juicesharp/rpiv-todo@2.13.8
 * (MIT, © 2026 juicesharp); reducer semantics are byte-compatible.
 */
export function createTodoExtension() {
	return defineExtension({
		name: "todo",
		sections: [section("todo-guidance", () => GUIDANCE)],
		tools: [
			defineTool({
				name: TOOL_NAME,
				description:
					"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
				parameters: TodoParamsSchema,
				// Replay safety holds only because mutations and their call receipts commit in
				// one transaction; the crash-injection test in extensions/todo/test guards it.
				replay: "safe",
				async execute(args, api, context) {
					const { op, state } = await api.commit(
						(tx) => mutateTodo(tx, api.conversationId, api.callId, args.action, args),
						context,
					);
					const text = formatContent(op, state);
					const details = {
						action: args.action,
						params: args,
						tasks: state.tasks,
						nextId: state.nextId,
						...(op.kind === "error" ? { error: op.message } : {}),
					};
					return {
						output: [{ type: "text", text }],
						details,
						isError: op.kind === "error",
					};
				},
			}),
		],
	});
}
