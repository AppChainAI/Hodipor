import { join, resolve } from "node:path";
import { validateSessionId } from "./home.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export const RUN_CONTEXT = BACKGROUND_CONTEXT;

export const SIFTORY_IDENTITY =
	"You are Siftory, a general-purpose AI assistant. Help users answer questions, analyze information, write, and complete tasks using the available tools. Be concise and clear about uncertainty.";

/**
 * Baseline working discipline, independent of persona: downstream products may
 * replace the identity but should keep these rules unless they deliberately
 * opt out. Names only the tools the standard registry guarantees.
 */
export const SIFTORY_CONDUCT = `Working style:
- Use the tools to act on the real environment. Never claim to have created, changed, or run something you did not.
- Inspect before changing: read files and check current state before writing or editing.
- Prefer the dedicated tools (read, write, edit) over shell equivalents; reserve bash for what they cannot do.
- Before destructive or hard-to-reverse actions (delete, overwrite, force-push, kill), state exactly what will happen and ask for confirmation.
- External side effects (network calls, messages, payments) are not transactional: confirm before triggering them, then report precisely what was done.

Response style:
- Lead with the answer or the action taken; stay concise.
- Separate observed facts from inference; state uncertainty where it exists.
- When an ambiguity changes the outcome, ask one precise question instead of guessing.`;

/** Siftory's own identity, working discipline, and working-directory context, next to the coding tools. */
/**
 * @param {{ identity?: string; conduct?: string; extraSections?: import("@earendil-works/pi-durable").PromptSection[] }} [options]
 */
export function createPersonaExtension({ identity = SIFTORY_IDENTITY, conduct = SIFTORY_CONDUCT, extraSections = [] } = {}) {
	return defineExtension({
		name: "siftory",
		sections: [
			section("siftory-identity", () => identity, { tag: false }),
			...(conduct ? [section("siftory-conduct", () => conduct, { tag: false })] : []),
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
	validateSessionId(sessionId);
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
	const env = (target) => new NodeExecutionEnv({ cwd: resolve(target.cwd ?? process.cwd()) });
	try {
		const harness = await Harness.open(
			storage,
			{ models, registry, env, ...(conversationCreated ? { conversationCreated } : {}), ...(onReport ? { onReport } : {}) },
			RUN_CONTEXT,
		);
		return { harness, release: () => storage.close(RUN_CONTEXT) };
	} catch (error) {
		await storage.close(RUN_CONTEXT);
		throw error;
	}
}
