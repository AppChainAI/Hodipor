import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { main } from "../src/cli.mjs";
import { acquireSessionLock, newSessionId, pickSession, resolveHome } from "../src/home.mjs";
import { sessionStoragePath, openRuntime, createHodiporRegistry, RUN_CONTEXT } from "../src/runtime.mjs";

async function tempHome(t) {
	const root = await mkdtemp(join(tmpdir(), "hodipor-durable-"));
	// Windows: deleting a still-held file fails with EBUSY; retry instead of failing the hook.
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	return root;
}

async function fauxModels(t, responses) {
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
	if (responses) faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	t.after(() => faux.provider.dispose?.());
	return { models, faux };
}

test("home resolution: defaults, explicit --home/--cwd, relative paths anchor to process cwd", async (t) => {
	const defaults = resolveHome({});
	assert.equal(defaults.home, join(await import("node:os").then((m) => m.homedir()), ".hodipor"));
	assert.equal(defaults.cwd, join(defaults.home, "workspace"));

	const here = process.cwd();
	const explicit = resolveHome({ home: "rel-home", cwd: "rel-project" });
	assert.equal(explicit.home, join(here, "rel-home"));
	assert.equal(explicit.cwd, join(here, "rel-project"));

	const absolute = resolveHome({ home: "/x/h", cwd: "/x/p" });
	// On Windows "/x" anchors to the current drive root rather than a POSIX root.
	assert.equal(absolute.cwd, resolve("/x/p"));
});

test("session lock: second open of live storage is refused, stale lock is taken over", async (t) => {
	const home = await tempHome(t);
	const dir = join(home, "sessions", "s1");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: 2147483647 }));
	const release = await acquireSessionLock(dir);
	release();
	release(); // Releasing twice cannot remove a subsequent owner's lock.
	const again = await acquireSessionLock(dir);
	release();
	await assert.rejects(() => acquireSessionLock(dir), /owned by pid/);
	again();

	const held = await acquireSessionLock(dir, { pid: process.pid });
	await assert.rejects(() => acquireSessionLock(dir, { pid: 424242 }), /owned by pid/);
	held();
});

test("print mode answers, runs file tools in the workspace, and streams text", async (t) => {
	const home = await tempHome(t);
	const { models, faux } = await fauxModels(t);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "hello durable" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("written and verified"),
	]);
	const chunks = [];
	const originalWrite = process.stdout.write.bind(process.stdout);
	t.mock.method(process.stdout, "write", (chunk) => {
		chunks.push(String(chunk));
		return true;
	});
	const code = await main(["--print", "write a note", "--home", home, "--model", "faux/faux-1"], { models });
	assert.equal(code, 0);
	const out = chunks.join("");
	assert.match(out, /● write\(note\.txt\)/);
	assert.match(out, /written and verified/);
	assert.equal(await readFile(join(home, "workspace", "note.txt"), "utf8"), "hello durable");
	// Initial dependency setup may install its own handler; subsequent print runs must not add more.
	const listeners = process.listenerCount("SIGINT");
	faux.setResponses([fauxAssistantMessage("second check")]);
	await main(["--print", "check again", "--home", home, "--model", "faux/faux-1"], { models });
	assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("print mode exits non-zero on unanswered input", async (t) => {
	const home = await tempHome(t);
	const { models, faux } = await fauxModels(t);
	// A provider that always fails: durable retries, then the submission settles unanswered.
	faux.setResponses([
		() => {
			throw new Error("provider exploded");
		},
	]);
	const code = await main(["--print", "hi", "--home", home, "--model", "faux/faux-1"], { models });
	assert.equal(code, 1);
});

test("sessions persist across reopen (--continue) and keep the todo-free transcript", async (t) => {
	const home = await tempHome(t);
	const first = await fauxModels(t);
	first.faux.setResponses([fauxAssistantMessage("first answer")]);
	const code1 = await main(["--print", "first question", "--home", home, "--model", "faux/faux-1"], { models: first.models });
	assert.equal(code1, 0);

	const second = await fauxModels(t);
	second.faux.setResponses([
		(context) => {
			const history = JSON.stringify(context.messages);
			assert.match(history, /first question/);
			assert.match(history, /first answer/);
			return fauxAssistantMessage("second answer");
		},
	]);
	const code2 = await main(["--print", "second question", "--home", home, "--continue", "--model", "faux/faux-1"], {
		models: second.models,
	});
	assert.equal(code2, 0);
});

