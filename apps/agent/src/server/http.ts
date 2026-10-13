import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { projectMessages } from "./projection";
import { TodosDoc } from "../extensions/todo/index";
import {
	ChatSchema,
	ConfigSchema,
	CustomProviderUpsertSchema,
	parse,
	validateProviderUrl,
} from "@siftory/protocol/schemas";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ChatSubmitResult, ConfigView, LibraryView, TopicCreated } from "@siftory/protocol";
import type { AgentHost } from "../harness";
import { extname, join, resolve, sep } from "node:path";

const context = BACKGROUND_CONTEXT;

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

const bad = (message: string, status = 400) => json({ error: message }, status);

const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".pdf": "application/pdf",
};

/** 按可选 conversationId 解析目标会话；缺省 root。id 给了但不存在时抛 404 语义错误 */
async function target(host: AgentHost, id: string | undefined) {
	if (!id) return host.root;
	const conversation = await host.conversation(id);
	if (!conversation) throw Object.assign(new Error("会话不存在"), { status: 404 });
	return conversation;
}

/** HTTP 路由。WS 在 ws.ts。 */
async function route(host: AgentHost, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (req.method === "GET" && path === "/api/history") {
		const before = Number(url.searchParams.get("before"));
		if (!Number.isSafeInteger(before) || before < 2)
			return bad("Invalid history boundary");
		const conversation = await target(
			host,
			url.searchParams.get("conversation") ?? undefined,
		);
		const page = await conversation.entries(
			{ maxEntryId: (before - 1) as EntryId },
			100,
			undefined,
			context,
		);
		const entries = [...page.items].reverse();
		return json({
			messages: projectMessages(entries),
			before: page.next ? String(entries[0]?.id) : undefined,
		});
	}

	if (req.method === "GET" && path === "/api/health") return json({ ok: true });

	if (req.method === "GET" && path === "/api/config") {
		const statuses = await Promise.all(
			host.providerIds.map(async (id) => {
				const auth = await host.models.getAuth(id).catch(() => undefined);
				return {
					status: { id, name: id, configured: auth !== undefined },
					// 目录直读，与 auth 解耦：没存密钥也能列出模型（静态目录内置；动态目录为上次刷新）
					models: host.catalogModels(id),
				};
			}),
		);
		const view: ConfigView = {
			providers: statuses.map((s) => s.status),
			models: Object.fromEntries(statuses.map((s) => [s.status.id, s.models])),
			agent: await host.getAgent(),
			customProviders: host.listCustomProviders(),
		};
		return json(view);
	}

	if (req.method === "PUT" && path === "/api/config") {
		const body = parse(ConfigSchema, await req.json());
		if (body.provider && !host.providerIds.includes(body.provider.id))
			return bad("Unknown provider");
		if (
			body.agent?.model &&
			!host.models.getModel(body.agent.model.provider, body.agent.model.modelId)
		)
			return bad("Unknown model");
		if (body.provider) {
			const { id, apiKey } = body.provider;
			if (!id || !apiKey)
				return bad("provider.id and provider.apiKey required");
			await host.credentials.modify(id, async () => ({
				type: "api_key",
				key: apiKey,
			}));
		}
		if (body.agent) {
			const { model, thinkingLevel, instructions } = body.agent;
			const change: Record<string, unknown> = {};
			if (model) change.model = model;
			if (thinkingLevel) change.thinkingLevel = thinkingLevel;
			if (instructions !== undefined)
				change.instructions = instructions || null; // 空串 = 清除
			if (body.conversationId) {
				const conversation = await target(host, body.conversationId);
				await conversation.configure(change, context);
			} else {
				await host.configureAgent(change);
			}
		}
		return json({ ok: true });
	}

	// 新建选题：单并发——有任何会话在忙就拒绝（含排队中的提交）
	if (req.method === "POST" && path === "/api/topics") {
		const body = parse(ChatSchema, await req.json());
		if (!body?.content?.trim()) return bad("content required");
		if ((await host.busyConversationIds()).size > 0)
			return bad("已有选题进行中，请等待完成或先停止", 409);
		const topic = await host.createTopic(body.content.trim());
		const conversation = await target(host, topic.id);
		await conversation.submit(
			{ type: "input", content: body.content, requestId: body.requestId },
			context,
		);
		return json({ topicId: topic.id, title: topic.title } satisfies TopicCreated);
	}

	// 库级视图：全部选题 + 忙态 + 失败信号 + 产物索引
	if (req.method === "GET" && path === "/api/library") {
		const busy = await host.busyConversationIds();
		const view: LibraryView = {
			topics: await Promise.all(
				host.listTopics().map(async (topic) => {
					const latest = await host.latestSubmission(
						Number(topic.id) as ConversationId,
					);
					return {
						id: topic.id,
						title: topic.title,
						createdAt: topic.created_at,
						busy: busy.has(topic.id),
						failed:
							latest?.status === "unanswered" && latest.reason !== "aborted",
						artifacts: host.listArtifacts(topic.id).map((artifact) => ({
							id: artifact.id,
							type: artifact.type,
							stage: artifact.stage,
							title: artifact.title,
							relPath: artifact.rel_path,
							size: artifact.size,
							...(artifact.excerpt ? { excerpt: artifact.excerpt } : {}),
							createdAt: artifact.created_at,
						})),
					};
				}),
			),
		};
		return json(view);
	}

	// 产物文件：只服务索引里登记过的 rel_path，天然限在选题目录内
	if (req.method === "GET" && /^\/api\/topics\/[^/]+\/artifacts\/\d+\/file$/.test(path)) {
		const [, topicId, artifactId] =
			path.match(/^\/api\/topics\/([^/]+)\/artifacts\/(\d+)\/file$/) ?? [];
		const topic = host.getTopic(decodeURIComponent(topicId));
		const artifact = topic && host.listArtifacts(topic.id).find((a) => a.id === Number(artifactId));
		if (!topic || !artifact) return bad("产物不存在", 404);
		const file = resolve(join(host.topicDir(topic), artifact.rel_path));
		if (!file.startsWith(host.topicDir(topic) + sep)) return bad("产物不存在", 404);
		const type = ARTIFACT_CONTENT_TYPES[extname(file).toLowerCase()];
		return new Response(Bun.file(file), {
			headers: {
				...(type ? { "content-type": type } : {}),
				"x-content-type-options": "nosniff",
			},
		});
	}

	if (req.method === "POST" && path === "/api/chat") {
		const body = parse(ChatSchema, await req.json());
		if (!body?.content?.trim()) return bad("content required");
		// 单并发：别的会话在忙时，只允许向忙会话本身排队
		const busy = await host.busyConversationIds();
		const conversation = await target(host, body.conversationId);
		if (busy.size > 0 && !(busy.size === 1 && busy.has(String(conversation.id))))
			return bad("已有选题进行中，请等待完成或先停止", 409);
		const submission = await conversation.submit(
			{ type: "input", content: body.content, requestId: body.requestId },
			context,
		);
		return json({
			submissionId: String(submission.id),
		} satisfies ChatSubmitResult);
	}

	if (req.method === "POST" && path === "/api/abort") {
		const body = (await req.json().catch(() => undefined)) as
			| { conversationId?: string }
			| undefined;
		const conversation = await target(host, body?.conversationId);
		await conversation.abort(context);
		return json({ ok: true });
	}

	// 新会话：同一 root 开新上下文（模型不再看到旧条目；条目保留在存储中）
	if (req.method === "POST" && path === "/api/reset") {
		// 产品策略：新会话从空任务列表开始。必须先清空再 reset：app.todos 的 commit
		// 不产生 WS 帧（视图只挂内建文档），reset 触发的推送才会带上空列表
		await host.root.commit(async (tx) => {
			const doc = await tx.doc(TodosDoc, host.root.id);
			doc.tasks = [];
			doc.nextId = 1;
		}, context);
		await host.root.reset(undefined, context);
		return json({ ok: true });
	}

	// 自定义 OpenAI 兼容供应商：upsert（apiKey 给了才更新）
	if (req.method === "PUT" && path === "/api/custom-providers") {
		const body = parse(CustomProviderUpsertSchema, await req.json());
		validateProviderUrl(body.baseUrl);
		await host.upsertCustomProvider(
			{
				id: body.id,
				name: body.name || body.id,
				baseUrl: body.baseUrl,
				models: body.models,
			},
			body.apiKey || undefined,
		);
		return json({ ok: true });
	}

	if (req.method === "DELETE" && path.startsWith("/api/custom-providers/")) {
		const id = decodeURIComponent(path.slice("/api/custom-providers/".length));
		if (!/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
			return bad("Invalid custom provider id");
		if (!host.listCustomProviders().some((provider) => provider.id === id))
			return bad("供应商不存在", 404);
		if ((await host.getAgent()).model?.provider === id)
			return bad("请先切换模型，再删除当前供应商", 409);
		await host.deleteCustomProvider(id);
		return json({ ok: true });
	}

	return bad("not found", 404);
}

export async function handleHttp(
	host: AgentHost,
	req: Request,
): Promise<Response> {
	try {
		return await route(host, req);
	} catch (error) {
		const status = (error as { status?: number })?.status;
		if (typeof status === "number")
			return bad(error instanceof Error ? error.message : "操作失败", status);
		if (
			error instanceof SyntaxError ||
			(error instanceof Error &&
				/Invalid request|Invalid URL|Provider URL/.test(error.message))
		)
			return bad("Invalid request");
		console.error("Agent request failed", error);
		return bad("操作失败，请检查配置或重试", 500);
	}
}
