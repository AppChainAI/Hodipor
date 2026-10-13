import { useEffect, useState } from "react";
import type { ArtifactView, LibraryView, TopicSummary } from "@siftory/protocol";
import { createTopic, getLibrary } from "../api/client";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";

const STAGE_ORDER = ["discover", "synthesize", "narrate", "generate", "produce"];

const TYPE_LABELS: Record<string, string> = {
	report: "报告",
	script: "文案",
	audio: "音频",
	video: "视频",
	image: "图片",
	storyboard: "分镜",
};

const typeLabel = (type: string) => TYPE_LABELS[type] ?? "文件";

/** 卡片主视觉 = 管道最末阶段的产物；阶段未知时取最后登记的 */
export function heroArtifact(artifacts: ArtifactView[]): ArtifactView | undefined {
	if (artifacts.length === 0) return undefined;
	return artifacts.reduce((best, candidate) =>
		STAGE_ORDER.indexOf(candidate.stage) >= STAGE_ORDER.indexOf(best.stage)
			? candidate
			: best,
	);
}

const formatTime = (at: number) => {
	const date = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function ArtifactHero({ artifact }: { artifact: ArtifactView }) {
	return (
		<div className="card-hero">
			<span className="artifact-tag">{typeLabel(artifact.type)}</span>
			<span className="card-hero-title">{artifact.title}</span>
			{artifact.excerpt && <span className="card-hero-excerpt">{artifact.excerpt}</span>}
		</div>
	);
}

export function CompactRow({ artifact }: { artifact: ArtifactView }) {
	return (
		<span className="artifact-row">
			<span className="artifact-tag">{typeLabel(artifact.type)}</span>
			{artifact.title}
		</span>
	);
}

function TopicCard(props: { topic: TopicSummary; onOpen: () => void }) {
	const { topic } = props;
	const hero = heroArtifact(topic.artifacts);
	const rest = topic.artifacts.filter((a) => a !== hero);
	return (
		<button type="button" className="topic-card" onClick={props.onOpen}>
			<span className="topic-card-head">
				<span className="topic-card-title">{topic.title}</span>
				<span className={`topic-state${topic.failed ? " failed" : topic.busy ? " busy" : ""}`}>
					{topic.busy ? "进行中" : topic.failed ? "已中断" : formatTime(topic.createdAt)}
				</span>
			</span>
			{hero && <ArtifactHero artifact={hero} />}
			{rest.length > 0 && (
				<span className="topic-card-rest">
					{rest.slice(0, 3).map((artifact) => (
						<CompactRow key={artifact.id} artifact={artifact} />
					))}
					{rest.length > 3 && <span className="artifact-more">+{rest.length - 3}</span>}
				</span>
			)}
		</button>
	);
}

/** 首页 = 产物库：发起框常驻顶部，进行中区块 + 已完成网格；空库即引导页 */
export function HomeView(props: {
	onOpenTopic: (id: string, title: string) => void;
	modelSelect?: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void };
}) {
	const [library, setLibrary] = useState<LibraryView>();
	const [error, setError] = useState<string>();
	const [seed, setSeed] = useState<{ text: string; id: number }>();
	const [starting, setStarting] = useState(false);
	const anyBusy = library?.topics.some((topic) => topic.busy) ?? false;

	useEffect(() => {
		let cancelled = false;
		const load = () =>
			getLibrary()
				.then((view) => {
					if (!cancelled) {
						setLibrary(view);
						setError(undefined);
					}
				})
				.catch((loadError: unknown) => {
					if (!cancelled)
						setError(loadError instanceof Error ? loadError.message : "加载失败");
				});
		load();
		// 有选题在跑时轻量轮询，让进行中区块与已完成网格自己更新
		if (!anyBusy) return;
		const timer = setInterval(load, 3000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [anyBusy]);

	const start = async (text: string, requestId: string) => {
		setStarting(true);
		try {
			const topic = await createTopic(text, requestId);
			props.onOpenTopic(topic.topicId, topic.title);
		} finally {
			setStarting(false);
		}
	};

	const attention = library?.topics.filter((topic) => topic.busy || topic.failed) ?? [];
	const completed =
		library?.topics.filter((topic) => !topic.busy && !topic.failed && topic.artifacts.length > 0).slice(0, 12) ?? [];
	const empty = library && library.topics.length === 0;

	return (
		<div className="home">
			<Composer
				connected
				busy={false}
				seed={seed}
				disabledReason={
					anyBusy ? "有选题正在进行，完成后才能开始新选题" : undefined
				}
				sendLabel={starting ? "创建中…" : undefined}
				modelSelect={props.modelSelect}
				onSend={start}
				onStop={() => Promise.resolve()}
			/>
			{error && <p className="hint">{error}</p>}
			{empty && <EmptyState onPick={(text) => setSeed({ text, id: Date.now() })} />}
			{attention.length > 0 && (
				<section className="home-section">
					<h2 className="home-heading">进行中</h2>
					<div className="topic-grid">
						{attention.map((topic) => (
							<TopicCard
								key={topic.id}
								topic={topic}
								onOpen={() => props.onOpenTopic(topic.id, topic.title)}
							/>
						))}
					</div>
				</section>
			)}
			{completed.length > 0 && (
				<section className="home-section">
					<h2 className="home-heading">已完成</h2>
					<div className="topic-grid">
						{completed.map((topic) => (
							<TopicCard
								key={topic.id}
								topic={topic}
								onOpen={() => props.onOpenTopic(topic.id, topic.title)}
							/>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
