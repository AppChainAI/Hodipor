import { deriveBlocks, type Task, type TodoState } from "@siftory/protocol/todos";
import type { Op } from "../state/reducer";

/** 单任务列表行：`[status] #id subject (activeForm) ⛓ #dep,…` */
function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	return `[${t.status}] #${t.id} ${t.subject}${form}${block}`;
}

/** get 动作的多行展示 */
function formatGetLines(task: Task, state: TodoState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${task.subject}`];
	if (task.description) lines.push(`  description: ${task.description}`);
	if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	return lines.join("\n");
}

/**
 * 纯格式化：(op, state) → 模型可见文本。对 op.kind 封闭 switch——
 * 新增 Op 变体在这里编译报错，直到补上分支。
 */
export function formatContent(op: Op, state: TodoState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			if (!t) return `已创建 #${op.taskId}`;
			return `已创建 #${t.id}: ${t.subject} (pending)`;
		}
		case "update": {
			if (!op.changed) {
				return `无变化：#${op.id} 已与请求值一致（status: ${op.toStatus}）`;
			}
			const transition = op.fromStatus !== op.toStatus ? `（${op.fromStatus} → ${op.toStatus}）` : "";
			return `已更新 #${op.id}${transition}`;
		}
		case "delete":
			return `已删除 #${op.id}: ${op.subject}`;
		case "clear":
			return `已清空 ${op.count} 个任务`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			return view.length === 0 ? "没有任务" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `错误：${op.message}`;
	}
}
