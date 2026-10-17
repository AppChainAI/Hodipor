#!/usr/bin/env node
// Test-only entry: the durable CLI whose todo tool commits its mutation, then
// hangs forever — crash-killing the process lands exactly between the doc
// commit and the tool-result commit, the window replay safety must survive.
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { main } from "../src/cli.mjs";
import { createTodoExtension } from "../extensions/todo/index.mjs";

const [scriptPath, markerPath] = process.argv.slice(2, 4);
const argv = process.argv.slice(4);
const script = JSON.parse(await readFile(scriptPath, "utf8"));
const responses = script.map((step) =>
	typeof step === "string"
		? fauxAssistantMessage(step)
		: fauxAssistantMessage(fauxToolCall(step.toolCall, step.args ?? {}), { stopReason: "toolUse" }),
);

const todo = createTodoExtension();
const original = todo.tools.find((tool) => tool.name === "todo");
const hanging = {
	...todo,
	tools: [
		{ ...original, execute: async (args, api, context) => {
			const result = await original.execute(args, api, context);
			await writeFile(markerPath, "committed", { flag: "wx" });
			await new Promise(() => {}); // never returns; the test SIGKILLs us here
		} },
	],
};

const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses(responses);
const models = createModels();
models.setProvider(faux.provider);

const code = await main(argv, { models, extensions: [hanging] });
process.exit(code ?? 0);
