import {
	selectTodoCounts,
	selectVisibleTasks,
	type TaskStatus,
	type TodoState,
} from "@siftory/protocol/todos";
import { Checkbox } from "./ui/checkbox";

const STATUS_TEXT: Record<TaskStatus, string> = {
	pending: "待办",
	in_progress: "进行中",
	completed: "已完成",
	deleted: "已删除",
};

/** 任务列表面板：出现在输入框上方，随快照每次 commit 刷新。无可见任务时不占位。
 *  状态用 checkbox 表达：待办未勾、进行中半选、完成勾选划线；纯展示不可点。 */
export function TodoPanel({ state }: { state: TodoState }) {
	const visible = selectVisibleTasks(state);
	if (visible.length === 0) return null;
	const counts = selectTodoCounts(state);
	return (
		<section className="todo-panel" aria-label="任务列表">
			<header className="todo-heading">
				任务 {counts.completed}/{counts.total}
			</header>
			<ol className="todo-list">
				{visible.map((t) => (
					<li key={t.id} className={`todo-item ${t.status}`}>
						<Checkbox
							checked={t.status === "completed"}
							indeterminate={t.status === "in_progress"}
							readOnly
							tabIndex={-1}
							aria-label={`${t.subject}，${STATUS_TEXT[t.status]}`}
						/>
						<span className="todo-subject">
							{t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
						</span>
						{t.blockedBy?.length ? (
							<span className="todo-blocked">⛓ {t.blockedBy.map((id) => `#${id}`).join(",")}</span>
						) : null}
					</li>
				))}
			</ol>
		</section>
	);
}
