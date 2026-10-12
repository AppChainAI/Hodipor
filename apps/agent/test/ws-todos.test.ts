import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAgentHost } from "../src/harness";
import { TodosDoc } from "../src/extensions/todo/index";
import { createWsHandler } from "../src/server/ws";
import { handleHttp } from "../src/server/http";
import type { ChatSnapshot } from "@siftory/protocol";

// 回归：ConversationView.docs 只挂载 pi.* 内建文档，app.todos 必须由 WS 层
// 单独读取注入——曾经从 view.docs 读，面板永远拿不到数据。
it("pushes the todos document in the WS snapshot after a todo commit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siftory-ws-"));
	const host = await createAgentHost(directory, { dev: true });
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, server) {
			return server.upgrade(req, { data: { closed: false } })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: createWsHandler(host),
	});
	try {
		await host.root.commit(async (tx) => {
			(await tx.doc(TodosDoc, host.root.id)).tasks.push({
				id: 1,
				subject: "写文档",
				status: "pending",
			});
		}, context);

		const frame = await new Promise<ChatSnapshot>((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
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
		expect(frame.todos?.tasks[0]?.subject).toBe("写文档");
	} finally {
		server.stop(true);
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// 回归：app.todos 的清空 commit 不产生视图帧（视图只挂内建 pi.* 文档），曾经
// reset 先于清空提交，reset 触发的推送带的是旧任务列表，面板要点第二次新建才消失。
it("pushes an empty todo list in the reset frame itself", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siftory-ws-"));
	const host = await createAgentHost(directory, { dev: true });
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, server) {
			return server.upgrade(req, { data: { closed: false } })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: createWsHandler(host),
	});
	const frames: ChatSnapshot[] = [];
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
	socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
	await new Promise((resolve) => {
		socket.onopen = resolve;
	});
	try {
		await host.root.commit(async (tx) => {
			(await tx.doc(TodosDoc, host.root.id)).tasks.push({
				id: 1,
				subject: "遗留任务",
				status: "pending",
			});
		}, context);
		await new Promise((resolve) => setTimeout(resolve, 300));
		frames.length = 0;

		const response = await handleHttp(
			host,
			new Request("http://localhost/api/reset", { method: "POST" }),
		);
		expect(response.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 500));

		const last = frames.at(-1);
		expect(last?.messages).toEqual([]);
		expect(last?.todos?.tasks ?? []).toEqual([]);
	} finally {
		socket.close();
		server.stop(true);
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
