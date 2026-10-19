import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, LiveDoc, MemoryStorage, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Container } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTodoExtension } from "../extensions/todo/index.mjs";
import { createSiftoryRegistry, RUN_CONTEXT } from "../src/runtime.mjs";
import { attachTranscript } from "../src/tui/transcript.mjs";

initTheme("dark");
const tui = { requestRender() {}, invalidate() {} };
const render = container => stripAnsi(container.render(100).join("\n"));

async function fixture(t, responses, extensions = []) {
	const cwd = await mkdtemp(join(tmpdir(), "siftory-display-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(responses);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createSiftoryRegistry();
	registry.install(createTodoExtension());
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
	for (const extension of extensions) registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, RUN_CONTEXT);
	t.after(() => harness.close(RUN_CONTEXT));
	const root = await harness.root(RUN_CONTEXT, { agent: { cwd, model: { provider: "faux", modelId: "faux-1" } } });
	const container = new Container();
	const projection = await attachTranscript({ harness, conversationId: root.id, container, tui });
	t.after(() => projection.detach());
	harness.resume();
	return { harness, root, container, projection };
}

async function submit(root) {
	const result = await (await root.submit({ type: "input", content: "check the display" }, RUN_CONTEXT)).wait(RUN_CONTEXT);
	assert.equal(result.status, "done");
	await new Promise(resolve => setTimeout(resolve, 30));
}

test("shell cards use native call rendering instead of raw parameter JSON", async (t) => {
	const f = await fixture(t, [fauxAssistantMessage(fauxToolCall("bash", { command: "printf SHELL_DISPLAY_OK" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await submit(f.root);
	assert.match(render(f.container), /\$ printf SHELL_DISPLAY_OK/);
	assert.doesNotMatch(render(f.container), /"command"\s*:/);
});

test("tool expansion uses the native bounded preview and survives snapshot reattachment", async (t) => {
	const command = "printf 'FIRST_OUTPUT\\n" + "middle\\n".repeat(16) + "LAST_OUTPUT\\n'";
	const f = await fixture(t, [fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await submit(f.root);
	const collapsed = render(f.container);
	f.projection.setToolsExpanded(true);
	const expanded = render(f.container);
	assert.ok(expanded.split("\n").length > collapsed.split("\n").length + 8);
	assert.match(expanded, /LAST_OUTPUT/);
	const restored = new Container();
	const handle = await attachTranscript({ harness: f.harness, conversationId: f.root.id, container: restored, tui, expandedTools: true });
	t.after(() => handle.detach());
	assert.equal(render(restored), expanded);
});

test("a successful generic nested tool uses its committed result rather than interrupted", async (t) => {
	const parent = defineExtension({ name: "nested-test", tools: [defineTool({
		name: "parent", description: "Call a child", parameters: Type.Object({}),
		execute: async (_, api, context) => {
			await api.executeTool("todo", { action: "create", subject: "NESTED_SUCCESS" }, context, { key: "child" });
			return { output: [{ type: "text", text: "parent done" }] };
		},
	})] });
	const f = await fixture(t, [fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")], [parent]);
	await submit(f.root);
	assert.match(render(f.container), /NESTED_SUCCESS/);
	assert.doesNotMatch(render(f.container), /interrupted/);
});

test("missing tool receipts are labelled unavailable rather than inventing an interruption", async (t) => {
	const f = await fixture(t, []);
	await f.harness.commit(async tx => {
		(await tx.doc(LiveDoc, f.root.id)).tools = [{ callId: "missing", name: "bash", status: "running" }];
	}, RUN_CONTEXT);
	await f.harness.commit(async tx => { (await tx.doc(LiveDoc, f.root.id)).tools = []; }, RUN_CONTEXT);
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.match(render(f.container), /result unavailable/);
	assert.doesNotMatch(render(f.container), /interrupted/);
});

test("todo update cards resolve committed subjects live and after reattaching", async t => {
	const f = await fixture(t, [
		fauxAssistantMessage(fauxToolCall("todo", { action: "create", subject: "CARD_SUBJECT" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("todo", { action: "update", id: 1, status: "completed" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await submit(f.root);
	assert.match(render(f.container), /todo → CARD_SUBJECT/);
	assert.match(render(f.container), /● completed/);
	const restored = new Container();
	const handle = await attachTranscript({ harness: f.harness, conversationId: f.root.id, container: restored, tui });
	t.after(() => handle.detach());
	assert.equal(render(restored), render(f.container));
});

test("thinking folding applies to existing, later and reopened assistant messages", async t => {
	const message = suffix => ({ ...fauxAssistantMessage(`ANSWER_${suffix}`), content: [{ type: "thinking", thinking: `THINKING_${suffix}` }, { type: "text", text: `ANSWER_${suffix}` }] });
	const f = await fixture(t, [message("FIRST"), message("SECOND")]);
	await submit(f.root);
	assert.match(render(f.container), /THINKING_FIRST/);
	f.projection.setHideThinking(true);
	assert.doesNotMatch(render(f.container), /THINKING_FIRST/);
	await submit(f.root);
	assert.doesNotMatch(render(f.container), /THINKING_SECOND/);
	assert.match(render(f.container), /ANSWER_SECOND/);
	const restored = new Container();
	const handle = await attachTranscript({ harness: f.harness, conversationId: f.root.id, container: restored, tui, hideThinking: true });
	t.after(() => handle.detach());
	assert.equal(render(restored), render(f.container));
	f.projection.setHideThinking(false);
	assert.match(render(f.container), /THINKING_FIRST/);
	assert.match(render(f.container), /THINKING_SECOND/);
});

test("codemode nested statuses and details are identical live and after reattaching", async (t) => {
	const code = 'await tools.todo({action:"create",subject:"CODEMODE_TASK"}); await tools.todo({action:"update",id:999,status:"completed"}); console.log("CODEMODE_OUTPUT");';
	const f = await fixture(t, [fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await submit(f.root);
	const live = render(f.container);
	assert.match(live, /✓ todo/);
	assert.match(live, /✗ todo/);
	assert.doesNotMatch(live, /interrupted/);
	await f.projection.detach();
	const restored = new Container();
	const handle = await attachTranscript({ harness: f.harness, conversationId: f.root.id, container: restored, tui });
	t.after(() => handle.detach());
	assert.equal(render(restored), live);
});
