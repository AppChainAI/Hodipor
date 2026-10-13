import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import foundation from "../src/foundation.mjs";

async function fixture(t, { systemPrompt } = {}) {
  const root = await mkdtemp(join(tmpdir(), "siftory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(agentDir, "skills", "fixture-skill"), { recursive: true });
  await writeFile(join(agentDir, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Use for fixture checks.\n---\nSKILL_BODY_MARKER\n");
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await writeFile(join(agentDir, "prompts", "brief.md"), "---\ndescription: A fixture template\n---\nBrief: $ARGUMENTS\n");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "echo.ts"), `
    import { Type } from "@earendil-works/pi-ai";
    export default function (pi) {
      pi.registerTool({
        name: "fixture_echo", label: "Echo", description: "Echo fixture text",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, args) => ({ content: [{ type: "text", text: args.text }], details: undefined }),
      });
    }
  `);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, systemPrompt, noContextFiles: true,
    extensionFactories: [{ name: "siftory", builtin: true, factory: foundation }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = fauxProvider({ models: [{ id: "fixture-1" }, { id: "fixture-2" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  // The keyless faux provider needs a readiness check for SDK model restoration.
  faux.provider.auth.apiKey.check = async () => ({ type: "api_key", source: "fixture" });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("faux", "fixture-only");

  async function open(manager = SessionManager.create(cwd, sessionsDir), restoreModel = false) {
    const { session } = await createAgentSession({
      cwd, agentDir, model: restoreModel ? undefined : faux.getModel(), modelRuntime, thinkingLevel: "off",
      resourceLoader: loader, settingsManager, sessionManager: manager,
    });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "print" });
    return session;
  }
  return { root, cwd, agentDir, loader, faux, open };
}

test("native resource discovery, generic persona, streaming and extension tool loop", async (t) => {
  const { loader, faux, open } = await fixture(t);
  assert(loader.getSkills().skills.some((s) => s.name === "fixture-skill"));
  const session = await open();
  for (const name of ["read", "write", "edit", "bash", "fixture_echo"]) {
    assert(session.getActiveToolNames().includes(name), name);
  }
  let streamed = false;
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") streamed = true;
  });
  faux.setResponses([
    (context) => {
      const prompt = context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n");
      assert.match(prompt, /You are Siftory/);
      assert.match(prompt, /fixture-skill/);
      assert.doesNotMatch(prompt, /SKILL_BODY_MARKER/);
      return fauxAssistantMessage(fauxToolCall("fixture_echo", { text: "extension works" }), { stopReason: "toolUse" });
    },
    (context) => {
      assert(context.messages.some((m) => m.role === "toolResult" && m.content.some((b) => b.type === "text" && b.text === "extension works")));
      return fauxAssistantMessage("done");
    },
  ]);
  await session.prompt("Check the extension");
  assert.equal(session.getLastAssistantText(), "done");
  assert(streamed);
  assert.equal(faux.state.callCount, 2);
});

test("built-in write/read/edit tools use the project cwd", async (t) => {
  const { cwd, faux, open } = await fixture(t);
  const session = await open();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "before" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("edit", { path: "note.txt", oldText: "before", newText: "after" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" }),
    (context) => {
      const last = context.messages.findLast((m) => m.role === "toolResult");
      assert.equal(last.isError, false);
      assert(last.content.some((b) => b.type === "text" && b.text.includes("after")));
      return fauxAssistantMessage("files work");
    },
  ]);
  await session.prompt("Update a file");
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "after");
  assert.equal(session.getLastAssistantText(), "files work");
});

test("native skill command loads its body and prompt templates expand arguments", async (t) => {
  const { faux, open } = await fixture(t);
  const session = await open();
  faux.setResponses([(context) => {
    assert.match(JSON.stringify(context.messages.findLast((m) => m.role === "user")), /SKILL_BODY_MARKER/);
    return fauxAssistantMessage("skill loaded");
  }]);
  await session.prompt("/skill:fixture-skill check");
  assert.equal(session.getLastAssistantText(), "skill loaded");
  faux.setResponses([(context) => {
    assert.match(JSON.stringify(context.messages.findLast((m) => m.role === "user")), /Brief: hello/);
    return fauxAssistantMessage("template works");
  }]);
  await session.prompt("/brief hello");
  assert.equal(session.getLastAssistantText(), "template works");
});

test("explicit system prompts retain control over the persona", async (t) => {
  const { faux, open } = await fixture(t, { systemPrompt: "Custom persona" });
  const session = await open();
  faux.setResponses([(context) => {
    const prompt = JSON.stringify(context.messages.filter((m) => m.role === "system"));
    assert.match(prompt, /Custom persona/);
    assert.doesNotMatch(prompt, /You are Siftory/);
    assert.match(prompt, /fixture-skill/);
    return fauxAssistantMessage("custom works");
  }]);
  await session.prompt("hello");
});

test("a streamed run can be aborted and followed by a new prompt", async (t) => {
  const { faux, open } = await fixture(t);
  const session = await open();
  let stopped = false;
  session.subscribe((event) => {
    if (!stopped && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stopped = true;
      void session.abort();
    }
  });
  faux.setResponses([fauxAssistantMessage("A long response ".repeat(50))]);
  await session.prompt("Start streaming");
  assert(stopped);
  assert.equal(session.messages.findLast((message) => message.role === "assistant").stopReason, "aborted");
  faux.setResponses([fauxAssistantMessage("resumed")]);
  await session.prompt("Continue");
  assert.equal(session.getLastAssistantText(), "resumed");
});

test("sessions reopen with history/model choices and fork independently", async (t) => {
  const { faux, open } = await fixture(t);
  const session = await open();
  faux.setResponses([fauxAssistantMessage("saved answer")]);
  await session.prompt("saved question");
  await session.setModel(faux.getModel("fixture-2"));
  const path = session.sessionManager.getSessionFile();
  assert(path);
  const user = session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
  session.dispose();

  const reopened = await open(SessionManager.open(path), true);
  assert.equal(reopened.getLastAssistantText(), "saved answer");
  assert.equal(reopened.model.id, "fixture-2");
  const forkManager = SessionManager.open(path);
  const forkPath = forkManager.createBranchedSession(user.id);
  assert.notEqual(forkPath, path);
  const fork = await open(forkManager);
  assert.equal(fork.getLastAssistantText(), undefined);
  faux.setResponses([fauxAssistantMessage("branch answer")]);
  await fork.prompt("new branch");
  assert.equal(fork.getLastAssistantText(), "branch answer");
  assert.equal(reopened.getLastAssistantText(), "saved answer");
});
