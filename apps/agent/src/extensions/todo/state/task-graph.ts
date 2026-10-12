import type { Task } from "@siftory/protocol/todos";

/**
 * 把 newBlockedBy 并进 taskId 的 blockedBy 是否会成环。
 * 纯函数：显式传入现有任务与提议增量，reducer 可以在改状态前先问「会不会成环」。
 */
export function detectCycle(
	taskList: readonly Task[],
	taskId: number,
	newBlockedBy: readonly number[],
): boolean {
	const edges = new Map<number, number[]>();
	for (const t of taskList) {
		if (t.id === taskId) {
			const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
			edges.set(t.id, [...merged]);
		} else {
			edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
		}
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) {
			if (hasCycleFrom(nb)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}
