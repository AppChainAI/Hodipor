import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "siftory-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const personalPi = join(root, "personal-pi");
  await mkdir(personalPi);
  await writeFile(join(personalPi, "settings.json"), '{"fixture":"untouched"}');
  function run(args) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, SIFTORY_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: personalPi,
        PI_CODING_AGENT_SESSION_DIR: "", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result;
  }
  return { root, agentDir, personalPi, run };
}

test("launcher delegates native help and version", async (t) => {
  const { run } = await fixture(t);
  assert.match(run(["--help"]).stdout, /--skill/);
  assert.match(run(["--help"]).stdout, /--resume/);
  assert.match(run(["--version"]).stdout, /1\.2\.0/);
});

test("real CLI loads a provider extension, saves/resumes a session and isolates config", async (t) => {
  const { root, agentDir, personalPi, run } = await fixture(t);
  const providerPath = join(root, "fixture-provider.ts");
  await writeFile(providerPath, `
    import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
    export default function (pi) {
      const faux = fauxProvider({ provider: "siftory-fixture", models: [{ id: "fixture-1" }] });
      faux.provider.auth.apiKey.check = async () => ({ type: "api_key", source: "fixture" });
      faux.setResponses([(context) => {
        const system = JSON.stringify(context.messages.filter((m) => m.role === "system"));
        if (!system.includes("You are Siftory")) throw new Error("missing Siftory persona");
        const users = context.messages.filter((m) => m.role === "user").length;
        return fauxAssistantMessage("fixture users=" + users);
      }]);
      pi.registerProvider(faux.provider);
    }
  `);
  const args = ["--offline", "--no-context-files", "--no-skills", "--no-mcp",
    "--extension", providerPath, "--model", "siftory-fixture/fixture-1", "--thinking", "off"];
  const first = run([...args, "--mode", "json", "first input"]);
  const events = first.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert(events.some((e) => e.type === "agent_settled"));
  const header = events.find((e) => e.type === "session");
  assert(header);
  const resumed = run([...args, "--continue", "--print", "second input"]);
  assert.match(resumed.stdout, /fixture users=2/);
  assert.equal(await readFile(join(personalPi, "settings.json"), "utf8"), '{"fixture":"untouched"}');
  const sessionsDir = join(agentDir, "sessions");
  const files = (await readdir(sessionsDir, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const sessionPath = join(sessionsDir, files[0]);
  const transcript = await readFile(sessionPath, "utf8");
  assert.equal(JSON.parse(transcript.split("\n")[0]).id, header.id);
  assert.match(transcript, /first input/);
  const exported = join(root, "session.html");
  run(["--export", sessionPath, exported]);
  assert.match(await readFile(exported, "utf8"), /<html/);
});
