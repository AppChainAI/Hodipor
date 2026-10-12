import { describe, expect, it } from "bun:test";
import { EMPTY_TODO_STATE, type TodoState } from "@siftory/protocol/todos";
import { applyTaskMutation, changesState } from "../src/extensions/todo/state/reducer";
import { isTransitionValid } from "../src/extensions/todo/state/invariants";
import { sanitizeTaskText } from "../src/extensions/todo/tool/sanitize";
import { formatContent } from "../src/extensions/todo/tool/format";

const withTasks = (...subjects: string[]): TodoState => {
	let state = EMPTY_TODO_STATE;
	for (const subject of subjects) {
		state = applyTaskMutation(state, "create", { subject }).state;
	}
	return state;
};

describe("reducer", () => {
	it("creates tasks with monotonic ids and sanitizes model text", () => {
		const esc = String.fromCharCode(27);
		const { state, op } = applyTaskMutation(EMPTY_TODO_STATE, "create", {
			subject: `写${esc}[31m测试${esc}[0m\n换行`,
			activeForm: "正在写测试",
		});
		expect(op).toEqual({ kind: "create", taskId: 1 });
		expect(state.tasks[0].subject).toBe("写测试 换行");
		expect(state.tasks[0].status).toBe("pending");
		expect(state.nextId).toBe(2);
	});

	it("rejects create without subject and unknown blockedBy in-band", () => {
		expect(applyTaskMutation(EMPTY_TODO_STATE, "create", {}).op.kind).toBe("error");
		const { op } = applyTaskMutation(EMPTY_TODO_STATE, "create", { subject: "x", blockedBy: [9] });
		expect(op.kind).toBe("error");
		expect(changesState(op)).toBe(false);
	});

	it("enforces the status machine: completed cannot reopen, delete is a tombstone", () => {
		expect(isTransitionValid("completed", "in_progress")).toBe(false);
		expect(isTransitionValid("in_progress", "pending")).toBe(true);
		expect(isTransitionValid("deleted", "pending")).toBe(false);

		let state = withTasks("a");
		state = applyTaskMutation(state, "update", { id: 1, status: "completed" }).state;
		const reopen = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
		expect(reopen.op.kind).toBe("error");

		const del = applyTaskMutation(state, "delete", { id: 1 });
		expect(del.op.kind).toBe("delete");
		expect(del.state.tasks[0].status).toBe("deleted");
		expect(applyTaskMutation(del.state, "delete", { id: 1 }).op.kind).toBe("error");
	});

	it("rejects update without mutable fields and no-op updates report unchanged", () => {
		const state = withTasks("a");
		expect(applyTaskMutation(state, "update", { id: 1 }).op.kind).toBe("error");

		const noop = applyTaskMutation(state, "update", { id: 1, status: "pending" });
		expect(noop.op).toMatchObject({ kind: "update", changed: false });
		expect(changesState(noop.op)).toBe(false);
		expect(formatContent(noop.op, noop.state)).toContain("无变化");
	});

	it("merges blockedBy additively and rejects self-block, dangling deps and cycles", () => {
		let state = withTasks("a", "b", "c");
		const merged = applyTaskMutation(state, "update", { id: 3, addBlockedBy: [1, 2] });
		expect(merged.state.tasks[2].blockedBy).toEqual([1, 2]);

		expect(applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] }).op.kind).toBe("error");
		expect(applyTaskMutation(state, "update", { id: 1, addBlockedBy: [9] }).op.kind).toBe("error");

		// 3 blockedBy 1，再让 1 blockedBy 3 → 环
		state = applyTaskMutation(state, "update", { id: 3, addBlockedBy: [1] }).state;
		const cycle = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [3] });
		expect(cycle.op.kind).toBe("error");

		const removed = applyTaskMutation(state, "update", { id: 3, removeBlockedBy: [1] });
		expect(removed.state.tasks[2].blockedBy).toBeUndefined();
	});

	it("merges metadata with null-deletes-key semantics", () => {
		let state = withTasks("a");
		state = applyTaskMutation(state, "update", { id: 1, metadata: { k: "v", gone: "x" } }).state;
		state = applyTaskMutation(state, "update", { id: 1, metadata: { gone: null } }).state;
		expect(state.tasks[0].metadata).toEqual({ k: "v" });
		state = applyTaskMutation(state, "update", { id: 1, metadata: { k: null } }).state;
		expect(state.tasks[0].metadata).toBeUndefined();
	});

	it("clear tombstones nothing but resets ids; list hides deleted by default", () => {
		let state = withTasks("a", "b");
		state = applyTaskMutation(state, "delete", { id: 1 }).state;
		const list = applyTaskMutation(state, "list", {});
		expect(formatContent(list.op, list.state)).not.toContain("#1");
		const all = applyTaskMutation(state, "list", { includeDeleted: true });
		expect(formatContent(all.op, all.state)).toContain("#1");

		const cleared = applyTaskMutation(state, "clear", {});
		expect(cleared.state).toEqual({ tasks: [], nextId: 1 });
	});
});

describe("sanitizeTaskText", () => {
	it("strips ANSI, OSC, bidi controls and folds newlines", () => {
		const esc = String.fromCharCode(27);
		const osc = `${esc}]0;title${String.fromCharCode(7)}`;
		const bidi = String.fromCharCode(0x202e);
		expect(sanitizeTaskText(`${osc}${esc}[1;31m红${esc}[0m${bidi}\n行`)).toBe("红 行");
	});
});
