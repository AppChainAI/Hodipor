// @ts-nocheck
import { defineDoc } from "@earendil-works/pi-durable";
import { applyTaskMutation } from "./reducer.mjs";

/**
 * The todo document: one list per conversation, committed transactionally with
 * the call receipt of every state-changing mutation. `rewindable` + fork `asOf`
 * make forks inherit the list at the fork point; a new session's conversation
 * starts from `initial`.
 */
export const TodoDoc = defineDoc({
	scope: "conversation",
	kind: "app.todo",
	version: 1,
	initial: () => ({ tasks: [], nextId: 1, receipts: {} }),
	history: "rewindable",
	fork: "asOf",
});

/** Retention target; unsettled calls must never be evicted merely to meet it. */
const MAX_RECEIPTS = 64;

export function stripReceipts(state) {
	const { receipts, ...rest } = state;
	return rest;
}

/**
 * Apply one mutation inside a transaction: read the doc, replay the receipt if
 * this call already committed (crash between state commit and result commit),
 * otherwise run the reducer, write the new state and the receipt atomically.
 * Returns the reducer outcome plus the post-state for formatting.
 */
export async function mutateTodo(tx, conversationId, callId, action, params, taskId) {
	const doc = await tx.doc(TodoDoc, conversationId);
	const receipt = doc.receipts?.[callId];
	if (receipt) {
		// Already applied by a previous execution of this same call: replay the recorded outcome.
		// Values are cloned inside the transaction: draft-backed objects cannot outlive the commit.
		return { op: clone(receipt.op), state: clone(stripReceipts(doc)), replayed: true };
	}
	const current = stripReceipts(doc);
	const result = apply(current, action, params);
	if (changesState(result.op)) {
		doc.tasks = result.state.tasks;
		doc.nextId = result.state.nextId;
		const receipts = { ...(doc.receipts ?? {}) };
		receipts[callId] = { op: result.op, ...(taskId ? { taskId } : {}) };
		let excess = Object.keys(receipts).length - MAX_RECEIPTS;
		for (const key of Object.keys(receipts)) {
			if (excess <= 0) break;
			const receiptTask = receipts[key].taskId;
			const task = receiptTask ? await tx.task(receiptTask) : undefined;
			if (task?.state.status === "terminal") {
				delete receipts[key];
				excess--;
			}
		}
		doc.receipts = receipts;
	}
	return { op: clone(result.op), state: clone(result.state), replayed: false };
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function apply(state, action, params) {
	return applyTaskMutation(state, action, params);
}

function changesState(op) {
	switch (op.kind) {
		case "create":
		case "delete":
		case "clear":
			return true;
		case "update":
			return op.changed;
		default:
			return false;
	}
}