test("storage exclusivity: a held session storage refuses a second durable host", async (t) => {
	const home = await tempHome(t);
	const { models } = await fauxModels(t);
	const { sessionsDir } = resolveHome({ home });
	const sessionId = newSessionId();
	const lockDir = join(sessionsDir, sessionId);
	const held = await acquireSessionLock(lockDir);
	try {
		await assert.rejects(
			() => main(["--print", "x", "--home", home, "--session", sessionId, "--model", "faux/faux-1"], { models }),
			/owned by pid/,
		);
	} finally {
		held();
	}
});

test("runtime: reopen harness resumes committed entries from SQLite", async (t) => {
	const home = await tempHome(t);
	const { sessionsDir } = resolveHome({ home });
	const { models, faux } = await fauxModels(t, [
		(context) => {
			const system = context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("");
			assert.match(system, /You are Hodipor/);
			assert.match(system, /Working style/);
			assert.match(system, /Working directory/);
			return fauxAssistantMessage("committed answer");
		},
	]);
	const path = sessionStoragePath(sessionsDir, "resume-check");

	const first = await openRuntime({ sessionStoragePath: path, models, registry: createHodiporRegistry({ cwd: join(home, "workspace") }) });
	const root = await first.harness.root(RUN_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: join(home, "workspace") } });
	first.harness.resume();
	const settled = await (await root.submit({ type: "input", content: "remember this" }, RUN_CONTEXT)).wait(RUN_CONTEXT);
	assert.equal(settled.status, "done");
	await first.harness.close(RUN_CONTEXT);
	await first.release();

	const second = await openRuntime({ sessionStoragePath: path, models, registry: createHodiporRegistry({ cwd: join(home, "workspace") }) });
	const page = await second.harness.conversation(root.id, RUN_CONTEXT).then((c) => c.entries({}, 10, undefined, RUN_CONTEXT));
	const texts = page.items.flatMap((entry) => entry.model ?? []).map((m) => JSON.stringify(m));
	assert.match(texts.join(""), /remember this/);
	assert.match(texts.join(""), /committed answer/);
	await second.harness.close(RUN_CONTEXT);
	await second.release();
	// The persisted system prompt carried Hodipor identity into the reopened context, proving sections rendered.
	assert.equal(faux.state.callCount, 1);
});

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

async function waitFor(predicate, { timeoutMs = 15000, stepMs = 50 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(stepMs);
	}
	return false;
}

test("crash mid-tool: reopen takes over the stale lock, tool is not duplicated, run completes", async (t) => {
	const home = await tempHome(t);
	const marker = join(home, "marker.log");
	// The tool command runs under bash on every platform: backslashes in a Windows path would be
	// eaten by bash, so embed the marker with forward slashes (MSYS accepts drive-letter paths).
	const bashMarker = marker.replaceAll("\\", "/");
	const scriptPath = join(home, "faux-script.json");
	// The bash tool runs long enough to be killed mid-execution; marker lines count executions.
	await writeFile(scriptPath, JSON.stringify([
		{ toolCall: "bash", args: { command: `echo started >> ${bashMarker} && sleep 30 && echo done >> ${bashMarker}` } },
		"recovered after crash",
	]));

	const child = spawn(process.execPath, ["test/helper-faux-cli.mjs", scriptPath, "--print", "run the tool", "--home", home, "--model", "faux/faux-1"], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	const childErr = [];
	child.stderr.on("data", (chunk) => childErr.push(String(chunk)));

	// Kill before asserting: after hooks run FIFO and a failed hook skips the rest, so an early
	// assert would leave the child alive to race the cleanup rm for its SQLite handle.
	const started = await waitFor(() => existsSync(marker));
	child.kill("SIGKILL");
	await new Promise((resolve) => child.on("exit", resolve));
	assert(started, "tool started before the crash");

	// Reopen: the stale lock (dead pid) must be taken over, not refused. Recovery first finishes
	// the interrupted run (one call seeing the interrupted tool result), then answers the new input.
	const sessionIds = readdirSync(join(home, "sessions")).filter((name) => /^[a-z0-9-]+$/.test(name));
	assert.equal(sessionIds.length, 1);
	const { models } = await fauxModels(t, [
		(context) => {
			const history = JSON.stringify(context.messages);
			assert.match(history, /run the tool/);
			assert.match(history, /toolResult/);
			return fauxAssistantMessage("finished the interrupted run");
		},
		(context) => {
			assert.match(JSON.stringify(context.messages.findLast((m) => m.role === "user")), /continue now/);
			return fauxAssistantMessage("recovered after crash");
		},
	]);
	const code = await main(["--print", "continue now", "--home", home, "--session", sessionIds[0], "--model", "faux/faux-1"], { models });
	assert.equal(code, 0, `child stderr: ${childErr.join("")}`);
	// The killed bash ran exactly once; the interrupted attempt was not replayed.
	assert.equal(await readFile(marker, "utf8"), "started\n");
});
