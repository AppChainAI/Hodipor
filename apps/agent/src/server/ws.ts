import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ServerWebSocket } from "bun";
import type { AgentHost } from "../harness";
import type { ConversationView } from "@earendil-works/pi-durable";
import { projectChatView } from "./projection";
import { TodosDoc } from "../extensions/todo/index";

const context = BACKGROUND_CONTEXT;
type Connection = {
	closed: boolean;
	conversationId?: string;
	stop?: () => Promise<unknown>;
	pending?: string;
};

/** Serialized committed watches coalesce slow consumers to the latest full snapshot. */
export function createWsHandler(host: AgentHost) {
	const send = (ws: ServerWebSocket<Connection>, frame: string) => {
		if (ws.data.closed) return;
		if (ws.getBufferedAmount() > 0) {
			ws.data.pending = frame;
			return;
		}
		ws.send(frame);
	};
	return {
		async open(ws: ServerWebSocket<Connection>) {
			try {
				const conversation = ws.data.conversationId
					? await host.conversation(ws.data.conversationId)
					: host.root;
				if (!conversation) {
					ws.close(1008, "Unknown conversation");
					return;
				}
				const conversationId = conversation.id;
				const watch = await conversation.watch(context);
				ws.data.stop = () => watch.stop();
				if (ws.data.closed) {
					await watch.stop();
					return;
				}
				const publish = async (value: ConversationView) => {
					const latest = await host.latestSubmission(conversationId);
					const user = value.entries.findLast((e) => e.kind === "pi.user");
					const error =
						latest?.status === "unanswered" &&
						latest.reason !== "aborted" &&
						latest.entry === user?.id
							? latest.reason
							: undefined;
					// ConversationView.docs 只挂载 pi.* 内建文档，自定义文档单独读
					const todos = await host.harness.snapshot(TodosDoc, conversationId, context);
					send(ws, JSON.stringify(projectChatView(value, error, todos ?? undefined)));
				};
				await publish(watch.value);
				if (!ws.data.closed) watch.start(publish);
			} catch {
				ws.close(1011, "Cannot watch conversation");
			}
		},
		drain(ws: ServerWebSocket<Connection>) {
			if (ws.data.pending) {
				const frame = ws.data.pending;
				ws.data.pending = undefined;
				send(ws, frame);
			}
		},
		close(ws: ServerWebSocket<Connection>) {
			ws.data.closed = true;
			void ws.data.stop?.().catch(() => {});
		},
		message() {},
	};
}
