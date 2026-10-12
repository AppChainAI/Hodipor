import { expect, it } from "bun:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { projectChatView } from "../src/server/projection";

it("projects tool results as rows and live tool names into the snapshot", () => {
	const toolEntry = {
		kind: "pi.tool-result",
		id: 9,
		model: [
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
		],
	};
	const view = {
		entries: [toolEntry],
		docs: { "pi.live": { run: {}, tools: [{ name: "bash", status: "running" }, { name: "todo", status: "done" }] } },
	} as unknown as ConversationView;
	const snapshot = projectChatView(view);
	expect(snapshot.messages[0]).toMatchObject({ role: "tool", toolName: "bash", text: "ok" });
	expect(snapshot.activeTools).toEqual(["bash"]);
	expect(snapshot.busy).toBe(true);
});

it("passes the separately-read app.todos document into the snapshot", () => {
	// view.docs 只含 pi.* 内建文档（durable 的 MOUNTED 固定集合）；
	// app.todos 由 ws.ts 用 harness.snapshot 单独读，作为第三参数传入。
	const base = { entries: [], docs: {} } as unknown as ConversationView;
	expect(projectChatView(base).todos).toBeUndefined();

	const todos = { tasks: [{ id: 1, subject: "写文档", status: "pending" as const }], nextId: 2 };
	expect(projectChatView(base, undefined, todos).todos?.tasks[0].subject).toBe("写文档");
});
