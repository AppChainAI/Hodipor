import type { TaskStatus } from "@siftory/protocol/todos";

/**
 * 每个源状态允许的前向迁移。completed 只能去 deleted（不回 in_progress）；deleted 是终态。
 * 同态幂等（same→same）在 isTransitionValid 单独放行，此表只列真实迁移。
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
