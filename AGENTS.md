# Repository Guidelines

## Project Overview

Hodipor is a general-purpose, extensible terminal AI agent (CLI/TUI). Conversation, execution, crash recovery, and todo state are persisted in local SQLite by the durable engine (`@earendil-works/pi-durable`, **Experimental**). Hodipor is a thin host layer: the durable engine owns sessions, model execution, tool tasks, compaction, and business documents; Hodipor owns the CLI/TUI, path/storage lifecycle, resource assembly, and extension wiring; Pi packages (`pi-coding-agent`, `pi-ai`, `pi-tui`) supply model auth, Skills loaders, and terminal components.

- Entry point: `bin.hodipor → src/cli.mjs`
- Runtime: **Node ≥ 22.19.0** (built-in SQLite); Bun 1.4.2 is the installer/script runner only — scripts invoke `node` directly
- Pure ESM JavaScript (`.mjs`), no build step; run source directly via `node src/cli.mjs`

## Architecture & Data Flow

Read `docs/architecture.md` first (current implementation map), then `docs/durable-native-design.md` (target design + rationale).

Layered modules (dependencies flow downward, no cycles):

| Module | Responsibility |
|---|---|
| `src/cli.mjs` | argv parsing, model resolution, session pick; `main(argv, inject)` — `inject` is the test seam |
| `src/home.mjs` | `--home`/`--cwd` resolution, home dirs, exclusive storage lock (`owner.lock`) |
| `src/models.mjs` | Pi `ModelRuntime` over `<home>/agent`; `provider/model[:thinking]` parsing |
| `src/runtime.mjs` | Persona/conduct prompts, standard registry, `openRuntime` (Harness + SQLite + `NodeExecutionEnv`) — the only engine entry |
| `src/session.mjs` | Session lifecycle: lock → registry assembly → runtime → `harness.resume()` → TUI/print; `/new` & `/resume` restart loop |
| `src/resources.mjs` | Skills index, project-context sections, `/skill:name` and prompt-template expansion |
| `src/print.mjs` | Non-interactive one-shot mode, event-stream rendering |
| `src/tui/*` | TUI assembly, editor, slash commands, transcript projection, todo panel, footer, theme |
| `extensions/todo/*` | Reference durable-native extension: `todo` tool + `app.todo` doc + pure reducer + read-only UI |

Startup: `main(argv)` → `resolveHome`/`initHome` → `createHodiporModels` → `pickSession` → `openSession` loop → `acquireSessionLock` → build registry (CodingTools + persona + resources + todo + codemode + tool-search) → `openRuntime` → `harness.root` → `configure` → `resume()` → `runTui`/`runPrint` → `finally`: close harness, release SQLite, release lock.

One user turn (TUI): editor submit → `handleInput` (`src/tui/commands.mjs:24`) → slash command or prompt-template/skill expansion → `conversation.submit(...)` → durable executes model + tools and commits events → `watchEvents` batches land in `Projection.applyEvent` (`src/tui/transcript.mjs`) → pi-tui components re-render.

### Critical invariants (violating these breaks the system)

1. **Durable is the sole source of truth.** TUI state (`Projection`, `TodoPanel`) is a discardable read-only projection of committed events/docs — never route edits through it; no shadow transcripts, no dual-write.
2. **Every durable call takes `RUN_CONTEXT`** (`= BACKGROUND_CONTEXT`, `src/runtime.mjs:9`): `Harness.open`, `root`, `configure`, `submit`, `abort`, `watchEvents`, `watchDoc`, `snapshot`, `close`. Omitting it is a bug.
3. **One process per storage.** `owner.lock` (O_EXCL + PID liveness) prevents double-open; corrupt/abandoned locks **fail closed** — never delete a live lock.
4. **Ordering in `runSession` matters**: registry → `Harness.open` → `harness.root` → `configure` (CLI overrides) → `resume()`. Model must be set before resume for `--model` to apply.
5. **Session switching must not nest runtimes**: teardown (close → release) happens in `finally` before `openSession` loops to the next id. `/new` only sets `restartRequest`.
6. **Absolute cwd only** into `NodeExecutionEnv`; after `resume`, persisted `agent.cwd` overrides `paths.cwd`.
7. **`conversationCreated` materializes `TodoDoc`** (`src/session.mjs:66-71`) — removing it silently kills the todo panel (`watchDoc` returns null).
8. **`HODIPOR_AGENT_DIR` is rejected** at startup (`src/home.mjs:15-17`); never reintroduce it.
9. **Extension wiring lives in `session.mjs:52-60`**, not `runtime.mjs` — `openRuntime` is deliberately tool-agnostic; the standard registry guarantees only read/write/edit/bash.

