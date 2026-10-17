import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantMessageComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { attachTranscript } from "../src/tui/transcript.mjs";
import { createSiftoryRegistry, openRuntime, RUN_CONTEXT } from "../src/runtime.mjs";

initTheme();
const fakeTui = { requestRender() {}, setFocus() {}, showOverlay() {}, invalidate() {} };

async function runtime(t, responses) {
	const home = await mkdtemp(join(tmpdir(), "siftory-tui-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const opened = await openRuntime({
		sessionStoragePath: join(home, "state.sqlite"),
		models,
		registry: createSiftoryRegistry({ cwd: home }),
	});
	t.after(() => opened.harness.close(RUN_CONTEXT).catch(() => {}));
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
	assert.match(rendered, /bash/);

	await handle.detach();
});

test("projection: a second attach rebuilds from the committed snapshot", async (t) => {
	const { harness } = await runtime(t, [fauxAssistantMessage("committed reply")]);
	const root = await harness.root(RUN_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: process.cwd() } });
	harness.resume();
	await (await root.submit({ type: "input", content: "earlier question" }, RUN_CONTEXT)).wait(RUN_CONTEXT);

	const container = new Container();
	const handle = await attachTranscript({ harness, conversationId: root.id, container, tui: fakeTui });
	await new Promise((resolve) => setTimeout(resolve, 50));
	const rendered = container.children.flatMap((child) => child.render(80)).join("\n");
	assert.match(rendered, /earlier question/);
	assert.match(rendered, /committed reply/);
	await handle.detach();
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
