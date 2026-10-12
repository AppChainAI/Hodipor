import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { ChatMessage, ChatSnapshot, ModelRef } from "@siftory/protocol";
import type { TodoState } from "@siftory/protocol/todos";

type ContentBlock = { type: string; text?: string };
type Message = { role: string; content: string | ContentBlock[] };

function extractText(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/** ConversationView（pi-durable 原始结构）→ UI 协议快照。UI 不感知 pi-durable 的 API 形状。
 *  注意：view.docs 只挂载 pi.* 内建文档（durable 的 MOUNTED 固定集合），
 *  自定义文档（app.todos 等）由调用方单独读好后作为参数传入。 */
export function projectChatView(
	view: ConversationView,
	terminalError?: string,
	todos?: TodoState,
): ChatSnapshot {
	// Bound each streaming frame to the newest 200 visible text messages.
	const selected: EntryRecord[] = [];
	let index = view.entries.length - 1;
	for (; index >= 0; index--) {
		const entry = view.entries[index];
		// 工具结果行也计入窗口：选 user/assistant 文本 + tool-result
		if (
			((entry.kind === "pi.user" || entry.kind === "pi.assistant") &&
				extractText(entry.model?.[0] as Message | undefined)) ||
			(entry.kind === "pi.tool-result" && projectToolResult(entry))
		)
			selected.push(entry);
		if (selected.length === 200) {
			index--;
			break;
		}
	}
	const messages = projectMessages(selected.reverse());

	const live = view.docs["pi.live"] as
		| {
				run?: unknown;
				generation?: { message?: Message; retry?: { error: string } };
				tools?: { name: string; status: "pending" | "running" | "done" }[];
		  }
		| undefined;
	const agent = view.docs["pi.agent"] as { model?: ModelRef } | undefined;

	// 活动转录以 head marker 开头：reset 后 entries[0] 是 pi.reset，其 id 标识新上下文。
	// shortcut: reset 后再压缩时 entries[0] 变成 pi.compaction、contextId 回落 undefined；当前产品未启用压缩，启用后需换成显式 epoch。
	const head = view.entries[0];

	return {
		type: "chat",
		messages,
		historyBefore: index >= 0 ? messages[0]?.id : undefined,
		busy: live?.run !== undefined,
		streamingText: extractText(live?.generation?.message) || undefined,
		lastError: live?.generation?.retry?.error ?? terminalError,
		queued:
			(view.docs["pi.inbox"] as { items?: unknown[] } | undefined)?.items
				?.length ?? 0,
		model: agent?.model,
		contextId: head?.kind === "pi.reset" ? String(head.id) : undefined,
		todos,
		activeTools: live?.tools?.filter((t) => t.status !== "done").map((t) => t.name),
	};
}

export function projectMessages(
	entries: readonly EntryRecord[],
): ChatMessage[] {
	return entries.flatMap((entry) => {
		if (entry.kind === "pi.tool-result") {
			const tool = projectToolResult(entry);
			return tool ? [tool] : [];
		}
		const role =
			entry.kind === "pi.user"
				? "user"
				: entry.kind === "pi.assistant"
					? "assistant"
					: undefined;
		if (!role) return [];
		const text = extractText(entry.model?.[0] as Message | undefined);
		return text ? [{ id: String(entry.id), role, text }] : [];
	});
}

/** pi.tool-result → 工具行；正文截断，避免 bash 长尾刷屏 */
function projectToolResult(entry: EntryRecord): ChatMessage | undefined {
	const message = entry.model?.[0] as
		| { role: string; toolName?: string; content?: ContentBlock[]; isError?: boolean }
		| undefined;
	if (message?.role !== "toolResult" || !message.toolName) return undefined;
	const text = extractText(message as Message);
	const bound = text.length > 800 ? `${text.slice(0, 800)}…` : text;
	return {
		id: String(entry.id),
		role: "tool",
		toolName: message.toolName,
		isError: message.isError === true,
		text: bound,
	};
}
