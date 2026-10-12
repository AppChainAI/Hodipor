import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAgentHost } from "../src/harness";
import { FileCredentialStore } from "../src/config";
import { handleHttp } from "../src/server/http";
import { projectChatView } from "../src/server/projection";
import { allowedOrigin, authorized, cors } from "../src/server/access";

const temporary = () => mkdtemp(join(tmpdir(), "siftory-host-"));
it("persists conversation configuration and deduplicates a submission after reopen", async () => {
	const directory = await temporary();
	let host = await createAgentHost(directory, { dev: true });
	try {
		expect((await host.root.agent(context)).sections.map((s) => s.key)).toEqual(
			["preamble", "rules"],
		);
		await host.root.configure({ instructions: "Persist this" }, context);
		const input = {
			type: "input" as const,
			content: "hello",
			requestId: "stable-input",
		};
		const first = await host.root.submit(input, context);
		expect((await first.wait(context)).status).toBe("done");
		await host.close();
		host = await createAgentHost(directory, { dev: true });
		expect((await host.root.submit(input, context)).id).toBe(first.id);
		expect((await host.getAgent()).instructions).toBe("Persist this");
		const view = await host.root.viewState(context);
		try {
			expect(
				projectChatView(view.value).messages.every(
					(m) => typeof m.id === "string",
				),
			).toBe(true);
		} finally {
			view.dispose();
		}
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
it("rejects a second owner and registers providers immediately without reading their catalog", async () => {
	const directory = await temporary();
	const host = await createAgentHost(directory);
	try {
		await expect(createAgentHost(directory)).rejects.toThrow(
			"owns this data directory",
		);
		await host.upsertCustomProvider({
			id: "custom-test",
			name: "Test",
			baseUrl: "https://example.invalid/v1",
			models: ["one"],
		});
		expect(host.models.getModel("custom-test", "one")).toBeDefined();
		await host.upsertCustomProvider({
			id: "custom-test",
			name: "Test",
			baseUrl: "https://example.invalid/v1",
			models: ["two"],
		});
		expect(host.models.getModel("custom-test", "one")).toBeUndefined();
		expect(host.models.getModel("custom-test", "two")).toBeDefined();
		await host.deleteCustomProvider("custom-test");
		expect(host.models.getProvider("custom-test")).toBeUndefined();
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
it("preserves damaged credentials and returns the current credential for unchanged modifications", async () => {
	const directory = await temporary();
	const file = join(directory, "auth.json");
	try {
		const store = new FileCredentialStore(file);
		const credential = { type: "api_key" as const, key: "test-only" };
		await store.modify("test", async () => credential);
		expect(await store.modify("test", async () => undefined)).toEqual(
			credential,
		);
		if (process.platform !== "win32")
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		await writeFile(file, "broken json");
		await expect(store.modify("other", async () => credential)).rejects.toThrow(
			"Cannot read configuration",
		);
		expect(await readFile(file, "utf8")).toBe("broken json");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("rejects malformed requests and protected provider ids without changing state", async () => {
	const directory = await temporary();
	const host = await createAgentHost(directory);
	try {
		for (const [path, method, body] of [
			["/api/chat", "POST", { content: 12 }],
			[
				"/api/custom-providers",
				"PUT",
				{
					id: "openai",
					name: "Fake",
					baseUrl: "https://example.invalid",
					models: ["one"],
				},
			],
			[
				"/api/config",
				"PUT",
				{ agent: { model: { provider: "missing", modelId: "missing" } } },
			],
		] as const) {
			const response = await handleHttp(
				host,
				new Request(`http://localhost${path}`, {
					method,
					body: JSON.stringify(body),
				}),
			);
			expect(response.status).toBe(400);
		}
		expect(
			(
				await handleHttp(
					host,
					new Request("http://localhost/api/custom-providers/openai", {
						method: "DELETE",
					}),
				)
			).status,
		).toBe(400);
		expect(host.models.getProvider("openai")).toBeDefined();
		const failure = await (
			await host.root.submit({ type: "input", content: "no model" }, context)
		).wait(context);
		expect(failure.status).toBe("unanswered");
		expect((await host.latestSubmission())?.reason).toBe("no_model");
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
it("allows explicit application origins while restricting URL tokens to WebSocket upgrades", () => {
	const options = new Request("http://localhost/api/chat", {
		method: "OPTIONS",
		headers: { origin: "tauri://localhost" },
	});
	expect(allowedOrigin(options, false)).toBe(true);
	expect(
		cors(options, new Response(null, { status: 204 })).headers.get(
			"access-control-allow-origin",
		),
	).toBe("tauri://localhost");
	expect(
		allowedOrigin(
			new Request("http://localhost/ws", {
				headers: { origin: "https://untrusted.invalid" },
			}),
			true,
		),
	).toBe(false);
	expect(
		authorized(
			new Request("http://localhost/api/config?token=secret"),
			"secret",
		),
	).toBe(false);
	expect(
		authorized(
			new Request("http://localhost/ws?token=secret", {
				headers: { upgrade: "websocket" },
			}),
			"secret",
		),
	).toBe(true);
});

it("bounds streaming history and exposes complete older messages through pagination", async () => {
	const directory = await temporary();
	const host = await createAgentHost(directory);
	try {
		await host.root.commit(async (tx) => {
			for (let index = 0; index < 250; index++)
				await tx.appendEntry(host.root.id, {
					kind: "pi.user",
					model: [
						{ role: "user", content: `history-${index}`, timestamp: index },
					],
				});
		}, context);
		const view = await host.root.viewState(context);
		const snapshot = projectChatView(view.value);
		view.dispose();
		expect(snapshot.messages).toHaveLength(200);
		expect(snapshot.messages[0].text).toBe("history-50");
		const response = await handleHttp(
			host,
			new Request(
				`http://localhost/api/history?before=${snapshot.historyBefore}`,
			),
		);
		expect(response.status).toBe(200);
		const history = await response.json();
		expect(history.messages).toHaveLength(50);
		expect(history.messages[0].text).toBe("history-0");
		expect(history.before).toBeUndefined();
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
it("reset opens a fresh context: snapshot clears and the next run no longer sees old input", async () => {
	const directory = await temporary();
	const host = await createAgentHost(directory, { dev: true });
	try {
		const first = await host.root.submit(
			{ type: "input", content: "旧上下文", requestId: "before-reset" },
			context,
		);
		expect((await first.wait(context)).status).toBe("done");
		const before = await host.root.viewState(context);
		try {
			const snapshot = projectChatView(before.value);
			expect(snapshot.messages.length).toBeGreaterThan(0);
			expect(snapshot.contextId).toBeUndefined();
		} finally {
			before.dispose();
		}

		const response = await handleHttp(
			host,
			new Request("http://localhost/api/reset", { method: "POST" }),
		);
		expect(response.status).toBe(200);

		let contextId: string | undefined;
		const cleared = await host.root.viewState(context);
		try {
			const snapshot = projectChatView(cleared.value);
			expect(snapshot.messages).toEqual([]);
			expect(snapshot.busy).toBe(false);
			contextId = snapshot.contextId;
			expect(contextId).toBeDefined();
		} finally {
			cleared.dispose();
		}

		// faux 回声复述它实际看到的最后一条 user 消息：隔离成立则只剩新输入
		const second = await host.root.submit(
			{ type: "input", content: "新上下文", requestId: "after-reset" },
			context,
		);
		expect((await second.wait(context)).status).toBe("done");
		const after = await host.root.viewState(context);
		try {
			const snapshot = projectChatView(after.value);
			expect(snapshot.contextId).toBe(contextId);
			expect(snapshot.messages.map((m) => m.text)).toEqual([
				"新上下文",
				expect.stringContaining("[faux] 收到：新上下文"),
			]);
			expect(
				snapshot.messages.some((m) => m.text.includes("旧上下文")),
			).toBe(false);
		} finally {
			after.dispose();
		}
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
