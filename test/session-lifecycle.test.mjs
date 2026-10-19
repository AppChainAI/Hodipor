import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { acquireSessionLock, initHome, pickSession, resolveHome } from "../src/home.mjs";
import { openSession } from "../src/session.mjs";
import { RUN_CONTEXT } from "../src/runtime.mjs";

async function fixture(t) {
	const home = await mkdtemp(join(tmpdir(), "siftory-lifecycle-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
	models.setProvider(faux.provider);
	const args = { home, sessionId: "first", models, pickModel: async () => ({ provider: "faux", modelId: "faux-1" }) };
	return { home, models, faux, args };
}

test("session switching closes the previous runtime before releasing ownership, preserves the model", async (t) => {
	const { home, args } = await fixture(t);
	const held = [];
	let previous;
	let visits = 0;
	await openSession({ ...args, options: { model: "faux/faux-1:high" }, runInteractive: async ({ harness, root, sessionId }) => {
		if (previous) {
			assert.equal(existsSync(previous.lock), false);
			await assert.rejects(() => previous.root.submit({ type: "input", content: "closed" }, RUN_CONTEXT));
		}
		assert.deepEqual((await root.agent(RUN_CONTEXT)).model, { provider: "faux", modelId: "faux-1" });
		assert.equal((await root.agent(RUN_CONTEXT)).thinkingLevel, "high");
		const lock = join(home, "sessions", sessionId, "owner.lock");
		assert.equal(existsSync(lock), true);
		held.push(sessionId);
		previous = { root, lock };
		if (++visits === 1) return { newSession: true };
		if (visits === 2) return { pickSession: "first" };
		return 0;
	} });
	assert.equal(held.length, 3);
	assert.equal(held[0], held[2]);
	assert.notEqual(held[0], held[1]);
	assert.equal(existsSync(previous.lock), false);
});

test("simultaneous stale-lock takeovers admit only one process", async (t) => {
	const { home } = await fixture(t);
	const dir = join(home, "contended");
	await mkdir(dir);
	await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: 2147483647 }));
	const children = Array.from({ length: 8 }, () => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", `
			import { acquireSessionLock } from ${JSON.stringify(new URL("../src/home.mjs", import.meta.url).href)};
			process.stdout.write("ready\\n");
			process.stdin.once("data", async () => {
				try {
					const release = await acquireSessionLock(process.argv[1]);
					process.stdout.write("held\\n");
					await new Promise(r => setTimeout(r, 500));
					release();
					process.exit(0);
				} catch { process.exit(1); }
			});
		`, dir], { stdio: ["pipe", "pipe", "pipe"] });
		t.after(() => child.kill("SIGKILL"));
		let output = "";
		let readyResolve;
		const ready = new Promise((resolve) => { readyResolve = resolve; });
		child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready")) readyResolve(); });
		const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code) => resolve(code)); });
		return { child, ready, done };
	});
	await Promise.all(children.map(c => c.ready));
	for (const c of children) c.child.stdin.end("go");
	const codes = await Promise.all(children.map(c => c.done));
	assert.equal(codes.filter(code => code === 0).length, 1, JSON.stringify(codes));
});

test("startup errors release storage ownership", async (t) => {
	const { home, args } = await fixture(t);
	await assert.rejects(() => openSession({ ...args, pickModel: async () => { throw new Error("startup failed"); } }), /startup failed/);
	const release = await acquireSessionLock(join(home, "sessions", "first"));
	release();
});

test("resume uses the saved cwd for tools, resources and TUI; explicit override persists", async (t) => {
	const { home, args, faux } = await fixture(t);
	const project = join(home, "project");
	await mkdir(project);
	await writeFile(join(project, "AGENTS.md"), "SAVED_PROJECT_CONTEXT");
	await openSession({ ...args, options: { cwd: project }, runInteractive: async () => 0 });
	faux.setResponses([(context) => {
		assert.match(JSON.stringify(context.messages.filter((m) => m.role === "system")), /SAVED_PROJECT_CONTEXT/);
		return fauxAssistantMessage("restored");
	}]);
	await openSession({ ...args, runInteractive: async ({ harness, root, paths }) => {
		assert.equal(paths.cwd, project);
		const result = await (await root.submit({ type: "input", content: "check" }, RUN_CONTEXT)).wait(RUN_CONTEXT);
		assert.equal(result.status, "done");
		return 0;
	} });
	const override = join(home, "override");
	await openSession({ ...args, options: { cwd: override }, runInteractive: async ({ paths }) => {
		assert.equal(paths.cwd, override);
		return 0;
	} });
	await openSession({ ...args, runInteractive: async ({ paths }) => {
		assert.equal(paths.cwd, override);
		return 0;
	} });
});

test("legacy agent-dir configuration cannot silently select different credentials", (t) => {
	const previous = process.env.SIFTORY_AGENT_DIR;
	process.env.SIFTORY_AGENT_DIR = "/legacy/agent";
	try {
		assert.throws(() => resolveHome(), /SIFTORY_AGENT_DIR.*--home/);
		assert.equal(resolveHome({ home: "/explicit/home" }).home, "/explicit/home");
	} finally {
		if (previous === undefined) delete process.env.SIFTORY_AGENT_DIR;
		else process.env.SIFTORY_AGENT_DIR = previous;
	}
});

test("home directories are private; malformed locks fail closed; IDs cannot escape sessions", async (t) => {
	const { home } = await fixture(t);
	const paths = resolveHome({ home: join(home, "private") });
	initHome(paths);
	if (process.platform !== "win32") {
		assert.equal((await stat(paths.home)).mode & 0o077, 0);
		assert.equal((await stat(paths.agentDir)).mode & 0o077, 0);
	}
	const dir = join(paths.sessionsDir, "broken");
	await mkdir(dir);
	await writeFile(join(dir, "owner.lock"), "");
	await assert.rejects(() => acquireSessionLock(dir), /invalid owner lock/);
	assert.equal(await readFile(join(dir, "owner.lock"), "utf8"), "");
	assert.throws(() => pickSession(paths.sessionsDir, { sessionId: "../workspace" }), /invalid session id/);
});
