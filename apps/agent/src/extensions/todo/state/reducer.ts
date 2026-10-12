import type { JsonValue, Task, TodoState } from "@siftory/protocol/todos";
import { sanitizeTaskText } from "../tool/sanitize";
import { isTransitionValid } from "./invariants";
import { detectCycle } from "./task-graph";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

/** reducer 接受的开放输入袋；索引签名让 TypeBox 推导值免 as 传入 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: Task["status"];
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, JsonValue>;
	id?: number;
	includeDeleted?: boolean;
}

/**
 * reducer 结果。封闭 tagged union：新增 action 必须同时扩展此联合与
 * formatContent 的 switch（编译器强制穷尽）。error 带内携带消息，
 * 调用方 pattern-match 即可，不需要旁路布尔。
 */
export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: Task["status"]; toStatus: Task["status"]; changed: boolean }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: Task["status"]; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TodoState;
	op: Op;
}

/** op 是否改变了任务状态——false 时不写文档（读、失败、无效果 update）。新 action 必须在此表态。 */
export function changesState(op: Op): boolean {
	switch (op.kind) {
		case "create":
		case "delete":
		case "clear":
			return true;
		case "update":
			return op.changed;
		case "list":
		case "get":
		case "error":
			return false;
	}
}

function errorResult(state: TodoState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameRecord(a: Record<string, JsonValue> | undefined, b: Record<string, JsonValue> | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 这次 update 有没有实际变化？无变化返回 false，工具回「无变化」而不是「已更新」——
 * 否则 no-op 与真变更不可区分，会驱动模型循环重发同一调用。
 */
function taskChanged(before: Task, after: Task): boolean {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		!sameNumberList(before.blockedBy, after.blockedBy) ||
		!sameRecord(before.metadata, after.metadata)
	);
}

function clean(text: string | undefined): string | undefined {
	return text === undefined ? undefined : sanitizeTaskText(text);
}

/**
 * 纯 reducer：(state, action, params) → (state, op)。
 * 校验内联：结构守卫（subject 必填、id 必填、至少一个可变字段）+
 * 状态感知检查（迁移合法性、blockedBy 悬空/已删/自引用/成环）。
 */
export function applyTaskMutation(
	state: TodoState,
	action: TaskAction,
	params: TaskMutationParams,
): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "create 需要 subject");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} 不存在`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} 已删除`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: sanitizeTaskText(params.subject),
				status: "pending",
			};
			const description = clean(params.description);
			if (description) newTask.description = description;
			const activeForm = clean(params.activeForm);
			if (activeForm) newTask.activeForm = activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			const owner = clean(params.owner);
			if (owner) newTask.owner = owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			return {
				state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "update 需要 id");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} 不存在`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) {
				return errorResult(
					state,
					"update 至少需要一个可变字段：subject, description, activeForm, status, owner, metadata, addBlockedBy, removeBlockedBy",
				);
			}

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `非法状态迁移 ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `#${current.id} 不能被自己阻塞`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} 不存在`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} 已删除`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy 会在 blockedBy 依赖图中成环");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, JsonValue> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = sanitizeTaskText(params.subject);
			if (params.description !== undefined) updated.description = sanitizeTaskText(params.description);
			if (params.activeForm !== undefined) updated.activeForm = sanitizeTaskText(params.activeForm);
			if (params.owner !== undefined) updated.owner = sanitizeTaskText(params.owner);
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed: taskChanged(current, updated),
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "get 需要 id");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} 不存在`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "delete 需要 id");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} 不存在`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} 已是删除状态`);
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}
	}
}
