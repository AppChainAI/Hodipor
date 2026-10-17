import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { applyTaskMutation, selectTodoCounts } from "../reducer.mjs";
import { TodoDoc, mutateTodo, stripReceipts } from "../state.mjs";
import { createTodoExtension } from "../index.mjs";
import { formatContent, formatTodoSummary, renderTodoPanel } from "../view.mjs";

const EMPTY = { tasks: [], nextId: 1 };

test("reducer: create/update/delete lifecycle with validation", () => {
	const created = applyTaskMutation(EMPTY, "create", { subject: "Research existing tool", activeForm: "researching" });
	assert.equal(created.op.kind, "create");
	assert.equal(created.state.tasks[0].status, "pending");

	const badTransition = applyTaskMutation(created.state, "update", { id: 1, status: "in_progress" });
	assert.equal(badTransition.op.kind, "update");
	const completed = applyTaskMutation(badTransition.state, "update", { id: 1, status: "completed" });
	assert.equal(completed.op.kind, "update");
	assert.equal(completed.state.tasks[0].status, "completed");

	// completed cannot go back
	assert.equal(applyTaskMutation(completed.state, "update", { id: 1, status: "in_progress" }).op.kind, "error");
	// id required
	assert.equal(applyTaskMutation(completed.state, "update", { status: "pending" }).op.kind, "error");
	// no-effect update reports "no change", not an error
	const noop = applyTaskMutation(completed.state, "update", { id: 1, status: "completed" });
	assert.equal(noop.op.changed, false);
	// unknown task
	assert.equal(applyTaskMutation(completed.state, "delete", { id: 42 }).op.kind, "error");
});

test("reducer: blockedBy dangling refs, self-block, and cycles are rejected", () => {
	const withTask = applyTaskMutation(EMPTY, "create", { subject: "a" }).state;
	assert.equal(applyTaskMutation(withTask, "create", { subject: "b", blockedBy: [9] }).op.kind, "error");
	assert.equal(applyTaskMutation(withTask, "update", { id: 1, addBlockedBy: [1] }).op.kind, "error");

	const two = applyTaskMutation(withTask, "create", { subject: "b" }).state;
	const blocked = applyTaskMutation(two, "update", { id: 2, addBlockedBy: [1] });
	assert.equal(blocked.op.kind, "update");
	assert.deepEqual(blocked.state.tasks[1].blockedBy, [1]);
	// 1 blocked by 2 would close the cycle 1 → 2 → 1
	assert.equal(applyTaskMutation(blocked.state, "update", { id: 1, addBlockedBy: [2] }).op.kind, "error");
});

test("reducer: clear resets, tombstones filter from counts", () => {
	const state = applyTaskMutation(applyTaskMutation(EMPTY, "create", { subject: "a" }).state, "create", { subject: "b" }).state;
	const deleted = applyTaskMutation(state, "delete", { id: 1 });
	assert.equal(deleted.state.tasks[0].status, "deleted");
	assert.equal(selectTodoCounts(deleted.state).total, 1);
	const cleared = applyTaskMutation(deleted.state, "clear");
	assert.deepEqual(cleared.state, EMPTY);
	assert.equal(formatContent(cleared.op, deleted.state), "Cleared 2 tasks");
});

async function todoHarness(t, responses) {
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createTodoExtension());
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	t.after(() => harness.close(BACKGROUND_CONTEXT).catch(() => {}));
	return { harness, faux };
}

test("tool: mutations commit to the doc and replay by call receipt", async (t) => {
	const { harness } = await todoHarness(t, []);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

	const first = await mutateTodoInCommit(harness, root.id, "call-1", "create", { subject: "only once" });
	assert.equal(first.op.kind, "create");
	assert.equal(first.replayed, false);

	// A rerun of the same call (crash recovery) replays the receipt instead of creating twice.
	const rerun = await mutateTodoInCommit(harness, root.id, "call-1", "create", { subject: "only once" });
	assert.equal(rerun.replayed, true);
	assert.equal(JSON.stringify(rerun.op), JSON.stringify(first.op));

	const state = await harness.snapshot(TodoDoc, root.id, BACKGROUND_CONTEXT);
	assert.equal(stripReceipts(state).tasks.length, 1);
	assert.equal(state.receipts["call-1"].op.kind, "create");
});

