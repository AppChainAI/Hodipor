import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createPersonaExtension } from "../src/runtime.mjs";
import { createResourceSections, expandSkillInvocation, listSkills } from "../src/resources.mjs";

async function fixture(t) {
	const home = await mkdtemp(join(tmpdir(), "hodipor-res-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const cwd = join(home, "project");
	const agentDir = join(home, "agent");
	await mkdir(join(agentDir, "skills", "fixture-skill"), { recursive: true });
	await writeFile(
		join(agentDir, "skills", "fixture-skill", "SKILL.md"),
		"---\nname: fixture-skill\ndescription: Use for fixture checks.\n---\nSKILL_BODY_MARKER\n",
	);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_MARKER\n");
	return { home, cwd, agentDir };
}

function registryWith(cwd, agentDir) {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createPersonaExtension({ cwd, extraSections: createResourceSections({ cwd, agentDir }) }));
	return registry;
}

test("skills and project context land in the system prompt; bodies load on /skill:name only", async (t) => {
	const { cwd, agentDir } = await fixture(t);
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		(context) => {
			const system = JSON.stringify(context.messages.filter((m) => m.role === "system"));
			assert.match(system, /You are Hodipor/);
			assert.match(system, /fixture-skill/);
			assert.doesNotMatch(system, /SKILL_BODY_MARKER/);
			assert.match(system, /PROJECT_CONTEXT_MARKER/);
			return fauxAssistantMessage("sections ok");
		},
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: registryWith(cwd, agentDir) }, BACKGROUND_CONTEXT);
	t.after(() => harness.close(BACKGROUND_CONTEXT).catch(() => {}));
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd } });
	harness.resume();
	const settled = await (await root.submit({ type: "input", content: "check sections" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	assert.equal(settled.status, "done");

	const skills = listSkills({ cwd, agentDir });
	assert.equal(skills.length, 1);
	assert.equal(skills[0].name, "fixture-skill");
	const expanded = await expandSkillInvocation(skills, "/skill:fixture-skill do the thing");
	assert.match(expanded, /SKILL_BODY_MARKER/);
	assert.match(expanded, /do the thing/);
	await assert.rejects(() => expandSkillInvocation(skills, "/skill:missing x"), /unknown skill: missing/);
});
