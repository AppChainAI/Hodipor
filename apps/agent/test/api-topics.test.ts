import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentHost } from "../src/harness";
import { handleHttp } from "../src/server/http";
import { createWsHandler } from "../src/server/ws";
import type { ChatSnapshot, LibraryView, TopicCreated } from "@siftory/protocol";

const call = (host: Awaited<ReturnType<typeof createAgentHost>>, path: string, method = "GET", body?: unknown) =>
	handleHttp(
		host,
		new Request(`http://test${path}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);

it("serves topic creation, single-concurrency guard, library view and artifact files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siftory-api-"));
	const host = await createAgentHost(directory, { dev: true });
	try {
		// 新建选题：创建会话 + 提交首条消息（faux 模型随即开跑）
		const created = await call(host, "/api/topics", "POST", {
			content: "研究固态电池，写成报告",
			requestId: "r1",
		});
		expect(created.status).toBe(200);
		const topic = (await created.json()) as TopicCreated;
		expect(topic.title).toContain("固态电池");

		// 单并发：另一个新选题被拒；向别的会话发消息被拒；向忙会话本身可排队
		expect((await call(host, "/api/topics", "POST", { content: "再来一个" })).status).toBe(409);
		expect(
			(await call(host, "/api/chat", "POST", { content: "插话", conversationId: String(host.root.id) })).status,
		).toBe(409);
		expect(
			(await call(host, "/api/chat", "POST", { content: "补充：侧重中国市场", conversationId: topic.topicId })).status,
		).toBe(200);

		// 库级视图：选题在忙、无产物、无失败
		const library = (await (await call(host, "/api/library")).json()) as LibraryView;
		const row = library.topics.find((t) => t.id === topic.topicId);
		expect(row?.busy).toBe(true);
		expect(row?.failed).toBe(false);
		expect(row?.artifacts).toEqual([]);

		// 停止后忙态解除，aborted 不算失败
		await call(host, "/api/abort", "POST", { conversationId: topic.topicId });
		const idle = (await (await call(host, "/api/library")).json()) as LibraryView;
		const idleRow = idle.topics.find((t) => t.id === topic.topicId);
		expect(idleRow?.busy).toBe(false);
		expect(idleRow?.failed).toBe(false);

		// 产物文件路由：登记过的产物可读，未登记的 404
		const dir = host.topicDir(host.getTopic(topic.topicId)!);
		await writeFile(join(dir, "report.md"), "# 报告\n\n正文。");
		const artifact = await host.registerArtifact(
			(await host.conversation(topic.topicId))!.id,
			{ path: "report.md", type: "report", stage: "synthesize" },
		);
		const file = await call(host, `/api/topics/${topic.topicId}/artifacts/${artifact.id}/file`);
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toContain("text/markdown");
		expect(await file.text()).toContain("报告");
		expect((await call(host, `/api/topics/${topic.topicId}/artifacts/999/file`)).status).toBe(404);
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("subscribes a topic conversation over WS", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siftory-api-ws-"));
	const host = await createAgentHost(directory, { dev: true });
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, server) {
			const conversationId = new URL(req.url).searchParams.get("conversation") ?? undefined;
			return server.upgrade(req, { data: { closed: false, conversationId } })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: createWsHandler(host),
	});
	try {
		const topic = await host.createTopic("WS 订阅测试选题");
		const frame = await new Promise<ChatSnapshot>((resolve, reject) => {
			const socket = new WebSocket(
				`ws://127.0.0.1:${server.port}/ws?conversation=${encodeURIComponent(topic.id)}`,
			);
			const timer = setTimeout(() => reject(new Error("WS frame timeout")), 5000);
			socket.onmessage = (event) => {
				clearTimeout(timer);
				socket.close();
				resolve(JSON.parse(String(event.data)));
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error("WS connect failed"));
			};
		});
		expect(frame.type).toBe("chat");
		expect(frame.messages).toEqual([]);
		// 未知会话：拒绝升级后的语义是关闭
		const closed = await new Promise<number>((resolve) => {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?conversation=999999`);
			socket.onclose = (event) => resolve(event.code);
			socket.onerror = () => {};
		});
		expect(closed).toBe(1008);
	} finally {
		server.stop(true);
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
