import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAgentHost } from "../src/harness";
import { TodosDoc } from "../src/extensions/todo/index";
import { createWsHandler } from "../src/server/ws";
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
