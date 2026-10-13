import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatSnapshot, ChatMessage, ConfigView } from "@siftory/protocol";
import {
	abortChat,
	getConfig,
	getHistory,
	putConfig,
	sendChat,
	subscribeChat,
	type ConnectionStatus,
} from "./api/client";
import { ArtifactShelf } from "./components/ArtifactShelf";
import { Composer } from "./components/Composer";
import { HomeView } from "./components/HomeView";
import { Markdown } from "./components/Markdown";
import { TodoPanel } from "./components/TodoPanel";
import { ToolGroup, ToolMessage } from "./components/ToolMessage";
import { SettingsPanel } from "./components/SettingsPanel";
import { Button } from "./components/ui/button";
import { Alert, AlertDescription } from "./components/ui/alert";
import { ChevronLeft } from "lucide-react";

type View = { name: "home" } | { name: "topic"; id: string; title: string };

/** 消息渲染块：连续工具消息折叠为一组（Run 时间线分组的最小形态） */
type Block =
	| { kind: "message"; message: ChatMessage }
	| { kind: "tools"; items: ChatMessage[] };

function groupBlocks(messages: ChatMessage[]): Block[] {
	const blocks: Block[] = [];
	for (const message of messages) {
		if (message.role === "tool") {
			const last = blocks[blocks.length - 1];
			if (last?.kind === "tools") last.items.push(message);
			else blocks.push({ kind: "tools", items: [message] });
		} else {
			blocks.push({ kind: "message", message });
		}
	}
	return blocks;
}

export function App() {
	const [view, setView] = useState<View>({ name: "home" });
	const [snapshot, setSnapshot] = useState<ChatSnapshot>();
	const [connectionError, setConnectionError] = useState<string>();
	const [connection, setConnection] = useState<ConnectionStatus>("connecting");
	const [showSettings, setShowSettings] = useState(false);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [historyBefore, setHistoryBefore] = useState<string>();
	const [historyError, setHistoryError] = useState<string>();
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [config, setConfig] = useState<ConfigView>();
	const historyLoaded = useRef(false);
	// 当前上下文的标识（快照 contextId）；reset 后变化，本地累积的消息随之作废
	const contextId = useRef<string | undefined>(undefined);
	const followOutput = useRef(true);
	const historyScroll = useRef<{ top: number; height: number } | undefined>(
		undefined,
	);
	const mainRef = useRef<HTMLElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	const topicId = view.name === "topic" ? view.id : undefined;

	const loadConfig = () =>
		getConfig()
			.then(setConfig)
			.catch(() => {});
	useEffect(() => {
		void loadConfig();
	}, []);
	// 设置关闭后刷新：模型选择可能改了
	useEffect(() => {
		if (!showSettings) loadConfig();
	}, [showSettings]);

	const merge = (incoming: ChatMessage[]) =>
		setMessages((previous) =>
			[
				...new Map(
					[...previous, ...incoming].map((message) => [message.id, message]),
				).values(),
			].sort((a, b) => Number(a.id) - Number(b.id)),
		);
	useEffect(() => {
		if (!topicId) return;
		// 切换选题：清空上一会话的本地状态再订阅
		setSnapshot(undefined);
		setMessages([]);
		setHistoryBefore(undefined);
		setHistoryError(undefined);
		contextId.current = undefined;
		historyLoaded.current = false;
		setConnection("connecting");
		return subscribeChat(
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
			topicId,
		);
	}, [topicId]);
	const loadHistory = async () => {
		if (!historyBefore || loadingHistory || !topicId) return;
		setLoadingHistory(true);
		setHistoryError(undefined);
		const contextAtLoad = contextId.current;
		try {
			const page = await getHistory(historyBefore, topicId);
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
	const activeModel =
		(view.name === "topic" ? snapshot?.model : undefined) ?? config?.agent.model;
	const connectionLabel =
		connection === "connected"
			? "已连接"
			: connection === "connecting"
				? "连接中"
				: "已断开";

	const modelOptions = Object.entries(config?.models ?? {}).flatMap(
		([provider, ids]) =>
			ids.map((modelId) => ({
				value: `${provider}/${modelId}`,
				label: modelId,
			})),
	);
	const modelSelect =
		modelOptions.length > 0
			? {
					value: activeModel
						? `${activeModel.provider}/${activeModel.modelId}`
						: "",
					options: modelOptions,
					onChange: (value: string) => {
						const [provider, ...rest] = value.split("/");
						const modelId = rest.join("/");
						void putConfig({
							conversationId: topicId,
							agent: { model: { provider, modelId } },
						})
							.then(loadConfig)
							.catch(() => {});
					},
				}
			: undefined;

	return (
		<div className="app">
			<header className="app-header">
				{view.name === "topic" ? (
					<>
						<Button
							variant="ghost"
							onClick={() => setView({ name: "home" })}
							aria-label="返回产物库"
						>
							<ChevronLeft aria-hidden="true" />
							产物库
						</Button>
						<span className="topic-title">{view.title}</span>
					</>
				) : (
					<h1 className="brand">
						<img className="brand-logo" src="/logo.png" alt="" width={32} height={32} />
						Siftory
					</h1>
				)}
				<span className="status-chip" title={connectionLabel}>
					{view.name === "topic" && (
						<span className="status-dot" data-state={connection} />
					)}
					{!!snapshot?.queued && view.name === "topic" && (
						<span className="status-queued">排队 {snapshot.queued}</span>
					)}
				</span>
				<Button variant="ghost" onClick={() => setShowSettings(true)}>
					设置
				</Button>
			</header>

			<SettingsPanel open={showSettings} onOpenChange={setShowSettings} />

			{view.name === "home" ? (
				<HomeView
					modelSelect={modelSelect}
					onOpenTopic={(id, title) => setView({ name: "topic", id, title })}
				/>
			) : (
				<div className="topic-body">
					<div className="topic-main">
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
						{groupBlocks(messages).map((block, index) =>
							block.kind === "tools" ? (
								<div key={`tools-${block.items[0].id}`} className="message tool">
									<div className="bubble">
										{block.items.length >= 3 ? (
											<ToolGroup
												items={block.items}
												renderItem={(m) => (
													<ToolMessage
														key={m.id}
														toolName={m.toolName}
														text={m.text}
														isError={m.isError}
													/>
												)}
											/>
										) : (
											block.items.map((m) => (
												<ToolMessage
													key={m.id}
													toolName={m.toolName}
													text={m.text}
													isError={m.isError}
												/>
											))
										)}
									</div>
								</div>
							) : (
								<div key={block.message.id} className={`message ${block.message.role}`}>
									<div className="bubble">
										{block.message.role === "assistant" ? (
											<Markdown text={block.message.text} />
										) : (
											block.message.text
										)}
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
							modelSelect={modelSelect}
							onSend={(text, requestId) => sendChat(text, requestId, topicId)}
							onStop={() => abortChat(topicId)}
						/>
					</div>
					<ArtifactShelf topicId={view.id} busy={busy} />
				</div>
			)}
		</div>
	);
}