## Key Directories

| Path | Purpose |
|---|---|
| `src/` | Host source (ESM `.mjs`); `src/tui/` holds all terminal UI |
| `extensions/todo/` | Reference durable extension (ported from `@juicesharp/rpiv-todo@2.13.8`); authoring guide: `docs/extensions.md` |
| `test/` | Node test suites (`*.test.mjs`), subprocess helpers (`helper-*.mjs`), PTY suite (`tui-pty.py`) |
| `docs/` | Chinese design/architecture/acceptance docs — see table below |
| `apps/agent/` | **Not project code** — leftover runtime data only (SQLite stores, scratch workspace); ignore |
| `output/` | Gitignored acceptance screenshots/artifacts; read-only reference, some files are stale cross-project dumps |
| `.dev-home/` | Gitignored live dev home with **real credentials** (`agent/auth.json`) — never read/copy keys, never mutate sessions, never use in automated tests |

## Development Commands

```sh
bun install --frozen-lockfile --ignore-scripts   # install (Bun is the package manager; bun.lock)
bun run start                                    # run CLI/TUI (node src/cli.mjs)
bun run start -- --home /path/to/dev-hodipor     # isolated dev home
bun run check                                    # tsc --noEmit — src/ ONLY (tests/extensions unchecked)
bun run test                                     # node --test test/*.test.mjs extensions/todo/test/*.test.mjs
node --test test/tui-theme.test.mjs              # single suite
node --test --test-name-pattern="theme" test/tui-theme.test.mjs   # single test
python3 test/tui-pty.py                          # optional Unix PTY regression (not in CI)
```

Use `bun run test`, **not** `bun test` (Bun's own runner won't execute the npm script). No lint/format/build scripts exist.

## Code Conventions & Common Patterns

- **Module system**: ESM only, all files `.mjs`, explicit extensions in relative imports (NodeNext). Node built-ins via `node:` prefix. No bundler.
- **Types**: no `.ts` files. JSDoc + `checkJs` strict (`tsconfig.json`), but `include` covers only `src/**/*.mjs`. Idioms: inline `import("…").Type`, `Parameters<typeof f>[0]`, `Awaited<ReturnType<…>>`, `/** @type {any} */` at untyped durable boundaries. Ported todo files use `@ts-nocheck` deliberately.
- **Naming**: kebab-case files (`choice-selector.mjs`, `run-status.mjs`); `create*` factories, `command*` handlers, `attach*` subscriptions, `expand*` input transforms. Classes only for UI objects with lifecycle (`Projection`, `TodoPanel`, `RunStatus`); everything else exported functions. Constants SCREAMING_SNAKE (`RUN_CONTEXT`, `HODIPOR_IDENTITY`).
- **Style**: tabs, semicolons, double quotes, trailing commas, long lines (~120–180 cols). No formatter config — match surrounding code. Code comments in English; docs/README in Chinese. Deliberate deviations tagged `// shortcut:` with the reason.
- **Errors**: plain `throw new Error("lower-case message")`; no custom error classes. CLI boundary writes `hodipor: <message>` to stderr with exit codes 0/1/2. TUI converts failures to `app.notify(message, "error")`. Best-effort teardown: `.catch(() => {})`. Cleanup via nested `try/finally`.
- **Async**: `async/await` only; no callbacks, no EventEmitter in project code. Streaming is push-based (`stream.start(async batch => …)`). UI dialogs promisified around component callbacks.
- **DI/composition**: no container, no globals. Factories return plain objects; dependencies passed as one options object (`openRuntime({sessionStoragePath, models, registry, …})`). UI components take **state-getter closures** (`HodiporFooter(getState)`), not state. Slash commands receive one capability object `app` (typedef `TuiApp`, `src/tui/commands.mjs:52-62`).
- **Durable schemas**: TypeBox `Type.Object`/`StringEnum`; docs via `defineDoc`, tools via `defineTool`, prompt sections via `section(name, fn, { tag: false })`.
- **Extension tool results** return `{output, details, isError}` — **never** `content` (`output` → model, `details` → UI).
- **Todo replay safety is transactional**: state mutation + `callId` receipt commit in one `api.commit`; receipts evicted (target 64) only when the durable task is terminal. Reducer semantics are byte-compatible with `rpiv-todo@2.13.8` — do not "improve" transitions or messages.
- **Two session-list implementations** exist (`src/home.mjs:93-99` private, `src/session.mjs:14-22` exported) — keep them in sync.

## Important Files

