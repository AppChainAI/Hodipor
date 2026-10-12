import { Type } from "@earendil-works/pi-ai";

// TypeBox 参数 schema——每个 description 同时是面向模型的提示词，措辞即行为引导。
// pi-ai 1.1.0 无 StringEnum，用 Type.Union([Type.Literal(...)]) 表达枚举。

const TaskStatusSchema = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")],
	{
		description:
			"任务状态。update 时设置目标状态（合法迁移：pending ↔ in_progress → completed → deleted 墓碑，不可回退）；list 时按此状态过滤。",
	},
);

export const TodoParamsSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("list"),
			Type.Literal("get"),
			Type.Literal("delete"),
			Type.Literal("clear"),
		],
		{
			description:
				"create 新建任务；update 改状态/字段/依赖（additive）；list 全部任务；get 单个详情；delete 墓碑删除；clear 清空重置",
		},
	),
	subject: Type.Optional(Type.String({ description: "任务主题行（create 必填）。简短祈使句，如「调研现有工具」" })),
	description: Type.Optional(Type.String({ description: "长文任务描述" })),
	activeForm: Type.Optional(
		Type.String({ description: "status 为 in_progress 时展示的现在进行时标签，如「正在写测试」" }),
	),
	status: Type.Optional(TaskStatusSchema),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "初始 blockedBy 依赖 id 列表（仅 create）" }),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "追加 blockedBy（仅 update，增量合并，勿重发全量数组）；成环会被拒绝" }),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "移除 blockedBy（仅 update，增量合并）" }),
	),
	owner: Type.Optional(Type.String({ description: "任务负责人/执行者" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "任意元数据；update 时某 key 传 null 即删除该 key",
		}),
	),
	id: Type.Optional(Type.Number({ description: "任务 id（update、get、delete 必填）" })),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "list 是否包含已删除（墓碑）任务，默认 false" }),
	),
});
