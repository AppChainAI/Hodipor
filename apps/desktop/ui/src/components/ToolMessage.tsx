import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** 工具调用的结构化卡片：名称 + 状态 + 可展开输出。失败默认展开。 */
export function ToolMessage(props: {
	toolName?: string;
	text: string;
	isError?: boolean;
}) {
	const [open, setOpen] = useState(!!props.isError);
	const summary = props.text.split("\n", 1)[0] ?? "";
	return (
		<div className={`tool-card${props.isError ? " error" : ""}`}>
			<button
				type="button"
				className="tool-head"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<ChevronRight aria-hidden="true" className="tool-chevron" data-open={open || undefined} />
				<span className="tool-name">{props.toolName ?? "工具"}</span>
				<span className="tool-status">{props.isError ? "失败" : "完成"}</span>
				{!open && summary && <span className="tool-summary">{summary}</span>}
			</button>
			{open && props.text && <pre className="tool-output">{props.text}</pre>}
		</div>
	);
}

type ToolItem = { id: string; toolName?: string; text: string; isError?: boolean };

/** 连续工具调用的折叠组（≥3 条时出现）；组内有失败则整体标错 */
export function ToolGroup(props: {
	items: ToolItem[];
	renderItem: (item: ToolItem) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const failed = props.items.some((item) => item.isError);
	const names = [...new Set(props.items.map((item) => item.toolName ?? "工具"))];
	return (
		<div className={`tool-group${failed ? " error" : ""}`}>
			<button
				type="button"
				className="tool-head"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<ChevronRight aria-hidden="true" className="tool-chevron" data-open={open || undefined} />
				<span className="tool-name">{props.items.length} 个工具调用</span>
				{failed && <span className="tool-status">有失败</span>}
				{!open && <span className="tool-summary">{names.join("、")}</span>}
			</button>
			{open && (
				<div className="tool-group-items">{props.items.map(props.renderItem)}</div>
			)}
		</div>
	);
}
