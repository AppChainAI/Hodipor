// @ts-nocheck
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Ported from @juicesharp/rpiv-todo@2.13.8 (MIT, © 2026 juicesharp):
// state/types.ts, state/invariants.ts, state/task-graph.ts, state/state-reducer.ts.
// Tool name "todo" and the mutation semantics are kept byte-compatible.

export const TOOL_NAME = "todo";

export const Task = Type.Object({
	id: Type.Number(),
	subject: Type.String(),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	status: StringEnum(["pending", "in_progress", "completed", "deleted"]),
	blockedBy: Type.Optional(Type.Array(Type.Number())),
	owner: Type.Optional(Type.String()),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"]),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')" }),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"], {
			description:
				"Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
		}),
	),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" })),
	addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only, additive merge)" })),
	removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only, additive merge)" })),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata; pass null value for a key to delete that key on update" }),
	),
	id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false." }),
	),
});

const VALID_TRANSITIONS = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from, to) {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}

export function detectCycle(taskList, taskId, newBlockedBy) {
	const edges = new Map();
	for (const t of taskList) {
		if (t.id === taskId) edges.set(t.id, [...new Set([...(t.blockedBy ?? []), ...newBlockedBy])]);
		else edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
	}
	const visiting = new Set();
	const visited = new Set();
	const hasCycleFrom = (node) => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) if (hasCycleFrom(nb)) return true;
		visiting.delete(node);
		visited.add(node);
		return false;
	};
	for (const node of edges.keys()) if (hasCycleFrom(node)) return true;
	return false;
}

export function deriveBlocks(taskList) {
	const blocks = new Map();
	for (const t of taskList) {
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}

export function selectVisibleTasks(state) {
	return state.tasks.filter((t) => t.status !== "deleted");
}

export function selectTasksByStatus(state) {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

export function selectTodoCounts(state) {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

/**
 * Pure reducer: (state, action, params) → { state, op }. Validation in-line, as
 * upstream: structural guards plus state-aware checks (transitions, dangling
 * blockedBy, self-block, cycles).
 */
export function applyTaskMutation(state, action, params) {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) return errorResult(state, "subject required for create");
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask = { id: state.nextId, subject: params.subject, status: "pending" };
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };
			return { state: { ...state, tasks: [...state.tasks, newTask], nextId: state.nextId + 1 }, op: { kind: "create", taskId: newTask.id } };
		}
		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
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
			if (!hasMutation)
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
				);
			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				newStatus = params.status;
			}
			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
			}
			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}
			const updated = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { ...state, tasks: newTasks },
				op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus, changed: taskChanged(current, updated) },
			};
		}
		case "list":
			return {
				state,
				op: { kind: "list", includeDeleted: params.includeDeleted === true, ...(params.status !== undefined ? { statusFilter: params.status } : {}) },
			};
		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}
		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return { state: { ...state, tasks: newTasks }, op: { kind: "delete", id: updated.id, subject: updated.subject } };
		}
		case "clear":
			return { state: { ...state, tasks: [], nextId: 1 }, op: { kind: "clear", count: state.tasks.length } };
	}
}

function errorResult(state, message) {
	return { state, op: { kind: "error", message } };
}

function taskChanged(before, after) {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		JSON.stringify(before.blockedBy ?? []) !== JSON.stringify(after.blockedBy ?? []) ||
		JSON.stringify(before.metadata ?? null) !== JSON.stringify(after.metadata ?? null)
	);
}
