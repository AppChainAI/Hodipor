import { useState } from "react";
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
