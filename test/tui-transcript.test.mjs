import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { AssistantMessageComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { attachTranscript } from "../src/tui/transcript.mjs";
import { createHodiporRegistry, openRuntime, RUN_CONTEXT } from "../src/runtime.mjs";

initTheme();
const fakeTui = { requestRender() {}, setFocus() {}, showOverlay() {}, invalidate() {} };

async function runtime(t, responses) {
	const home = await mkdtemp(join(tmpdir(), "hodipor-tui-"));
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const opened = await openRuntime({
		sessionStoragePath: join(home, "state.sqlite"),
		models,
		registry: createHodiporRegistry({ cwd: home }),
	});
	t.after(async () => {
		await opened.harness.close(RUN_CONTEXT);
		await opened.release();
	});
	// Registered after the close: hooks run FIFO, so SQLite is released before the home is removed,
	// and Windows gets EBUSY retries for handles released shortly before.
	t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	return opened;
}

test("projection: snapshot init, streaming deltas, tool components, entry appends", async (t) => {
	const { harness } = await runtime(t, [
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("final answer"),
	]);
	const root = await harness.root(RUN_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: process.cwd() } });
	harness.resume();

	const container = new Container();
	const busyChanges = [];
	let snapshots = 0;
	const handle = await attachTranscript({
		harness,
		conversationId: root.id,
		container,
		tui: fakeTui,
		onBusyChange: (busy) => busyChanges.push(busy),
		onSnapshotMeta: () => snapshots++,
	});

	const settled = await (await root.submit({ type: "input", content: "run something" }, RUN_CONTEXT)).wait(RUN_CONTEXT);
	assert.equal(settled.status, "done");
	await new Promise((resolve) => setTimeout(resolve, 100)); // let trailing event batches land

	const kinds = container.children.map((child) => child.constructor.name);
	assert.deepEqual(kinds, ["UserMessageComponent", "ToolExecutionComponent", "AssistantMessageComponent"]);
	assert(container.children[0] instanceof UserMessageComponent);
	assert(container.children[2] instanceof AssistantMessageComponent);
	assert(snapshots >= 1);
	assert(busyChanges.includes(true) && busyChanges.at(-1) === false);

	// Rendered lines contain the user text and the answer.
	const rendered = container.children.flatMap((child) => child.render(80)).join("\n");
	assert.match(rendered, /run something/);
	assert.match(rendered, /final answer/);
	assert.match(rendered, /\$ echo hi/);

	await handle.detach();
});

test("projection: a second attach rebuilds from the committed snapshot", async (t) => {
	const { harness } = await runtime(t, [
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo RESTORED_TOOL_OUTPUT" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("committed reply"),
	]);
	const root = await harness.root(RUN_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: process.cwd() } });
	harness.resume();
	await (await root.submit({ type: "input", content: "earlier question" }, RUN_CONTEXT)).wait(RUN_CONTEXT);

	const container = new Container();
	const handle = await attachTranscript({ harness, conversationId: root.id, container, tui: fakeTui });
	await new Promise((resolve) => setTimeout(resolve, 50));
	const rendered = container.children.flatMap((child) => child.render(80)).join("\n");
	assert.match(rendered, /earlier question/);
	assert.match(rendered, /committed reply/);
	assert.match(rendered, /RESTORED_TOOL_OUTPUT/);
	assert(container.children.some((child) => child.constructor.name === "ToolExecutionComponent"));
	await handle.detach();
});

test("projection: committed partial message deltas and appended tool output accumulate", async (t) => {
	const { harness } = await runtime(t, []);
	const root = await harness.root(RUN_CONTEXT, { agent: { cwd: process.cwd() } });
	const container = new Container();
	let meta;
	const handle = await attachTranscript({ harness, conversationId: root.id, container, tui: fakeTui, onSnapshotMeta: (value) => { meta = value; } });
	t.after(() => handle.detach());
	const rendered = () => container.children.flatMap((child) => child.render(100)).join("\n");
	async function until(check) {
		for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(check(), rendered());
	}
	await harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, root.id);
		live.generation = { taskId: "test-generation", message: fauxAssistantMessage("STREAM_FIRST") };
		live.tools = [{ callId: "test-call", name: "bash", taskId: "test-tool", status: "running", output: "" }];
	}, RUN_CONTEXT);
	await until(() => rendered().includes("STREAM_FIRST"));
	await harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, root.id);
		live.tools[0].output = "OUTPUT_FIRST ";
	}, RUN_CONTEXT);
	await until(() => rendered().includes("OUTPUT_FIRST"));
	await harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, root.id);
		live.generation.message.content[0].text += " STREAM_SECOND";
		live.tools[0].output += "OUTPUT_SECOND";
	}, RUN_CONTEXT);
	await until(() => rendered().includes("STREAM_SECOND"));
	assert.match(rendered(), /STREAM_FIRST STREAM_SECOND/);
	assert.match(rendered(), /OUTPUT_FIRST OUTPUT_SECOND/);
	await root.configure({ thinkingLevel: "high" }, RUN_CONTEXT);
	await until(() => meta.agent.thinkingLevel === "high");
});

