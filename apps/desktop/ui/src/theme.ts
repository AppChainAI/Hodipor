export type ThemePreference = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "siftory.theme";

export function parseTheme(value: string | null): ThemePreference {
	return value === "light" || value === "dark" ? value : "system";
}

export function readTheme(): ThemePreference {
	try {
		return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
	} catch {
		return "system";
	}
}

export function resolveTheme(preference: ThemePreference, dark: boolean) {
	return preference === "system" ? (dark ? "dark" : "light") : preference;
}

export function applyTheme(preference: ThemePreference) {
	document.documentElement.dataset.theme = resolveTheme(
		preference,
		window.matchMedia("(prefers-color-scheme: dark)").matches,
	);
}

export function saveTheme(preference: ThemePreference) {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {
		// Storage may be unavailable; the theme still works for this app session.
	}
}
