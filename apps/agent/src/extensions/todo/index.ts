import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { EMPTY_TODO_STATE, TODO_DOC_KIND, type TodoState } from "@siftory/protocol/todos";
import { applyTaskMutation, changesState, type TaskMutationParams } from "./state/reducer";
import { formatContent } from "./tool/format";
import { TodoParamsSchema } from "./tool/schema";

/**
 * 会话任务列表文档。rewindable：reset 回退会话时列表跟着回到当时的状态；
 * fork: asOf：分叉子会话拿到分叉时刻的快照。kind 与版本是持久化协议，不轻易改。
 */
export const TodosDoc = defineDoc<TodoState>({
	kind: TODO_DOC_KIND,
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ tasks: [], nextId: 1 }),
});

const todo = defineTool({
	name: "todo",
	description:
		"管理任务列表以跟踪多步骤工作的进度。动作：create 新建任务；update 改状态/字段/依赖；list 全部任务（可按状态过滤）；get 单个详情；delete 墓碑删除；clear 清空重置。状态机：pending → in_progress → completed，delete 为墓碑终态。用于规划与跟踪研究、设计、实现等多步任务。",
	parameters: TodoParamsSchema,
	execute: async (args, api, context) => {
		// 模型参数本就是 JSON，metadata 的 unknown 与协议 JsonValue 同构
		const params = args as TaskMutationParams;

		// 读动作不 commit：snapshot 直读，不产生任何写记录
		if (args.action === "list" || args.action === "get") {
			const state = (await api.snapshot(TodosDoc, api.conversationId, context)) ?? EMPTY_TODO_STATE;
			const { op } = applyTaskMutation(state, args.action, params);
			return {
				output: [{ type: "text" as const, text: formatContent(op, state) }],
				...(op.kind === "error" ? { isError: true } : {}),
			};
		}

		// 写动作在 commit 内对最新文档状态跑 reducer，无变化则不碰文档
		const result = await api.commit(async (tx) => {
			const doc = await tx.doc(TodosDoc, api.conversationId);
			const current = JSON.parse(JSON.stringify(doc)) as TodoState;
			const r = applyTaskMutation(current, args.action, params);
			if (changesState(r.op)) {
				doc.tasks = r.state.tasks;
				doc.nextId = r.state.nextId;
			}
			return r;
		}, context);
		return {
			output: [{ type: "text" as const, text: formatContent(result.op, result.state) }],
			...(result.op.kind === "error" ? { isError: true } : {}),
		};
	},
});

/** 行为引导随扩展加入；core 只放通用准则。 */
const TODO_GUIDELINES = [
	"复杂工作（3 步以上）、用户给出任务清单、或收到新指令后，立即用 todo 捕获需求；单个琐碎任务和纯对话不用",
	"开始列表中的任务前，先标 in_progress；完成后立即标 completed——不批量补标；同时只有一个任务 in_progress",
	"测试失败、实现不完整或有未解决错误时，不许标 completed——保持 in_progress 并为阻塞点新建任务",
	'改状态用 update 加任务 id 与目标 status，如 {"action":"update","id":3,"status":"completed"}；标 in_progress 时传 activeForm；不带任何可变字段的 update 会被拒绝',
	"用 blockedBy 表达依赖（A 被 B 阻塞）：create 传初始集合，update 用 addBlockedBy/removeBlockedBy 增量合并，勿重发全量数组；成环会被拒绝",
	"list 默认隐藏已删除（墓碑）任务，includeDeleted:true 可见；传 status 可按单状态过滤",
	"subject 用简短祈使句；长文细节写进 description",
];

export default defineExtension({
	name: "todo",
	tools: [todo],
	sections: [section("todo_guidance", () => TODO_GUIDELINES.map((g) => `- ${g}`).join("\n"))],
});
