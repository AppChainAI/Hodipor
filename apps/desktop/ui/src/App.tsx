import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatSnapshot, ChatMessage } from "@siftory/protocol";
import {
	abortChat,
	getHistory,
	resetChat,
	sendChat,
	subscribeChat,
	type ConnectionStatus,
} from "./api/client";
import { Composer } from "./components/Composer";
import { SettingsPanel } from "./components/SettingsPanel";

export function App() {
	const [snapshot, setSnapshot] = useState<ChatSnapshot>();
	const [connectionError, setConnectionError] = useState<string>();
	const [connection, setConnection] = useState<ConnectionStatus>("connecting");
	const [showSettings, setShowSettings] = useState(false);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [historyBefore, setHistoryBefore] = useState<string>();
	const [historyError, setHistoryError] = useState<string>();
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [resetError, setResetError] = useState<string>();
	const historyLoaded = useRef(false);
	// 当前上下文的标识（快照 contextId）；reset 后变化，本地累积的消息随之作废
	const contextId = useRef<string | undefined>(undefined);
	const followOutput = useRef(true);
	const historyScroll = useRef<{ top: number; height: number } | undefined>(
		undefined,
	);
	const mainRef = useRef<HTMLElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	const merge = (incoming: ChatMessage[]) =>
		setMessages((previous) =>
			[
				...new Map(
					[...previous, ...incoming].map((message) => [message.id, message]),
				).values(),
			].sort((a, b) => Number(a.id) - Number(b.id)),
		);
	useEffect(
		() =>
			subscribeChat(
				(next) => {
					setSnapshot(next);
					if (next.contextId !== contextId.current) {
						// 上下文切换（新会话）：本地状态整体替换，不做按 id 合并
						contextId.current = next.contextId;
						historyLoaded.current = false;
						setHistoryError(undefined);
						setMessages(next.messages);
						setHistoryBefore(next.historyBefore);
						return;
					}
					merge(next.messages);
					if (!historyLoaded.current) setHistoryBefore(next.historyBefore);
				},
				(status, error) => {
					setConnection(status);
					setConnectionError(error);
				},
			),
		[],
	);
	const loadHistory = async () => {
		if (!historyBefore || loadingHistory) return;
		setLoadingHistory(true);
		setHistoryError(undefined);
		const contextAtLoad = contextId.current;
		try {
			const page = await getHistory(historyBefore);
			if (contextId.current !== contextAtLoad) return; // 加载期间切换了会话，丢弃旧分页
			if (mainRef.current)
				historyScroll.current = {
					top: mainRef.current.scrollTop,
					height: mainRef.current.scrollHeight,
				};
			historyLoaded.current = true;
			merge(page.messages);
			setHistoryBefore(page.before);
		} catch (error) {
			setHistoryError(error instanceof Error ? error.message : "历史加载失败");
		} finally {
			setLoadingHistory(false);
		}
	};
	useLayoutEffect(() => {
		if (mainRef.current && historyScroll.current) {
			mainRef.current.scrollTop =
				historyScroll.current.top +
				mainRef.current.scrollHeight -
				historyScroll.current.height;
			historyScroll.current = undefined;
		}
	}, [messages]);
	useEffect(() => {
		// 花括号必需：表达式体会把 scrollIntoView 的返回值当 cleanup，React 报 "destroy is not a function"
		if (followOutput.current)
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [snapshot]);

	const busy = snapshot?.busy ?? false;

	return (
		<div className="app">
			<header>
				<h1 className="brand">
					<img className="brand-logo" src="/logo.png" alt="" width={32} height={32} />
					Siftory
				</h1>
				<span className="model">
					{snapshot?.model
						? `${snapshot.model.provider}/${snapshot.model.modelId}`
						: "未配置模型"}
				</span>
				<button
					className="link"
					onClick={() => {
						setResetError(undefined);
						void resetChat().catch((error: unknown) =>
							setResetError(
								error instanceof Error ? error.message : "操作失败，请重试",
							),
						);
					}}
				>
					新会话
				</button>
				{resetError && (
					<span className="error" role="alert">
						{resetError}
					</span>
				)}
				<button className="link" onClick={() => setShowSettings(!showSettings)}>
					{showSettings ? "返回对话" : "设置"}
				</button>
			</header>

			{showSettings ? (
				<SettingsPanel onSaved={() => {}} />
			) : (
				<>
					<main
						ref={mainRef}
						onScroll={(event) => {
							const element = event.currentTarget;
							followOutput.current =
								element.scrollHeight -
									element.scrollTop -
									element.clientHeight <
								100;
						}}
					>
						{historyBefore && (
							<button
								className="link"
								disabled={loadingHistory}
								onClick={() => void loadHistory()}
							>
								{loadingHistory ? "加载中…" : "加载更早的消息"}
							</button>
						)}
						{historyError && (
							<div className="error" role="alert">
								{historyError}
							</div>
						)}
						{connection !== "connected" && (
							<div role="status">
								{connection === "connecting"
									? "正在连接…"
									: (connectionError ?? "连接中断，正在重试…")}
							</div>
						)}
						{!!snapshot?.queued && (
							<div className="hint">排队消息：{snapshot.queued}</div>
						)}
						{messages.map((m) => (
							<div key={m.id} className={`message ${m.role}`}>
								<div className="bubble">{m.text}</div>
							</div>
						))}
						{busy && (
							<div className="message assistant">
								<div className="bubble pending">
									{snapshot?.streamingText || "思考中…"}
								</div>
							</div>
						)}
						{snapshot?.lastError && (
							<div className="error">
								出错：
								{{
									no_model: "请先在设置中选择模型",
									error: "模型请求失败，请检查配置后重试",
								}[snapshot.lastError] ?? snapshot.lastError}
							</div>
						)}
						<div ref={bottomRef} />
					</main>
					<Composer
						connected={connection === "connected"}
						busy={busy}
						onSend={sendChat}
						onStop={abortChat}
					/>
				</>
			)}
		</div>
	);
}
