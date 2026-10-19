// Pi 1.3.0 does not publicly export its display-only loaders. Keep this pinned
// seam in one place; never import its tool execution loop or plugin host.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const renderers = await import(new URL("./core/tools/renderers/index.js", entry).href);
const codemode = await import(new URL("./extensions/codemode/renderer.js", entry).href);
export const themeApi = await import(new URL("./modes/interactive/theme/theme.js", entry).href);
export const { WorkingStatusIndicator, CompactionStatusIndicator, StatusIndicator } = await import(new URL("./modes/interactive/components/status-indicator.js", entry).href);
export const { CountdownTimer } = await import(new URL("./modes/interactive/components/countdown-timer.js", entry).href);
export const { ThemedText } = await import(new URL("./modes/interactive/components/themed-text.js", entry).href);
export const { formatTokens, formatCwdForFooter } = await import(new URL("./modes/interactive/components/footer.js", entry).href);
export const { estimateContextTokens } = await import(new URL("./core/compaction/index.js", entry).href);
const schema = await import(new URL("./modes/interactive/theme/theme-schema.js", entry).href);
themeApi.setThemeJsonValidator(schema.validateThemeJson);

/** @param {string} name @returns {import("@earendil-works/pi-coding-agent").ToolRenderers | undefined} */
export function nativeToolRenderers(name) {
	if (name === "codemode") return codemode.codemodeRenderers;
	const renderer = renderers.withBuiltInRenderers(name, undefined);
	if (name !== "edit" || !renderer) return renderer;
	return {
		...renderer,
		// Durable stores the actual diff. Never recompute historical edits against today's files.
		renderCall: (args, theme, context) => renderer.renderCall(args, theme, { ...context, argsComplete: false }),
	};
}
