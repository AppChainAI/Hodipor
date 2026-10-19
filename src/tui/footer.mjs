import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import { activeTheme } from "./theme.mjs";
import { formatCwdForFooter, formatTokens, estimateContextTokens } from "./pi-display.mjs";

/**
 * @typedef {Object} FooterState
 * @property {string} cwd
 * @property {string} sessionId
 * @property {{ id: string; provider: string; reasoning?: boolean; contextWindow?: number }} [model]
 * @property {string} [thinkingLevel]
 * @property {import("@earendil-works/pi-durable").UsageState} [usage]
 * @property {number | null} contextTokens
 * @property {number | undefined} [cacheHitRate]
 */

/** Pi's two-line footer layout, fed by durable snapshots, not an AgentSession facade. */
export class SiftoryFooter {
	/** @param {() => FooterState} getState */
	constructor(getState) { this.getState = getState; }
	invalidate() {}
	/** @param {number} width */
	render(width) {
		const theme = activeTheme();
		const state = this.getState();
		const parts = [];
		const usage = [...Object.values(state.usage?.models ?? {}), ...Object.values(state.usage?.tools ?? {})];
		for (const [key, prefix] of /** @type {const} */ ([["input", "↑"], ["output", "↓"], ["cacheRead", "R"], ["cacheWrite", "W"]])) {
			const value = usage.reduce((sum, item) => sum + item[key], 0);
			if (value) parts.push(`${prefix}${formatTokens(value)}`);
		}
		if (usage.some(item => item.cacheRead || item.cacheWrite) && state.cacheHitRate !== undefined) parts.push(`CH${state.cacheHitRate.toFixed(1)}%`);
		const cost = usage.reduce((sum, item) => sum + item.cost.total, 0);
		if (cost) parts.push(`$${cost.toFixed(3)}`);
		const window = state.model?.contextWindow ?? 0;
		if (window > 0) {
			const percent = state.contextTokens === null ? null : state.contextTokens / window * 100;
			const text = `${percent === null ? "?" : `${percent.toFixed(1)}%`}/${formatTokens(window)}`;
			parts.push(theme.fg(percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "dim", text));
		}
		const left = truncateToWidth(parts.join(" "), width, "…");
		let model = state.model?.id ?? "no-model";
		if (state.model?.reasoning) model += ` • ${state.thinkingLevel && state.thinkingLevel !== "off" ? state.thinkingLevel : "thinking off"}`;
		const provider = state.model ? `(${state.model.provider}) ` : "";
		if (visibleWidth(left) + 2 + visibleWidth(provider + model) <= width) model = provider + model;
		const available = width - visibleWidth(left) - 2;
		const right = available > 0 ? truncateToWidth(model, available, "") : "";
		const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
		const cwd = formatCwdForFooter(state.cwd, process.env.HOME || process.env.USERPROFILE);
		return [
			truncateToWidth(theme.fg("dim", `${cwd} • ${state.sessionId}`), width, "…"),
			theme.fg("dim", left) + theme.fg("dim", padding + right),
		];
	}
}

/** @param {Awaited<ReturnType<import("@earendil-works/pi-durable").Conversation["context"]>>} context */
export function contextDisplayStats(context) {
	const messages = [...context.messages];
	const estimate = estimateContextTokens(messages);
	const head = context.head;
	const postHead = !head || context.entries.some(entry => entry.id > head.id && entry.model?.some(message => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && calculateContextTokens(message.usage) > 0));
	const tokens = context.head?.kind === "pi.compaction" && !postHead ? null : estimate.tokens;
	const usage = messages.filter(message => message.role === "assistant").reverse().find(message => message.stopReason !== "error" && message.stopReason !== "aborted" && calculateContextTokens(message.usage) > 0)?.usage;
	const prompt = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
	return { contextTokens: tokens, cacheHitRate: usage && prompt > 0 ? usage.cacheRead / prompt * 100 : undefined };
}