test("projection: compaction commits update busy state even without a generation", async (t) => {
	const { harness } = await runtime(t, []);
	const root = await harness.root(RUN_CONTEXT, { agent: { cwd: process.cwd() } });
	const changes = [];
	const handle = await attachTranscript({ harness, conversationId: root.id, container: new Container(), tui: fakeTui, onBusyChange: (value) => changes.push(value) });
	t.after(() => handle.detach());
	await harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, root.id);
		live.compactions = [{ taskId: 123, reason: "manual", blocking: false }];
	}, RUN_CONTEXT);
	for (let i = 0; i < 100 && changes.at(-1) !== true; i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(changes.at(-1), true);
	await harness.commit(async (tx) => { (await tx.doc(LiveDoc, root.id)).compactions = []; }, RUN_CONTEXT);
	for (let i = 0; i < 100 && changes.at(-1) !== false; i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.deepEqual(changes, [false, true, false]);
});

test("projection: committed retry, deferred and compaction phases drive status and restore correctly", async t => {
	const { harness } = await runtime(t, []);
	const root = await harness.root(RUN_CONTEXT);
	const activities = [];
	let runs = 0;
	const handle = await attachTranscript({ harness, conversationId: root.id, container: new Container(), tui: fakeTui,
		onActivityChange: value => activities.push(value), onEvent: event => { if (event.type === "run_start") runs++; } });
	t.after(() => handle.detach());
	async function until(check) {
		for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert(check(), JSON.stringify(activities));
	}
	const at = Date.now() + 10000;
	await harness.commit(async tx => {
		const live = await tx.doc(LiveDoc, root.id);
		live.run = { taskId: 1, inputs: [1] };
		live.generation = { attempt: 2, retry: { at, error: "test backoff" } };
	}, RUN_CONTEXT);
	await until(() => activities.at(-1)?.kind === "retry");
	assert.equal(runs, 1);
	let restoredActivity;
	const restored = await attachTranscript({ harness, conversationId: root.id, container: new Container(), tui: fakeTui, onActivityChange: value => { restoredActivity = value; } });
	t.after(() => restored.detach());
	assert.deepEqual(restoredActivity, { kind: "retry", attempt: 2, at });
	await harness.commit(async tx => {
		const live = await tx.doc(LiveDoc, root.id);
		delete live.generation.retry;
		live.generation.deferred = { pollAt: at };
	}, RUN_CONTEXT);
	await until(() => activities.at(-1)?.kind === "deferred");
	await harness.commit(async tx => {
		const live = await tx.doc(LiveDoc, root.id);
		live.compactions = [{ taskId: 3, reason: "overflow", blocking: false, attempt: 0 }];
	}, RUN_CONTEXT);
	await until(() => activities.at(-1)?.kind === "compaction");
	assert.deepEqual(activities.at(-1), { kind: "compaction", reason: "overflow", taskId: 3 });
	await harness.commit(async tx => {
		const live = await tx.doc(LiveDoc, root.id);
		live.compactions = []; delete live.run; delete live.generation;
	}, RUN_CONTEXT);
	await until(() => activities.at(-1) === undefined);
});

test("projection: reset and compaction separators refresh cached theme colors", async t => {
	const { harness } = await runtime(t, []);
	const root = await harness.root(RUN_CONTEXT);
	await root.reset(undefined, RUN_CONTEXT);
	const container = new Container();
	const handle = await attachTranscript({ harness, conversationId: root.id, container, tui: fakeTui });
	t.after(() => handle.detach());
	initTheme("dark");
	container.invalidate();
	const dark = container.render(80).join("\n");
	initTheme("light");
	container.invalidate();
	const light = container.render(80).join("\n");
	assert.match(dark, /new context/);
	assert.notEqual(dark, light);
	initTheme();
});

test("projection: fork switches to the forked conversation view", async (t) => {
	const { harness } = await runtime(t, [fauxAssistantMessage("first branch")]);
	const root = await harness.root(RUN_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: process.cwd() } });
	harness.resume();
	await (await root.submit({ type: "input", content: "root question" }, RUN_CONTEXT)).wait(RUN_CONTEXT);

	const page = await root.entries({ order: "descending" }, 1, undefined, RUN_CONTEXT);
	const fork = await root.fork(page.items[0].id, { ownership: { kind: "ownerless" } }, RUN_CONTEXT);

	const container = new Container();
	const handle = await attachTranscript({ harness, conversationId: fork.id, container, tui: fakeTui });
	await new Promise((resolve) => setTimeout(resolve, 50));
	const rendered = container.children.flatMap((child) => child.render(80)).join("\n");
	// The fork inherits history up to the fork point.
	assert.match(rendered, /root question/);
	assert.match(rendered, /first branch/);
	await handle.detach();
});
