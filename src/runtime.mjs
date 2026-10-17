import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export const RUN_CONTEXT = BACKGROUND_CONTEXT;

export const SIFTORY_IDENTITY =
	"You are Siftory, a general-purpose AI assistant. Help users answer questions, analyze information, write, and complete tasks using the available tools. Be concise and clear about uncertainty.";

/** Siftory's own identity and working-directory context, next to the coding tools. */
/**
 * @param {{ identity?: string; extraSections?: import("@earendil-works/pi-durable").PromptSection[] }} [options]
 */
export function createPersonaExtension({ identity = SIFTORY_IDENTITY, extraSections = [] } = {}) {
	return defineExtension({
		name: "siftory",
		sections: [
			section("siftory-identity", () => identity, { tag: false }),
			section("cwd", (input) => (input.env?.cwd ? `Working directory: ${input.env.cwd}` : undefined), { tag: false }),
			...extraSections,
		],
	});
}

/** The standard Siftory registry: coding tools plus the persona extension. */
/** @param {{ cwd: string; extraSections?: import("@earendil-works/pi-durable").PromptSection[] }} [personaOptions] */
/** @param {{ cwd?: string; identity?: string; extraSections?: import("@earendil-works/pi-durable").PromptSection[] }} [personaOptions] */
export function createSiftoryRegistry(personaOptions = {}) {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createPersonaExtension(personaOptions));
	return registry;
}

/** @param {string} sessionsDir @param {string} sessionId */
export function sessionStoragePath(sessionsDir, sessionId) {
	return join(sessionsDir, sessionId, "state.sqlite");
}

/**
 * Open the durable runtime for one session storage: Harness + SQLite + coding
 * tools + persona. The registry is assembled by the caller so resources and
 * extensions can extend it without changing this seam.
 */
/**
 * @param {{ sessionStoragePath: string; models: import("@earendil-works/pi-ai").Models; registry: import("@earendil-works/pi-durable").Registry; conversationCreated?: import("@earendil-works/pi-durable").HarnessOptions["conversationCreated"]; onReport?: (error: unknown) => void }} options
 */
export async function openRuntime({ sessionStoragePath: path, models, registry, conversationCreated, onReport }) {
	const storage = await openNodeSqliteStorage(path);
	// shortcut: durable hands the conversation's agent cwd back into env.exec; NodeExecutionEnv re-joins relative cwd, so hosts must only ever set absolute cwd.
	/** @param {import("@earendil-works/pi-durable").EnvTarget} target */
	const env = (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() });
	const harness = await Harness.open(
		storage,
		{ models, registry, env, ...(conversationCreated ? { conversationCreated } : {}), ...(onReport ? { onReport } : {}) },
		RUN_CONTEXT,
	);
	return { harness, release: () => storage.close(RUN_CONTEXT) };
}
