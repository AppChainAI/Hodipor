#!/usr/bin/env node
import process from "node:process";

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

const USAGE = `Siftory — a general-purpose, durable-native terminal agent.

Usage:
  siftory [prompt] [options]

Options:
  --home <dir>        Application root: config, credentials, sessions (default ~/.siftory)
  --cwd <dir>         Tool working directory (default <home>/workspace)
  --model, -m <p/m>   Model as provider/model[:thinking]
  --session <id>      Open a specific session storage
  --continue, -c      Continue the most recent session
  --print, -p         Print mode: answer one prompt and exit
  --help, --version

Without --print and without a TTY, the prompt is read from stdin.`;

/**
 * CLI entry. `inject.models` is the test seam (faux provider); production
 * builds the Pi ModelRuntime over the Siftory home.
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
		process.stderr.write(`siftory: ${error.message}\n\n${USAGE}\n`);
		return 2;
	}
	if (options.help) {
		process.stdout.write(USAGE + "\n");
		return 0;
	}
	if (options.version) {
		const { VERSION } = await import("@earendil-works/pi-coding-agent");
		process.stdout.write(`siftory ${VERSION} (durable)\n`);
		return 0;
	}

	const { resolveHome, pickSession, initHome } = await import("./home.mjs");
	const { createSiftoryModels, defaultModelRef } = await import("./models.mjs");
	const { openSession } = await import("./session.mjs");

	const paths = resolveHome(options);
	initHome(paths);
	const models = inject.models ?? (await createSiftoryModels({ agentDir: paths.agentDir }));
	const modelRef = await defaultModelRef(models, options.model);
	if (!modelRef && (options.print || !process.stdout.isTTY || !process.stdin.isTTY)) {
		process.stderr.write(
			"siftory: no model available. Configure a provider (interactive /login) or pass --model provider/model.\n",
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

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
	main().then(
		(code) => process.exit(code ?? 0),
		(error) => {
			process.stderr.write(`siftory: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		},
	);
}
