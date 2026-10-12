import { afterEach, expect, test } from "bun:test";
import { applyTheme, parseTheme, readTheme, resolveTheme, saveTheme, THEME_STORAGE_KEY } from "../src/theme";

const original = new Map(["localStorage", "document", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
function mock(key: string, value: unknown) {
	Object.defineProperty(globalThis, key, { configurable: true, value });
}
afterEach(() => {
	for (const [key, descriptor] of original) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("invalid or absent preferences fall back to system", () => {
	for (const value of [null, "system", "invalid", "", "LIGHT"]) expect(parseTheme(value)).toBe("system");
	expect(parseTheme("light")).toBe("light");
	expect(parseTheme("dark")).toBe("dark");
});

test("only system preference follows OS appearance", () => {
	for (const dark of [true, false]) {
		expect(resolveTheme("system", dark)).toBe(dark ? "dark" : "light");
		expect(resolveTheme("light", dark)).toBe("light");
		expect(resolveTheme("dark", dark)).toBe("dark");
	}
});

test("preference persists and resolved appearance reaches the root", () => {
	const storage = new Map<string, string>();
	mock("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
	const root = { dataset: {} as Record<string, string> };
	mock("document", { documentElement: root });
	let dark = true;
	mock("window", { matchMedia: () => ({ matches: dark }) });
	expect(readTheme()).toBe("system");
	saveTheme("light");
	expect(storage.get(THEME_STORAGE_KEY)).toBe("light");
	expect(readTheme()).toBe("light");
	applyTheme(readTheme());
	expect(root.dataset.theme).toBe("light");
	applyTheme("system");
	expect(root.dataset.theme).toBe("dark");
	dark = false;
	applyTheme("system");
	expect(root.dataset.theme).toBe("light");
});

test("blocked storage does not prevent theme selection", () => {
	mock("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
	expect(readTheme()).toBe("system");
	expect(() => saveTheme("dark")).not.toThrow();
});
