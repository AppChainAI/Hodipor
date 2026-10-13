import { join, resolve, basename, extname, sep } from "node:path";
import { mkdir, rename, stat, readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
	createRegistry,
	Harness,
	type AgentChange,
	type SubmissionRecord,
	type Conversation,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentConfigView, CustomProvider } from "@siftory/protocol";
import { authFile, FileCredentialStore } from "./config";
import {
	loadCustomProviders,
	registerCustomProvider,
	saveCustomProviders,
	unregisterCustomProvider,
} from "./custom-providers";
import { installAll } from "./extensions";
import { acquireOwnership } from "./storage/ownership";
import { openBunSqlite } from "./storage/sqlite";
import { openAppDb, type AppDb, type TopicRow, type ArtifactRow } from "./storage/appdb";
import type { ConversationId } from "@earendil-works/pi-durable";

export interface AgentHost {
	harness: Harness;
	root: Conversation;
	models: MutableModels;
	credentials: FileCredentialStore;
	/** 已注册的提供商 id（含 dev 的 faux），供配置界面枚举 */
	providerIds: string[];
	/** 提供商的模型目录（静态目录直读，不需要密钥；动态目录为上次刷新结果） */
	catalogModels(providerId: string): string[];
	/** 自定义供应商 CRUD：写 providers.json + live 注册/注销，无需重启 */
	listCustomProviders(): CustomProvider[];
	upsertCustomProvider(custom: CustomProvider, apiKey?: string): Promise<void>;
	deleteCustomProvider(id: string): Promise<void>;
	/** 会话级 LLM 配置：改的是 root 的 pi.agent 文档（SQLite 持久） */
	getAgent(): Promise<AgentConfigView>;
	configureAgent(change: AgentChange): Promise<void>;
	latestSubmission(conversationId?: ConversationId): Promise<SubmissionRecord | undefined>;
	/** 按 id 取会话（选题）；不存在返回 undefined */
	conversation(id: string): Promise<Conversation | undefined>;
	/** 有活跃任务或未安置提交的会话 id 集（单并发判定 + 库级忙态） */
	busyConversationIds(): Promise<Set<string>>;
	/** 新建选题：分配 workspace/topics/<slug>-<id8>/ 目录并绑定 cwd，复制 root 的模型配置 */
	createTopic(content: string): Promise<TopicRow>;
	getTopic(id: string): TopicRow | undefined;
	listTopics(): TopicRow[];
	listArtifacts(topicId: string): ArtifactRow[];
	/** 选题目录的绝对路径 */
	topicDir(topic: TopicRow): string;
	/** 登记产物：校验路径在选题目录内 → 移入 artifacts/ → 写索引。失败抛 Error（文案面向模型/用户） */
	registerArtifact(
		conversationId: ConversationId,
		args: { path: string; type: string; stage: string; title?: string },
	): Promise<ArtifactRow>;
	close(): Promise<void>;
}

const context = BACKGROUND_CONTEXT;

export async function createAgentHost(
	dataDir: string,
	options: { dev?: boolean } = {},
): Promise<AgentHost> {
	const release = acquireOwnership(dataDir);
	try {
		const host = await openHost(dataDir, options);
		const close = host.close;
		let closing: Promise<void> | undefined;
		host.close = () => (closing ??= close().finally(release));
		return host;
	} catch (error) {
		release();
		throw error;
	}
}

