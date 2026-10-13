#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

// Pi reads its config directory during import; keep Siftory separate from personal Pi.
process.env.PI_CODING_AGENT_DIR = process.env.SIFTORY_AGENT_DIR || join(homedir(), ".siftory", "agent");
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.title = "siftory";

const { main } = await import("@earendil-works/pi-coding-agent");
const { default: foundation } = await import("./foundation.mjs");
await main(process.argv.slice(2), {
  extensionFactories: [{ name: "siftory", builtin: true, factory: foundation }],
});
