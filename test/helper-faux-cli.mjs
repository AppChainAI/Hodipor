#!/usr/bin/env node
// Test-only entry: the durable CLI wired to the scripted faux provider, so a
// subprocess can be crash-killed mid-run without real credentials.
import { readFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { main } from "../src/cli.mjs";

const scriptPath = process.argv[2];
const argv = process.argv.slice(3);
const script = JSON.parse(await readFile(scriptPath, "utf8"));
const responses = script.map((step) => {
	if (typeof step === "string") return fauxAssistantMessage(step);
	if (step.toolCall) return fauxAssistantMessage(fauxToolCall(step.toolCall, step.args ?? {}), { stopReason: "toolUse" });
	if (step.throw) return () => Promise.reject(new Error(step.throw));
	throw new Error(`bad script step: ${JSON.stringify(step)}`);
});

const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
faux.setResponses(responses);
const models = createModels();
models.setProvider(faux.provider);
// The public snapshot/refresh surface the native model menu consumes.
models.getAvailableSnapshot = () => models.getModels("faux");
models.refresh = async () => ({ aborted: false, errors: new Map() });
models.getError = () => undefined;

const code = await main(argv, { models });
process.exit(code ?? 0);