| Path | Role |
|---|---|
| `src/cli.mjs` | Entry; `main(argv, inject)` — `inject` is the test seam |
| `src/session.mjs` | Session restart loop; lock → registry → runtime → resume → TUI/print |
| `src/runtime.mjs` | `openRuntime`, `RUN_CONTEXT`, identity/conduct prompts |
| `src/home.mjs` | Home resolution, `acquireSessionLock`, session id validation |
| `src/tui/app.mjs` | TUI assembly, `app` capability object, teardown/restart contract (`runTui` must return `restartRequest ?? 0`) |
| `src/tui/commands.mjs` | All slash commands (`/login /model /thinking /theme /new /resume /fork /compact /reset /todos /exit`) |
| `src/tui/transcript.mjs` | `Projection`: snapshot + incremental event application |
| `src/tui/pi-display.mjs` | **Single seam** deep-importing Pi internal display modules (not public exports) — all Pi/chord packages pinned exactly `1.3.0`; upgrading Pi requires rerunning display + PTY regressions |
| `extensions/todo/state.mjs` | `TodoDoc` (`app.todo`), `mutateTodo` receipt replay |
| `package.json` | Scripts, exact-pinned deps (`1.3.0` Pi packages), `engines.node >=22.19.0` |
| `tsconfig.json` | `allowJs` + `checkJs` + `strict`, NodeNext, `include: ["src/**/*.mjs"]` |
| `.github/workflows/check.yml` | Sole CI: Node 22.23.2 + Bun 1.4.2, `bun run check` + `bun run test` on macOS/Ubuntu/Windows |

**Dependency traps**: `typebox` is *not* a root dependency but is imported by `extensions/todo/reducer.mjs` — it resolves via hoisting; new direct imports must be declared in `package.json`. All `@earendil-works/*` packages are exact-pinned `1.3.0` because `pi-display.mjs` deep-imports Pi internals.

## Runtime/Tooling Preferences

- **Node runs everything** (scripts, tests, CLI); **Bun only installs and runs scripts**. `npm test`/`npm run check` also work.
- No ESLint/Prettier/Biome/EditorConfig/Husky — enforcement is `tsc --noEmit` + tests in CI only.
- No workspaces: `extensions/todo/package.json` is private, not a Bun workspace.
- Provider credentials via env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or `/login`; config isolated under `<home>/agent` — never touch personal `~/.pi`.
- Terminology (don't conflate): *Hodipor home* (`--home`, config/data root, default `~/.hodipor`) vs *agent workspace* (`--cwd`, default `<home>/workspace`); *session group* = one SQLite store under `sessions/<id>/`; *todo* (planning list) vs durable *task* (execution).
- Known non-goals (don't "fix" silently): MCP, `/tree`, HTML export, legacy Pi plugins, `/reload`, user extension auto-discovery.

## Testing & QA

- **Framework**: built-in Node test runner (`node:test` + `node:assert/strict`) — no Jest/Vitest, no coverage tooling, no shared setup file. Flat top-level `test("…", async t => …)` only.
- **Naming**: strictly `*.test.mjs`; subprocess entries `helper-*.mjs` (excluded by the glob). Root `test/` = host/integration; `extensions/todo/test/` = extension-local.
- **Never hit real providers**: use the official faux provider (`fauxProvider`/`fauxAssistantMessage` from `@earendil-works/pi-ai/providers/faux`) — responses can be `(context) => message` callbacks asserting on message history. Strip `*_API_KEY` env vars when asserting "no model available".
- **Fixtures**: per-file `tempHome(t)`/`fixture(t)` with `mkdtemp` + `t.after(() => rm(...))`; in-memory harness via `Harness.open(new MemoryStorage(), …)` for fast units; real `openRuntime` with `state.sqlite` for persistence/crash tests.
- **Crash tests**: spawn `test/helper-*.mjs`, `SIGKILL` mid-tool, reopen, assert no duplicate side effects (see `test/durable.test.mjs:183-225`, `test/todo-crash.test.mjs`).
- **Async events**: poll with local `waitFor`/`until` helpers (5–15 s budgets).
- **CI gate**: `bun run check` + `bun run test` on macOS/Ubuntu/Windows, `fail-fast: false`. No coverage threshold, no lint step. PTY suite (`python3 test/tui-pty.py`, Unix-only, 14 tests) is manual.
- **Manual acceptance**: `node test/helper-real-cli.mjs .dev-home/agent --home /tmp/hodipor-acceptance --model deepseek/deepseek-flash` (only credential-using path; requires independent `--home`).
- Tests and extensions are **not typechecked** (`tsconfig.include` = `src/**` only) — `bun run check` passing does not cover them.
