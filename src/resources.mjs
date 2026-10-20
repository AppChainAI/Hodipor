import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { section } from "@earendil-works/pi-durable";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Hodipor resources: skills discovery and project context files from Pi's own
 * loaders, delivered as durable prompt sections. Skill bodies stay on disk and
 * load on explicit /skill:name invocation, exactly like Pi.
 */
/**
 * @param {{ cwd: string; agentDir: string }} options
 */
export function createResourceSections({ cwd, agentDir }) {
	const sections = [
		section(
			"skills",
			(input) => {
				const { skills } = loadSkills({ cwd: input.env?.cwd ?? cwd, agentDir, skillPaths: [], includeDefaults: true });
				return skills.length > 0 ? formatSkillsForPrompt(skills) : undefined;
			},
			{ tag: false },
		),
		section(
			"project-context",
			(input) => {
				const files = loadProjectContextFiles({ cwd: input.env?.cwd ?? cwd, agentDir });
				if (files.length === 0) return undefined;
				return files.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`).join("\n\n");
			},
			{ tag: false },
		),
	];
	return sections;
}

/**
 * Expand /skill:name input: the skill body prefixes the remaining prompt.
 * @param {import("@earendil-works/pi-coding-agent").Skill[]} skills
 * @param {string} text
 */
export async function expandSkillInvocation(skills, text) {
	if (!text.startsWith("/skill:")) return text;
	const name = text.slice(7).split(/\s+/)[0];
	const rest = text.slice(7 + name.length).trim();
	const skill = skills.find((s) => s.name === name);
	if (!skill) throw new Error(`unknown skill: ${name}`);
	const body = stripFrontmatter(await readFile(skill.filePath, "utf8"));
	return `${body.trim()}\n\n${rest}`;
}

/**
 * @param {{ cwd: string; agentDir: string }} options
 */
export function listSkills({ cwd, agentDir }) {
	return loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills;
}

/**
 * Expand a prompt-template command: /name args → the template body with $ARGUMENTS replaced.
 * @param {string} agentDir @param {string} line
 */
export async function expandPromptTemplate(agentDir, line) {
	if (!line.startsWith("/")) return undefined;
	const name = line.slice(1).split(/\s+/)[0];
	if (!/^[-\w]+$/.test(name)) return undefined;
	let files;
	try {
		files = await readdir(join(agentDir, "prompts"));
	} catch {
		return undefined;
	}
	if (!files.includes(`${name}.md`)) return undefined;
	const raw = await readFile(join(agentDir, "prompts", `${name}.md`), "utf8");
	const { body } = parseFrontmatter(raw);
	const args = line.slice(1 + name.length).trim();
	return body.replaceAll("$ARGUMENTS", args);
}
