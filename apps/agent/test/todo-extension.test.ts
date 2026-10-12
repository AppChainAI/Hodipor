import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import todo, { TodosDoc } from "../src/extensions/todo/index";
import { openBunSqlite } from "../src/storage/sqlite";

/** 端到端：faux 模型发起工具调用 → commit 落文档 → 重开存储后状态还在（durable 属性） */
it("persists todo state through a scripted model tool call and a reopen", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("todo", { action: "create", subject: "写文档", blockedBy: [] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxToolCall("todo", { action: "create", subject: "发布", blockedBy: [1] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxToolCall("todo", { action: "update", id: 1, status: "in_progress", activeForm: "正在写文档" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("都记下来了。"),
	]);

	const directory = await mkdtemp(join(tmpdir(), "siftory-todo-"));
	const openStorage = () => SqliteStorage.open(openBunSqlite(join(directory, "session.sqlite")));
	const registry = createRegistry();
	registry.install(todo);
	let harness = await Harness.open(await openStorage(), { models, registry }, context);
	let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

	// 扩展被默认选中：工具与提示词节都在
	const agent = await root.agent(context);
	expect(agent.tools.map((t) => t.name)).toContain("todo");
	expect(agent.sections.map((s) => s.key)).toContain("todo_guidance");

	const submission = await root.submit({ type: "input", content: "帮我建两个任务" }, context);
	const settled = await submission.wait(context);
	expect(settled.status).toBe("done");

	const live = await harness.snapshot(TodosDoc, root.id, context);
	expect(live?.tasks.map((t) => [t.id, t.subject, t.status])).toEqual([
		[1, "写文档", "in_progress"],
		[2, "发布", "pending"],
	]);
	expect(live?.tasks[1].blockedBy).toEqual([1]);
	await harness.close(context);

	// 重开同一存储：文档状态原样回来（不需要任何回放代码）
	harness = await Harness.open(await openStorage(), { models, registry }, context);
	root = await harness.root(context);
	const restored = await harness.snapshot(TodosDoc, root.id, context);
	expect(restored?.tasks).toHaveLength(2);
	expect(restored?.nextId).toBe(3);
	await harness.close(context);
	await rm(directory, { recursive: true, force: true });
});
