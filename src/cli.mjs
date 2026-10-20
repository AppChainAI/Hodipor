#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** @param {string[]} argv */
export function parseCliArgs(argv) {
	/** @type {{ home?: string; cwd?: string; model?: string; continueLatest: boolean; print: boolean; help: boolean; version: boolean; session?: string; prompt?: string }} */
	const options = { home: undefined, cwd: undefined, model: undefined, continueLatest: false, print: false, help: false, version: false, session: undefined };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--home") options.home = value(argv, ++i, arg);
		else if (arg === "--cwd") options.cwd = value(argv, ++i, arg);
		else if (arg === "--model" || arg === "-m") options.model = value(argv, ++i, arg);
		else if (arg === "--session") options.session = value(argv, ++i, arg);
		else if (arg === "--continue" || arg === "-c") options.continueLatest = true;
		else if (arg === "--print" || arg === "-p") options.print = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--version" || arg === "-v") options.version = true;
		else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
		else positional.push(arg);
	}
	if (positional.length > 1) throw new Error(`unexpected extra arguments: ${positional.slice(1).join(" ")}`);
	options.prompt = positional[0];
	return options;
}

/** @param {string[]} argv @param {number} index @param {string} flag */
function value(argv, index, flag) {
	const v = argv[index];
	if (!v || v.startsWith("-")) throw new Error(`${flag} requires a value`);
	return v;
}

/** A piped stdout/stderr is async on Windows; plain writes are lost when the caller exits right after.
 * @param {import("node:stream").Writable} stream
 * @param {string} text
 * @returns {Promise<void>}
 */
function emit(stream, text) {
	return /** @type {Promise<void>} */ (new Promise((resolve) => {
		stream.write(text, () => resolve());
	}));
}

const USAGE = `Hodipor — a general-purpose, durable-native terminal agent.

Usage:
  hodipor [prompt] [options]

Options:
  --home <dir>        Application root: config, credentials, sessions (default ~/.hodipor)
  --cwd <dir>         Tool working directory (default <home>/workspace)
  --model, -m <p/m>   Model as provider/model[:thinking]
  --session <id>      Open a specific session storage
  --continue, -c      Continue the most recent session
  --print, -p         Print mode: answer one prompt and exit
  --help, --version

Without --print and without a TTY, the prompt is read from stdin.`;

/**
 * CLI entry. `inject.models` is the test seam (faux provider); production
 * builds the Pi ModelRuntime over the Hodipor home.
 */
/**
 * @param {string[]} [argv]
 * @param {{ models?: import("@earendil-works/pi-ai").Models; extensions?: import("@earendil-works/pi-durable").Extension[] }} [inject]
 */
export async function main(argv = process.argv.slice(2), inject = {}) {
	let options;
	try {
		options = parseCliArgs(argv);
	} catch (/** @type {any} */ error) {
		await emit(process.stderr, `hodipor: ${error.message}\n\n${USAGE}\n`);
		return 2;
	}
	if (options.help) {
		await emit(process.stdout, USAGE + "\n");
		return 0;
	}
	if (options.version) {
		const { readFile } = await import("node:fs/promises");
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		await emit(process.stdout, `hodipor ${pkg.version} (durable)\n`);
		return 0;
	}

	const { resolveHome, pickSession, initHome } = await import("./home.mjs");
	const { createHodiporModels, defaultModelRef } = await import("./models.mjs");
	const { openSession } = await import("./session.mjs");

	const paths = resolveHome(options);
	initHome(paths);
	const models = inject.models ?? (await createHodiporModels({ agentDir: paths.agentDir }));
	const modelRef = await defaultModelRef(models, options.model);
	if (!modelRef && (options.print || !process.stdout.isTTY || !process.stdin.isTTY)) {
		await emit(
			process.stderr,
			"hodipor: no model available. Configure a provider (interactive /login) or pass --model provider/model.\n",
		);
		return 1;
	}
	const sessionId = pickSession(paths.sessionsDir, { sessionId: options.session, continueLatest: options.continueLatest });

	return openSession({
		home: paths.home,
		sessionId,
		models,
		options,
		pickModel: () => Promise.resolve(modelRef?.model),
		extraExtensions: inject.extensions ?? [],
	});
}

/**
 * Bun/npm global installs put a symlink on PATH (`~/.bun/bin/hodipor`), so
 * `process.argv[1]` is the link while `import.meta.url` is the real file.
 * Compare resolved paths, not stringified URLs.
 * @param {string} a @param {string} b
 */
function samePath(a, b) {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

const invokedDirectly = process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
	main().then(
		(code) => process.exit(code ?? 0),
		async (error) => {
			await emit(process.stderr, `hodipor: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		},
	);
}
