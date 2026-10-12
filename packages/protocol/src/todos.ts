/**
 * todo 扩展的共享形状：agent 侧的 app.todos 文档与 UI 渲染共用同一份类型与派生逻辑。
 * 状态机与写入只在 agent（extensions/todo）；这里只有类型、kind 常量与纯 selector。
 */

/** pi-durable 会话文档 kind；改名等于废弃历史数据，一次定对 */
export const TODO_DOC_KIND = "app.todos";

/** 协议级 JSON 值（metadata 用，对齐 chord 的 JsonValue 而不依赖它） */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

// 用 type 而非 interface：字面量类型带隐式索引签名，满足 pi-durable 文档的 JsonObject 约束
export type Task = {
	id: number;
	subject: string;
	description?: string;
	/** in_progress 时展示的现在进行时标签（如「正在写测试」） */
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	/** 传 null 删除对应 key（update 语义） */
	metadata?: Record<string, JsonValue>;
};

/** app.todos 文档值。nextId 单调分配；deleted 保留墓碑，id 引用永不悬空 */
export type TodoState = {
	tasks: Task[];
	nextId: number;
};

export const EMPTY_TODO_STATE: TodoState = { tasks: [], nextId: 1 };

/** 可见任务（排除墓碑）——「当前列表」的唯一定义 */
export function selectVisibleTasks(state: TodoState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
}

export function selectTasksByStatus(state: TodoState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

export function selectTodoCounts(state: TodoState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

/** 反向邻接：每个任务被哪些任务 blockedBy（UI 展示「blocks: #x」用） */
export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const t of taskList) {
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}
