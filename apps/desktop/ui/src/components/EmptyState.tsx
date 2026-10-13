const EXAMPLES = [
	"固态电池最近有什么突破？做成一期科普视频",
	"汇总本周 AI 行业新闻，写一份研究报告",
	"把《芯片战争》第三章做成 5 分钟播客",
];

/** 空库引导：品牌时刻 + 示例选题。点击示例填入输入框，由用户发出。 */
export function EmptyState(props: { onPick: (text: string) => void }) {
	return (
		<div className="empty-state">
			<div className="empty-logo">
				<img src="/logo.png" alt="" width={40} height={40} />
			</div>
			<p className="empty-title">从信息到故事。</p>
			<p className="empty-sub">
				给 Siftory 一个主题，它去检索、阅读、提炼，把结果做成报告、音频或视频。
			</p>
			<div className="empty-examples">
				{EXAMPLES.map((example) => (
					<button
						key={example}
						type="button"
						className="empty-example"
						onClick={() => props.onPick(example)}
					>
						{example}
					</button>
				))}
			</div>
		</div>
	);
}
