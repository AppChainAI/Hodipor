import { useEffect, useRef, useState } from "react";
import type { ArtifactView, TopicSummary } from "@siftory/protocol";
import { getArtifactText, getLibrary } from "../api/client";
import { CompactRow } from "./HomeView";
import { Markdown } from "./Markdown";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

const MARKDOWN = /\.markdown?$|\.md$/i;

/** 产物内容预览：暂只渲染 markdown；音视频落地时在此按类型换 <audio>/<video> */
function ArtifactPreview(props: {
	topicId: string;
	artifact: ArtifactView | undefined;
	onClose: () => void;
}) {
	const [text, setText] = useState<string>();
	const [error, setError] = useState<string>();
	const id = props.artifact?.id;
	useEffect(() => {
		if (id === undefined) return;
		let cancelled = false;
		setText(undefined);
		setError(undefined);
		getArtifactText(props.topicId, id)
			.then((content) => {
				if (!cancelled) setText(content);
			})
			.catch((loadError: unknown) => {
				if (!cancelled)
					setError(loadError instanceof Error ? loadError.message : "加载失败");
			});
		return () => {
			cancelled = true;
		};
	}, [props.topicId, id]);
	return (
		<Dialog open={props.artifact !== undefined} onOpenChange={() => props.onClose()}>
			<DialogContent className="artifact-preview sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{props.artifact?.title}</DialogTitle>
				</DialogHeader>
				<div className="artifact-preview-body">
					{error ? (
						<p className="hint">{error}</p>
					) : text === undefined ? (
						<p className="hint">加载中…</p>
					) : (
						<Markdown text={text} />
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** 工作台右栏产物台：该选题已登记的产物随做随收（进行中每 3s 轮询，停下时收尾一次） */
export function ArtifactShelf(props: { topicId: string; busy: boolean }) {
	const [topic, setTopic] = useState<TopicSummary>();
	const [preview, setPreview] = useState<ArtifactView>();
	// 首轮加载不播动效；之后轮询发现的新登记产物才滑入
	const seenIds = useRef<Set<number> | undefined>(undefined);
	const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
	useEffect(() => {
		let cancelled = false;
		const load = () =>
			getLibrary()
				.then((view) => {
					if (cancelled) return;
					const next = view.topics.find((t) => t.id === props.topicId);
					const ids = new Set((next?.artifacts ?? []).map((a) => a.id));
					if (seenIds.current) {
						const fresh = new Set([...ids].filter((id) => !seenIds.current?.has(id)));
						if (fresh.size > 0) setFreshIds(fresh);
					}
					seenIds.current = ids;
					setTopic(next);
				})
				.catch(() => {});
		load();
		if (!props.busy) return;
		const timer = setInterval(load, 3000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [props.topicId, props.busy]);

	const artifacts = topic?.artifacts ?? [];
	return (
		<aside className="artifact-shelf" aria-label="产物台">
			<h2 className="artifact-shelf-heading">
				产物台
				{artifacts.length > 0 && (
					<span className="artifact-shelf-count"> · {artifacts.length}</span>
				)}
			</h2>
			{artifacts.length === 0 ? (
				<p className="hint">产物登记后出现在这里</p>
			) : (
				<div className="artifact-shelf-list">
					{artifacts.map((artifact) =>
						MARKDOWN.test(artifact.relPath) ? (
							<button
								type="button"
								key={artifact.id}
								className={`artifact-row-button${freshIds.has(artifact.id) ? " artifact-enter" : ""}`}
								onClick={() => setPreview(artifact)}
							>
								<CompactRow artifact={artifact} />
							</button>
						) : (
							<CompactRow key={artifact.id} artifact={artifact} />
						),
					)}
				</div>
			)}
			<ArtifactPreview
				topicId={props.topicId}
				artifact={preview}
				onClose={() => setPreview(undefined)}
			/>
		</aside>
	);
}
