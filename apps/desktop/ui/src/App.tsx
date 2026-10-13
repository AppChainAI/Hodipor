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
import { EmptyState } from "./components/EmptyState";
import { Markdown } from "./components/Markdown";
import { TodoPanel } from "./components/TodoPanel";
import { ToolMessage } from "./components/ToolMessage";
import { SettingsPanel } from "./components/SettingsPanel";
import { Button } from "./components/ui/button";
import { Alert, AlertDescription } from "./components/ui/alert";

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
	const [composerSeed, setComposerSeed] = useState<{ text: string; id: number }>();
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
			bottomRef.current?.scrollIntoView({
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			});
	}, [snapshot]);

	const busy = snapshot?.busy ?? false;
	const modelLabel = snapshot?.model
		? `${snapshot.model.provider}/${snapshot.model.modelId}`
		: "未配置模型";
	const connectionLabel =
		connection === "connected"
			? "已连接"
			: connection === "connecting"
				? "连接中"
				: "已断开";

	return (
		<div className="app">
			<header className="app-header">
				<h1 className="brand">
					<img className="brand-logo" src="/logo.png" alt="" width={32} height={32} />
					Siftory
				</h1>
				<span className="status-chip" title={`${modelLabel} · ${connectionLabel}`}>
					<span className="status-dot" data-state={connection} />
					<span className="status-model">
						{snapshot?.model ? snapshot.model.modelId : "未配置模型"}
					</span>
					{!!snapshot?.queued && (
						<span className="status-queued">排队 {snapshot.queued}</span>
					)}
				</span>
				<Button
					variant="ghost"
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
				</Button>
				{resetError && (
					<Alert variant="destructive" className="w-auto"><AlertDescription>{resetError}</AlertDescription></Alert>
				)}
				<Button variant="ghost" onClick={() => setShowSettings(true)}>
					设置
				</Button>
			</header>

			<SettingsPanel open={showSettings} onOpenChange={setShowSettings} />

			<>
				<main
						className="conversation"
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
						{messages.length === 0 && !busy && !historyBefore && (
							<EmptyState onPick={(text) => setComposerSeed({ text, id: Date.now() })} />
						)}
						{historyBefore && (
							<Button
								variant="ghost"
								disabled={loadingHistory}
								onClick={() => void loadHistory()}
							>
								{loadingHistory ? "加载中…" : "加载更早的消息"}
							</Button>
						)}
						{historyError && (
							<Alert variant="destructive"><AlertDescription>{historyError}</AlertDescription></Alert>
						)}
						{connection !== "connected" && (
							<div role="status">
								{connection === "connecting"
									? "正在连接…"
									: (connectionError ?? "连接中断，正在重试…")}
							</div>
						)}
						{messages.map((m) =>
							m.role === "tool" ? (
								<div key={m.id} className="message tool">
									<div className="bubble">
										<ToolMessage toolName={m.toolName} text={m.text} isError={m.isError} />
									</div>
								</div>
							) : (
								<div key={m.id} className={`message ${m.role}`}>
									<div className="bubble">
										{m.role === "assistant" ? <Markdown text={m.text} /> : m.text}
									</div>
								</div>
							),
						)}
						{busy && (
							<div className="message assistant">
								<div className="bubble pending">
									{snapshot?.streamingText ? (
										<Markdown text={snapshot.streamingText} streaming />
									) : snapshot?.activeTools?.length ? (
										`正在执行：${snapshot.activeTools.join("、")}…`
									) : (
										"思考中…"
									)}
								</div>
							</div>
						)}
						{snapshot?.lastError && (
							<Alert variant="destructive"><AlertDescription>
								出错：
								{{
									no_model: "请先在设置中选择模型",
									error: "模型请求失败，请检查配置后重试",
								}[snapshot.lastError] ?? snapshot.lastError}
							</AlertDescription></Alert>
						)}
					<div ref={bottomRef} />
				</main>
				{snapshot?.todos && <TodoPanel state={snapshot.todos} />}
				<Composer
					connected={connection === "connected"}
					busy={busy}
					seed={composerSeed}
					onSend={sendChat}
					onStop={abortChat}
				/>
			</>
		</div>
	);
}
