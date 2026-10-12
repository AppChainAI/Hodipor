import { memo } from "react";
import { Streamdown, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";

const components: Components = {
	// Tauri webview 内默认导航会带走整个应用，链接一律交系统浏览器
	a: ({ node: _node, ...props }) => (
		<a {...props} target="_blank" rel="noreferrer" />
	),
};

export const Markdown = memo(function Markdown({
	text,
	streaming = false,
}: {
	text: string;
	streaming?: boolean;
}) {
	return (
		<Streamdown
			className="markdown"
			mode={streaming ? "streaming" : "static"}
			isAnimating={streaming}
			components={components}
			plugins={{ cjk }}
		>
			{text}
		</Streamdown>
	);
});
