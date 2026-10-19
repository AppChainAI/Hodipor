import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { themeApi } from "./pi-display.mjs";

export const activeTheme = () => /** @type {import("@earendil-works/pi-coding-agent").Theme} */ (themeApi.theme);

/**
 * Isolated home themes and Pi's terminal palette negotiation, without its plugin host
 * or the theme watcher's implicit ~/.pi directory.
 * @param {import("@earendil-works/pi-tui").TUI} tui
 * @param {{ cwd: string; agentDir: string; onChanged: () => void; onError: (message: string) => void }} options
 */
export function createThemeController(tui, { cwd, agentDir, onChanged, onError }) {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	for (const error of settings.drainErrors()) onError(`settings: ${error.error.message}`);
	/** @type {import("@earendil-works/pi-coding-agent").Theme[]} */
	const custom = [];
	/** @type {string[]} */
	let files = [];
	try { files = readdirSync(join(agentDir, "themes")); }
	catch (/** @type {any} */ error) { if (error.code !== "ENOENT") onError(`themes: ${error.message}`); }
	for (const file of files.filter(file => file.endsWith(".json"))) {
		try {
			const theme = themeApi.loadThemeFromPath(join(agentDir, "themes", file));
			if (theme.name === "system") continue;
			if (custom.some(item => item.name === theme.name)) throw new Error(`duplicate theme: ${theme.name}`);
			custom.push(theme);
		} catch (error) { onError(error instanceof Error ? error.message : String(error)); }
	}
	themeApi.setRegisteredThemes(custom);
	const names = [...new Set(["system", "dark", "light", ...custom.map(theme => theme.name ?? "").filter(Boolean)])];
	const saved = settings.getGlobalSettings().theme;
	let selection = typeof saved === "string" ? saved : "system";
	let closed = false;
	let colors = {};
	/** @param {string} value */
	function validate(value) {
		const parts = value.split("/");
		if (parts.length > 2 || parts.some(name => !names.includes(name))) throw new Error(`unknown theme: ${value}`);
	}
	try { validate(selection); } catch (error) {
		onError(error instanceof Error ? error.message : String(error));
		selection = "system";
	}
	function apply() {
		if (closed) return;
		themeApi.initTheme(themeApi.resolveThemeSetting(selection, themeApi.getTerminalTheme()), false);
		onChanged();
	}
	/** @param {import("@earendil-works/pi-tui").TerminalColors} reported */
	function applyColors(reported) {
		if (closed) return;
		colors = { ...colors, ...reported };
		themeApi.setTerminalColors(colors);
		apply();
	}
	async function query() {
		if (closed) return;
		try { applyColors(await tui.queryTerminalColors({ timeoutMs: 100, onLateReply: applyColors })); }
		catch { applyColors({}); }
	}
	themeApi.setTerminalColors({});
	themeApi.markTerminalColorsPending();
	apply();
	const unsubscribe = tui.onTerminalColorSchemeChange((scheme) => {
		if (closed) return;
		themeApi.setTerminalColorScheme(scheme);
		if (selection === "system" || selection.includes("/")) void query();
	});
	return {
		names: () => names,
		selection: () => selection,
		start: async () => { tui.setTerminalColorSchemeNotifications(true); await query(); },
		/** @param {string} value */
		set: async (value) => {
			validate(value);
			settings.setTheme(value);
			await settings.flush();
			const errors = settings.drainErrors();
			if (errors.length) throw errors[0].error;
			selection = value;
			apply();
		},
		dispose: () => { closed = true; unsubscribe(); tui.setTerminalColorSchemeNotifications(false); },
	};
}