async function mutateTodoInCommit(harness, conversationId, callId, action, params) {
	return harness.commit((tx) => mutateTodo(tx, conversationId, callId, action, params), BACKGROUND_CONTEXT);
}

test("tool: end-to-end through the model, panel, fork inheritance, and fresh conversations", async (t) => {
	const { harness } = await todoHarness(t, [
		(context) => {
			assert.match(JSON.stringify(context.messages.filter((m) => m.role === "system")), /Manage a task list/);
			return fauxAssistantMessage(fauxToolCall("todo", { action: "create", subject: "port the reducer", activeForm: "porting" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxToolCall("todo", { action: "update", id: 1, status: "in_progress" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("todo", { action: "list" }), { stopReason: "toolUse" }),
		(context) => {
			const last = context.messages.findLast((m) => m.role === "toolResult");
			const text = JSON.stringify(last.content);
			assert.match(text, /#1 port the reducer/);
			return fauxAssistantMessage("tracked");
		},
	]);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	const settled = await (await root.submit({ type: "input", content: "track this" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	assert.equal(settled.status, "done");

	const state = stripReceipts(await harness.snapshot(TodoDoc, root.id, BACKGROUND_CONTEXT));
	assert.equal(state.tasks[0].status, "in_progress");
	const panel = renderTodoPanel(state);
	assert.match(panel.join("\n"), /Todos 0\/1/);
	assert.match(panel.join("\n"), /◐ #1 port the reducer — porting/);

	// Fork inherits the list at the fork point.
	const page = await root.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
	const fork = await root.fork(page.items[0].id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	const forkState = stripReceipts(await harness.snapshot(TodoDoc, fork.id, BACKGROUND_CONTEXT));
	assert.deepEqual(forkState.tasks.map((task) => task.subject), ["port the reducer"]);

	// A fresh conversation starts empty: the doc materializes on first write.
	const fresh = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	assert.equal(await harness.snapshot(TodoDoc, fresh.id, BACKGROUND_CONTEXT), undefined);
});

test("receipts stay bounded", async (t) => {
	const { harness } = await todoHarness(t, []);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	for (let i = 0; i < 80; i++) {
		await mutateTodoInCommit(harness, root.id, `call-${i}`, "create", { subject: `task ${i}` });
	}
	const state = await harness.snapshot(TodoDoc, root.id, BACKGROUND_CONTEXT);
	assert.ok(Object.keys(state.receipts).length <= 64, `receipts: ${Object.keys(state.receipts).length}`);
	assert.equal(state.tasks.length, 80);
	// The evicted oldest receipt re-executes as a fresh create: bounded memory, no false replay.
	const again = await mutateTodoInCommit(harness, root.id, "call-0", "create", { subject: "task 0" });
	assert.equal(again.replayed, false);
	assert.equal(again.op.kind, "create");
});

test("view: /todos groups by status with counts, indent, and block refs", () => {
	const state = {
		tasks: [
			{ id: 1, subject: "research", status: "pending", blockedBy: [3] },
			{ id: 2, subject: "implement", status: "in_progress", activeForm: "coding" },
			{ id: 3, subject: "design", status: "completed" },
			{ id: 4, subject: "dropped", status: "deleted" },
		],
		nextId: 5,
	};
	const out = formatTodoSummary(state);
	const lines = out.split("\n");
	assert.equal(lines[0], "1/3 completed · 1 in progress · 1 pending");
	assert.deepEqual(lines, [
		lines[0],
		"── Pending ──",
		"  ○ #1 research    ⛓ #3",
		"── In Progress ──",
		"  ◐ #2 implement (coding)",
		"── Completed ──",
		"  ✓ #3 design",
	]);
	// Empty state
	assert.equal(formatTodoSummary({ tasks: [], nextId: 1 }), "No todos yet. Ask the agent to add some!");
});
