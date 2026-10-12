/**
 * sidecar ↔ UI 共享协议类型。两边都只从这里 import 类型，不各自定义。
 * UI 与 pi-durable 的 API 变更隔离：协议是面向 UI 的投影，不是 pi-durable 原始视图。
 */

/** 提供商配置状态（不含密钥本体） */
export interface ProviderStatus {
	id: string;
	name: string;
	/** 已配置密钥（来自 auth.json 或环境变量） */
	configured: boolean;
}

export interface ModelRef {
	provider: string;
	modelId: string;
}

/** GET /api/config 的响应 */
export interface ConfigView {
	providers: ProviderStatus[];
	/** 各提供商的已知模型目录；是否有密钥由 providers 表达 */
	models: Record<string, string[]>;
	/** 当前会话生效的 LLM 配置 */
	agent: AgentConfigView;
	/** 自定义 OpenAI 兼容供应商 */
	customProviders: CustomProvider[];
}

/** PUT /api/config 的请求体（字段均可独立） */
export interface ConfigUpdate {
	provider?: { id: string; apiKey: string };
	/** 会话级 LLM 配置：写入会话的 pi.agent 文档（SQLite 持久） */
	agent?: AgentConfigUpdate;
}

/** 会话级 LLM 配置项（对应 pi-durable 的 AgentChange 子集） */
export interface AgentConfigUpdate {
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
	/** 追加系统提示词；空串清除 */
	instructions?: string;
}

/** pi-ai 的 ModelThinkingLevel 镜像（协议独立，不依赖 pi 包） */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/** 当前生效的会话级配置（GET /api/config 返回，resolved 值） */
export interface AgentConfigView {
	model?: ModelRef;
	thinkingLevel: ThinkingLevel;
	instructions?: string;
}

/** POST /api/chat 的请求体 */
export interface ChatSubmit {
	content: string;
	/** 幂等键：断线重发不会产生两条 */
	requestId?: string;
}

export interface ChatSubmitResult {
	submissionId: string;
}

/** UI 侧消息（从 pi-durable entries 投影）；role "tool" 是工具结果行 */
export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "tool";
	text: string;
	/** role 为 "tool" 时的工具名 */
	toolName?: string;
	/** role 为 "tool" 且执行失败 */
	isError?: boolean;
}

import type { TodoState } from "./todos";

/** WS 推送的会话快照（每次 commit 一帧） */
export interface ChatSnapshot {
	type: "chat";
	messages: ChatMessage[];
	/** 有 run 在进行中 */
	busy: boolean;
	queued: number;
	/** Load older messages through HTTP instead of repeating them in every streaming frame. */
	historyBefore?: string;
	/** 正在流式生成的助手部分消息（可能不完整） */
	streamingText?: string;
	/** 最近一次失败原因（模型未配置、网络错误等） */
	lastError?: string;
	model?: ModelRef;
	/** 当前上下文的标识：reset 后为 reset 条目的 id，变化即旧上下文的消息不再适用 */
	contextId?: string;
	/** 会话任务列表（app.todos 文档投影）；模型从未调用 todo 工具时不存在 */
	todos?: TodoState;
	/** 本轮正在执行的工具名（未完成的调用）；空闲时不存在 */
	activeTools?: string[];
}

export type ServerMessage = ChatSnapshot;

/** dev 模式 sidecar 固定端口（免 token）；apps/agent main.ts 与 UI 直连共用 */
export const DEV_AGENT_PORT = 47911;

/** 自定义 OpenAI 兼容供应商定义（非密钥部分，存 providers.json；apiKey 存 auth.json） */
export interface CustomProvider {
	/** custom- 前缀 slug，避免与内置冲突 */
	id: string;
	name: string;
	baseUrl: string;
	/** 该供应商的模型 id 列表 */
	models: string[];
}

/** PUT /api/custom-providers 的请求体（upsert；apiKey 给了才更新） */
export interface CustomProviderUpsert extends CustomProvider {
	apiKey?: string;
}

export interface HistoryPage {
	messages: ChatMessage[];
	before?: string;
}