async function openHost(
	dataDir: string,
	options: { dev?: boolean },
): Promise<AgentHost> {
	const credentials = new FileCredentialStore(authFile(dataDir));

	const models = createModels({ credentials });
	// 提供商目录：env 变量也可作为密钥来源（pi-ai 的 resolve 合并 stored credential 与环境变量）。
	// catalogs 保留 Provider 引用：模型目录与 auth 解耦，下拉列表不需要先存密钥。
	const catalogs = new Map<string, () => readonly { id: string }[]>();
	const register = (id: string, provider: Provider) => {
		models.setProvider(provider);
		catalogs.set(id, () => provider.getModels());
	};
	register("openai", openaiProvider());
	register("anthropic", anthropicProvider());
	register("google", googleProvider());
	register("deepseek", deepseekProvider());
	register("openrouter", openrouterProvider());
	const providerIds = [
		"openai",
		"anthropic",
		"google",
		"deepseek",
		"openrouter",
	];
	if (options.dev) {
		// 开发用假模型：无密钥也能跑通全链路（faux/faux-1）
		const faux = fauxProvider({ tokensPerSecond: 40 });
		register("faux", faux.provider);
		// 自我补充的回声响应：每次被消费后重新入队，队列永不空
		const respond: FauxResponseFactory = (ctx) => {
			faux.appendResponses([respond]);
			const last = ctx.messages.findLast((m) => m.role === "user");
			const text = typeof last?.content === "string" ? last.content : "";
			// 加长尾巴让 dev 下能看到流式效果（faux 40 tokens/s）
			return fauxAssistantMessage(
				`[faux] 收到：${text || "（空）"}\n\n这是一段用于演示流式输出的占位回答。`.repeat(
					3,
				),
			);
		};
		faux.setResponses([respond]);
		providerIds.push("faux");
	}

	const registry = createRegistry();

	// 自定义 OpenAI 兼容供应商（providers.json）
	let customProviders = await loadCustomProviders(dataDir);
	let mutation: Promise<unknown> = Promise.resolve();
	const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = mutation.then(fn);
		mutation = next.catch(() => {});
		return next;
	};
	for (const custom of customProviders) {
		const provider = registerCustomProvider(models, custom);
		catalogs.set(custom.id, () => provider.getModels());
		providerIds.push(custom.id);
	}

	const storage = await SqliteStorage.open(
		openBunSqlite(join(dataDir, "siftory.sqlite")),
	);
	const appdb = openAppDb(dataDir);
	// 文件/命令工具的工作目录：会话未设 cwd 时用数据目录下的 workspace/
	// 必须归一为绝对路径：dataDir 可能是相对路径（dev 默认 .data），相对 base 会让
	// registerArtifact 的 startsWith 守卫把合法路径全部误判越界（resolve 后的绝对 src 永远不以相对 base 开头）
	const workspace = resolve(join(dataDir, "workspace"));
	await mkdir(workspace, { recursive: true });
	const harness = await Harness.open(storage, {
		models,
		registry,
		// 必须绝对路径：bash 工具会把 env.cwd 回传给 exec 再次解析，相对 cwd 会被拼接两次
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? workspace) }),
	}, context);
	const root = await harness.root(context);
	// Configure defaults before resuming pending work.

	// 模型选择存在 root 的 pi.agent 里，重启自动保留；只有从未配置过时 dev 才兜底 faux
	const resolved = await root.agent(context);
	if (!resolved.model && options.dev) {
		await root.configure(
			{ model: { provider: "faux", modelId: "faux-1" } },
			context,
		);
	}

	harness.resume();

	const topicDir = (topic: TopicRow) => join(workspace, topic.dir);
	const registerArtifact: AgentHost["registerArtifact"] = async (
		conversationId,
		args,
	) => {
		const topic = appdb.getTopic(String(conversationId));
		if (!topic) throw new Error("当前会话不是选题，无法登记产物");
		const base = topicDir(topic);
		const src = resolve(base, args.path);
		if (src !== base && !src.startsWith(base + sep))
			throw new Error(`路径必须在选题目录内：${args.path}`);
		const info = await stat(src).catch(() => undefined);
		if (!info?.isFile()) throw new Error(`文件不存在：${args.path}`);
		const artifactsDir = join(base, "artifacts");
		await mkdir(artifactsDir, { recursive: true });
		const ext = extname(src);
		const stem = basename(src, ext);
		// 已在 artifacts/ 里的文件不再移动（模型直接写进产物目录是合理的，重复登记也不改名）
		const alreadyInPlace = resolve(src) === resolve(join(artifactsDir, basename(src)));
		let name = basename(src);
		if (!alreadyInPlace) {
			for (let n = 2; ; n++) {
				const exists = await stat(join(artifactsDir, name)).catch(() => undefined);
				if (!exists) break;
				name = `${stem}-${n}${ext}`;
			}
			await rename(src, join(artifactsDir, name));
		}
		const relPath = `artifacts/${name}`;
		const title = args.title?.trim() || stem;
		let excerpt: string | null = null;
		if (info.size <= 256 * 1024 && [".md", ".markdown", ".txt"].includes(ext.toLowerCase())) {
			const text = await readFile(join(artifactsDir, name), "utf8").catch(() => "");
			excerpt = text.replace(/\s+/g, " ").trim().slice(0, 300) || null;
		}
		const id = appdb.insertArtifact({
			topic_id: topic.id,
			type: args.type,
			stage: args.stage,
			title,
			rel_path: relPath,
			size: info.size,
			excerpt,
		});
		return {
			id,
			topic_id: topic.id,
			type: args.type,
			stage: args.stage,
			title,
			rel_path: relPath,
			size: info.size,
			excerpt,
			created_at: Date.now(),
		};
	};
	// 扩展安装需要 appdb 与选题目录就位；agent 在每次运行时对注册表快照惰性解析，此处安装即对所有会话生效
	installAll(registry, { artifacts: { registerArtifact } });

	return {
		harness,
		root,
		models,
		credentials,
		providerIds,
		catalogModels: (id) =>
			catalogs
				.get(id)?.()
				.map((m) => m.id) ?? [],
		listCustomProviders: () => structuredClone(customProviders),
		upsertCustomProvider: (custom, apiKey) =>
			serialize(async () => {
				const next = customProviders
					.filter((p) => p.id !== custom.id)
					.concat(structuredClone(custom));
				await saveCustomProviders(dataDir, next);
				try {
					if (apiKey)
						await credentials.modify(custom.id, async () => ({
							type: "api_key",
							key: apiKey,
						}));
				} catch (error) {
					await saveCustomProviders(dataDir, customProviders);
					throw error;
				}
				customProviders = next;
				const provider = registerCustomProvider(models, custom);
				catalogs.set(custom.id, () => provider.getModels());
				if (!providerIds.includes(custom.id)) providerIds.push(custom.id);
			}),
		deleteCustomProvider: (id) =>
			serialize(async () => {
				if (!customProviders.some((p) => p.id === id))
					throw new Error("Unknown custom provider");
				if ((await root.agent(context)).model?.provider === id)
					throw new Error("Select another model before deleting its provider");
				const next = customProviders.filter((p) => p.id !== id);
				// Persist the definition first; rollback it if the credential operation fails.
				await saveCustomProviders(dataDir, next);
				try {
					await credentials.delete(id);
				} catch (error) {
					await saveCustomProviders(dataDir, customProviders);
					throw error;
				}
				customProviders = next;
				const i = providerIds.indexOf(id);
				if (i >= 0) providerIds.splice(i, 1);
				catalogs.delete(id);
				unregisterCustomProvider(models, id);
			}),
		getAgent: async () => {
			const agent = await root.agent(context);
			return {
				model: agent.model,
				thinkingLevel: agent.thinkingLevel,
				instructions: agent.instructions,
			};
		},
		configureAgent: (change) => root.configure(change, context),
		latestSubmission: async (conversationId) =>
			(
				await storage.scanSubmissions(
					{ conversationId: conversationId ?? root.id, order: "descending" },
					1,
					undefined,
					context,
				)
			).items[0],
		conversation: (id) =>
			harness.conversation(Number(id) as ConversationId, context),
		busyConversationIds: async () => {
			const inspection = await harness.inspect(context);
			const ids = new Set<string>();
			for (const task of inspection.tasks)
				if (task.record.conversationId) ids.add(String(task.record.conversationId));
			for (const submission of inspection.submissions)
				ids.add(String(submission.conversationId));
			return ids;
		},
		createTopic: async (content) => {
			const firstLine = content.trim().split("\n", 1)[0].trim();
			const title =
				firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
			const agent = await root.agent(context);
			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: agent.model,
						thinkingLevel: agent.thinkingLevel,
						instructions: agent.instructions,
					},
				},
				context,
			);
			const id = String(conversation.id);
			// 目录名用会话 id：slug 化的标题在真实输入下不产生可读性（祈使句/URL），
			// 还会引入 CJK 归一化（NFD/NFC）路径比较风险；可读性由 DB 标题与 UI 承担
			const dir = `topics/${id}`;
			await mkdir(join(workspace, dir), { recursive: true });
			await conversation.configure({ cwd: join(workspace, dir) }, context);
			const topic: TopicRow = { id, title, dir, created_at: Date.now() };
			appdb.insertTopic(topic);
			return topic;
		},
		getTopic: (id) => appdb.getTopic(id),
		listTopics: () => appdb.listTopics(),
		listArtifacts: (topicId) => appdb.listArtifacts(topicId),
		topicDir,
		registerArtifact,
		close: async () => {
			await harness.close(context);
			appdb.close();
		},
	};
}
