#!/usr/bin/env node
// Visible acceptance: reuse the configured runtime without copying credentials
// into the independent --home. Never use /login or /logout in this harness.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { createHodiporModels } from "../src/models.mjs";
import { main, parseCliArgs } from "../src/cli.mjs";

const [agentDir, ...argv] = process.argv.slice(2);
assert(agentDir, "usage: node test/helper-real-cli.mjs <credential-agent-dir> --home <acceptance-home> [options]");
const options = parseCliArgs(argv);
assert(options.home && resolve(options.home) !== dirname(resolve(agentDir)), "visible acceptance requires an independent --home");
const models = await createHodiporModels({ agentDir: resolve(agentDir) });
process.exit(await main(argv, { models }) ?? 0);
