import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { main } from "../src/cli.mjs";
import { TodoDoc, stripReceipts } from "../extensions/todo/index.mjs";

async function waitFor(predicate, { timeoutMs = 15000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(50);
	}
	return false;
}

/**
 * The crash window replay safety must survive: the todo mutation and its call
 * receipt are committed, the tool result is not, the process dies. On reopen
 * the replay-safe tool reruns, hits its receipt, and returns the original
 * outcome without executing the reducer again — exactly one task created.
 */
test("todo create survives a crash between state commit and result commit", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "hodipor-todo-crash-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const marker = join(home, "committed.marker");
	const scriptPath = join(home, "faux.json");
	await writeFile(scriptPath, JSON.stringify([{ toolCall: "todo", args: { action: "create", subject: "crash survivor" } }, "never reached"]));

	const child = spawn(
		process.execPath,
		["test/helper-todo-crash.mjs", scriptPath, marker, "--print", "track something", "--home", home, "--model", "faux/faux-1"],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(() => child.kill("SIGKILL"));
	const exited = new Promise((resolve) => child.once("exit", resolve));
	const childErr = [];
	child.stderr.on("data", (chunk) => childErr.push(String(chunk)));
	assert(await waitFor(() => existsSync(marker)), "todo doc committed before the crash");
	child.kill("SIGKILL");
	await exited;

	const sessionId = readdirSync(join(home, "sessions"))[0];
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	// Two calls: recovery first finishes the interrupted run (rerunning the todo tool),
	// then the new input is answered.
	faux.setResponses([fauxAssistantMessage("interrupted run finished"), fauxAssistantMessage("recovered after replay")]);
	const models = createModels();
	models.setProvider(faux.provider);

	const chunks = [];
	t.mock.method(process.stdout, "write", (chunk) => {
		chunks.push(String(chunk));
		return true;
	});
	const code = await main(["--print", "continue", "--home", home, "--session", sessionId, "--model", "faux/faux-1"], { models });
	assert.equal(code, 0, `child stderr: ${childErr.join("")}`);
	assert.match(chunks.join(""), /recovered after replay/);

	const { openRuntime, createHodiporRegistry, RUN_CONTEXT } = await import("../src/runtime.mjs");
	const opened = await openRuntime({
		sessionStoragePath: join(home, "sessions", sessionId, "state.sqlite"),
		models,
		registry: createHodiporRegistry({ cwd: home }),
	});
	t.after(() => opened.harness.close(RUN_CONTEXT).catch(() => {}));
	const conversationId = (await opened.harness.commit((tx) => tx.scanConversations({}, 1), RUN_CONTEXT)).items[0].id;
	const state = stripReceipts(await opened.harness.snapshot(TodoDoc, conversationId, RUN_CONTEXT));
	assert.equal(state.tasks.length, 1, "no duplicate task after replay");
	assert.equal(state.tasks[0].subject, "crash survivor");
	assert.equal(state.nextId, 2);
	// The replayed call produced exactly one committed tool result.
	const conversation = await opened.harness.conversation(conversationId, RUN_CONTEXT);
	const page = await conversation.entries({}, 100, undefined, RUN_CONTEXT);
	const created = page.items.filter(
		(entry) => entry.kind === "pi.tool-result" && JSON.stringify(entry.model ?? []).includes("Created #1"),
	);
	assert.equal(created.length, 1, `tool results: ${created.length}`);
});
