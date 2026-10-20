import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { section } from "@earendil-works/pi-durable";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Hodipor resources: skills discovery and project context files from Pi's own
 * loaders, delivered as durable prompt sections. Skill bodies stay on disk and
 * load on explicit /skill:name invocation, exactly like Pi.
 */
/**
 * Agent Skills standard locations (agentskills.io), matching Codex/OpenCode/Pi:
 * project `<dir>/.agents/skills` discovered from the working directory up
 * through its ancestors, stopping at the repository root (a directory
 * containing `.git`) when one exists, plus the user-level `~/.agents/skills`.
 * Nearest project directory first so it wins name collisions; the global user
 * directory comes last. Pinned pi-coding-agent@1.3.0 `loadSkills` only scans
 * `<agentDir>/skills` and `<cwd>/.pi/skills` by default, so these are passed
 * as explicit skillPaths.
 * @param {string} cwd
 */
function agentsSkillPaths(cwd) {
	const paths = [];
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, ".agents", "skills");
		if (existsSync(candidate)) paths.push(candidate);
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const userSkills = join(homedir(), ".agents", "skills");
	if (existsSync(userSkills) && !paths.includes(userSkills)) paths.push(userSkills);
	return paths;
}

/**
 * @param {{ cwd: string; agentDir: string }} options
 */
function loadAllSkills({ cwd, agentDir }) {
	return loadSkills({ cwd, agentDir, skillPaths: agentsSkillPaths(cwd), includeDefaults: true }).skills;
}

/**
 * @param {{ cwd: string; agentDir: string }} options
 */
export function createResourceSections({ cwd, agentDir }) {
	const sections = [
		section(
			"skills",
			(input) => {
				const skills = loadAllSkills({ cwd: input.env?.cwd ?? cwd, agentDir });
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
	return loadAllSkills({ cwd, agentDir });
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
