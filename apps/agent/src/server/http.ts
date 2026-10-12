import type { EntryId } from "@earendil-works/pi-durable";
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
import type { ChatSubmitResult, ConfigView } from "@siftory/protocol";
import type { AgentHost } from "../harness";

const context = BACKGROUND_CONTEXT;

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

const bad = (message: string, status = 400) => json({ error: message }, status);

/** HTTP 路由。WS 在 ws.ts。 */
async function route(host: AgentHost, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (req.method === "GET" && path === "/api/history") {
		const before = Number(url.searchParams.get("before"));
		if (!Number.isSafeInteger(before) || before < 2)
			return bad("Invalid history boundary");
		const page = await host.root.entries(
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
			await host.configureAgent(change);
		}
		return json({ ok: true });
	}

	if (req.method === "POST" && path === "/api/chat") {
		const body = parse(ChatSchema, await req.json());
		if (!body?.content?.trim()) return bad("content required");
		const submission = await host.root.submit(
			{ type: "input", content: body.content, requestId: body.requestId },
			context,
		);
		return json({
			submissionId: String(submission.id),
		} satisfies ChatSubmitResult);
	}

	if (req.method === "POST" && path === "/api/abort") {
		await host.root.abort(context);
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
