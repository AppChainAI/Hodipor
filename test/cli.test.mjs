import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("launcher: help, version, and unknown-option handling", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "siftory-cli-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const run = (args, envOverrides = {}) => {
		const result = spawnSync(process.execPath, [cli, ...args], {
			cwd: root,
			encoding: "utf8",
			timeout: 20_000,
			env: { ...process.env, ...envOverrides },
		});
		assert.ifError(result.error);
		return result;
	};
	const help = run(["--help"]);
	assert.equal(help.status, 0);
	assert.match(help.stdout, /--home/);
	assert.match(help.stdout, /--cwd/);
	assert.match(run(["--version"]).stdout, /durable/);
	const bad = run(["--nope"]);
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /unknown option/);
	// No model configured and none available: a clean failure, not a crash. Strip credentials
	// so a developer's own env keys cannot make this machine-dependent.
	const sterileEnv = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !/_API_KEY$|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GROQ_|^XAI_|^MOONSHOT_|^ZAI_|^MISTRAL_|^OPENROUTER_/.test(key)),
	);
	const empty = spawnSync(process.execPath, [cli, "--print", "hi", "--home", join(root, "h")], {
		cwd: root,
		encoding: "utf8",
		timeout: 20_000,
		env: sterileEnv,
	});
	assert.ifError(empty.error);
	assert.equal(empty.status, 1);
	assert.match(empty.stderr, /no model available/);
});
