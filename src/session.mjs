import { join } from "node:path";
import process from "node:process";
import { readdirSync, existsSync } from "node:fs";
import { acquireSessionLock, initHome, resolveHome, sessionDir } from "./home.mjs";
import { sessionStoragePath, openRuntime, createSiftoryRegistry, RUN_CONTEXT } from "./runtime.mjs";
import { newSessionId } from "./home.mjs";
import { createResourceSections } from "./resources.mjs";
import { createTodoExtension, TodoDoc } from "../extensions/todo/index.mjs";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

/** @param {string} sessionsDir */
export function listSessions(sessionsDir) {
	try {
		return readdirSync(sessionsDir)
			.filter((name) => /^[a-z0-9-]+$/.test(name) && existsSync(join(sessionsDir, name, "state.sqlite")))
			.sort((a, b) => b.localeCompare(a));
	} catch {
		return [];
	}
}

/**
 * One session group's full lifecycle: lock the storage, open the durable
 * runtime, hand the conversation to the TUI (or print mode). /new and /resume
 * re-enter here after the previous session's TUI released its storage.
 */
/**
 * @param {{ home: string; sessionId: string; models: import("@earendil-works/pi-ai").Models; options?: { print?: boolean; model?: string; cwd?: string; prompt?: string }; pickModel: () => Promise<{ provider: string; modelId: string } | undefined>; extraExtensions?: import("@earendil-works/pi-durable").Extension[]; runInteractive?: typeof import("./tui/app.mjs").runTui }} args
 */
export async function openSession(args) {
	let sessionId = args.sessionId;
	let options = args.options;
	for (;;) {
		const result = await runSession({ ...args, sessionId, options });
		if (typeof result === "number") return result;
		sessionId = nextSessionId(resolveHome({ home: args.home }).sessionsDir, result);
		options = { ...options, prompt: undefined };
	}
}

/** @param {Parameters<typeof openSession>[0]} args */
async function runSession({ home, sessionId, models, options, pickModel, extraExtensions = [], runInteractive }) {
	const paths = resolveHome({ home, cwd: options?.cwd });
	initHome(paths);

	const releaseLock = await acquireSessionLock(sessionDir(paths.sessionsDir, sessionId));
	/** @type {Awaited<ReturnType<typeof openRuntime>> | undefined} */
	let runtime;
	try {
		const registry = createSiftoryRegistry({
			cwd: paths.cwd,
			extraSections: createResourceSections({ cwd: paths.cwd, agentDir: paths.agentDir }),
		});
		registry.install(createTodoExtension());
		registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
		registry.install(createToolSearchExtension());
		for (const extension of extraExtensions) registry.install(extension);
		runtime = await openRuntime({
			sessionStoragePath: sessionStoragePath(paths.sessionsDir, sessionId),
			models,
			registry,
			// Materialize the todo doc for every conversation so UI watches always attach.
			conversationCreated: async (tx, conversation) => {
				await tx.doc(TodoDoc, conversation.id);
			},
			onReport: (error) => process.stderr.write(`siftory: ${error instanceof Error ? error.message : String(error)}\n`),
		});

		const { harness } = runtime;
		const modelRef = await pickModel();
		const root = await harness.root(RUN_CONTEXT, { agent: { ...(modelRef ? { model: modelRef } : {}), cwd: paths.cwd } });
		/** @type {{ model?: { provider: string; modelId: string }; cwd?: string; thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel }} */
		const change = {};
		if (options?.model && modelRef) change.model = modelRef;
		const thinking = options?.model?.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1];
		if (thinking) change.thinkingLevel = /** @type {import("@earendil-works/pi-ai").ModelThinkingLevel} */ (thinking);
		if (options?.cwd) change.cwd = paths.cwd;
		if (Object.keys(change).length > 0) await root.configure(change, RUN_CONTEXT);
		paths.cwd = (await root.agent(RUN_CONTEXT)).cwd ?? paths.cwd;
		harness.resume();

		const interactive = !options?.print && (runInteractive || (process.stdout.isTTY && process.stdin.isTTY));
		if (interactive) {
			const runTui = runInteractive ?? (await import("./tui/app.mjs")).runTui;
			return await runTui({ harness, root, models, paths, sessionId, options: options ?? {} });
		} else {
			const { runPrint } = await import("./print.mjs");
			const prompt = options?.prompt ?? (await readStdin());
			if (!prompt || !prompt.trim()) {
				process.stderr.write("siftory: empty prompt\n");
				return 1;
			} else {
				return await runPrint({ harness, root, prompt });
			}
		}
	} finally {
		try {
			await runtime?.harness.close(RUN_CONTEXT);
		} finally {
			try {
				await runtime?.release();
			} finally {
				releaseLock();
			}
		}
	}
}

/** The next storage to move to: a named session, the most recent one, or fresh. */
/**
 * @param {string} sessionsDir
 * @param {{ newSession?: boolean; pickSession?: boolean | string }} request
 */
export function nextSessionId(sessionsDir, request) {
	if (request.newSession) return newSessionId();
	const ids = listSessions(sessionsDir);
	if (typeof request.pickSession === "string") {
		if (!ids.includes(request.pickSession)) throw new Error(`session not found: ${request.pickSession}`);
		return request.pickSession;
	}
	if (ids.length > 0) return ids[0];
	return newSessionId();
}

function readStdin() {
	return new Promise((resolve, reject) => {
		if (process.stdin.isTTY) return resolve("");
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}
