import { invoke, isTauri } from "@tauri-apps/api/core";
import {
	DEV_AGENT_PORT,
	type ChatSnapshot,
	type ChatSubmitResult,
	type ConfigUpdate,
	type ConfigView,
	type CustomProviderUpsert,
	type HistoryPage,
	type LibraryView,
	type TopicCreated,
} from "@siftory/protocol";

type Connection = { port: number; token?: string | null };
async function connection(): Promise<Connection | undefined> {
	return isTauri() ? invoke<Connection>("agent_connection") : undefined;
}
async function request<T>(
	path: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const agent = await connection();
	const response = await fetch(
		`${agent ? `http://127.0.0.1:${agent.port}` : ""}${path}`,
		{
			method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(agent?.token ? { authorization: `Bearer ${agent.token}` } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		},
	);
	const result = await response.json().catch(() => undefined);
	if (!response.ok)
		throw new Error(result?.error ?? `请求失败（${response.status}）`);
	return result as T;
}
export const getHistory = (before: string, conversationId?: string) =>
	request<HistoryPage>(
		`/api/history?before=${encodeURIComponent(before)}${conversationId ? `&conversation=${encodeURIComponent(conversationId)}` : ""}`,
	);
export const getConfig = () => request<ConfigView>("/api/config");
export const putConfig = (update: ConfigUpdate) =>
	request<void>("/api/config", "PUT", update);
export const sendChat = (content: string, requestId: string, conversationId?: string) =>
	request<ChatSubmitResult>("/api/chat", "POST", { content, requestId, conversationId });
export const abortChat = (conversationId?: string) =>
	request<void>("/api/abort", "POST", { conversationId });
export const resetChat = () => request<void>("/api/reset", "POST");
export const createTopic = (content: string, requestId: string) =>
	request<TopicCreated>("/api/topics", "POST", { content, requestId });
export const getLibrary = () => request<LibraryView>("/api/library");
/** 取产物文件原文（markdown 预览用）；音视频落地时改返回 blob URL 喂 <audio>/<video> */
export const getArtifactText = async (topicId: string, artifactId: number) => {
	const agent = await connection();
	const response = await fetch(
		`${agent ? `http://127.0.0.1:${agent.port}` : ""}/api/topics/${encodeURIComponent(topicId)}/artifacts/${artifactId}/file`,
		{
			headers: {
				...(agent?.token ? { authorization: `Bearer ${agent.token}` } : {}),
			},
		},
	);
	if (!response.ok) throw new Error(`加载失败（${response.status}）`);
	return response.text();
};
export const upsertCustomProvider = (input: CustomProviderUpsert) =>
	request<void>("/api/custom-providers", "PUT", input);
export const deleteCustomProvider = (id: string) =>
	request<void>(`/api/custom-providers/${encodeURIComponent(id)}`, "DELETE");

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export function subscribeChat(
	onSnapshot: (snapshot: ChatSnapshot) => void,
	onStatus: (status: ConnectionStatus, error?: string) => void,
	conversationId?: string,
): () => void {
	let socket: WebSocket | undefined;
	let closed = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let delay = 500;
	const reconnect = (error?: string) => {
		if (closed) return;
		onStatus("disconnected", error);
		retry = setTimeout(() => void connect(), delay);
		delay = Math.min(delay * 2, 10_000);
	};
	const connect = async () => {
		if (closed) return;
		onStatus("connecting");
		try {
			const agent = await connection();
			if (closed) return;
			socket = new WebSocket(
				`ws://127.0.0.1:${agent?.port ?? DEV_AGENT_PORT}/ws?${[
					...(agent?.token ? [`token=${encodeURIComponent(agent.token)}`] : []),
					...(conversationId ? [`conversation=${encodeURIComponent(conversationId)}`] : []),
				].join("&")}`,
			);
			socket.onmessage = (event) => {
				try {
					const snapshot = JSON.parse(String(event.data));
					if (
						snapshot.type !== "chat" ||
						!Array.isArray(snapshot.messages) ||
						typeof snapshot.busy !== "boolean"
					)
						throw new Error("Invalid snapshot");
					delay = 500;
					onStatus("connected");
					onSnapshot(snapshot);
				} catch {
					socket?.close(1002, "Invalid snapshot");
				}
			};
			socket.onclose = () => reconnect();
			socket.onerror = () => socket?.close();
		} catch (error) {
			reconnect(error instanceof Error ? error.message : String(error));
		}
	};
	void connect();
	return () => {
		closed = true;
		clearTimeout(retry);
		socket?.close();
	};
}
