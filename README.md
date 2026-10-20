# Hodipor

**A general-purpose, extensible terminal agent with a durable-native execution engine.**

[English](README.md) | [简体中文](README.zh-CN.md)

Conversation, execution, recovery, and todo state are all persisted to local SQLite by the durable engine. Hodipor provides the CLI/TUI, an isolated configuration home, resource assembly, and extensions — reusing Pi's model authentication, Skills discovery, and terminal components. No preset research, video, or other business scenarios.

## Features

- **Durable by default** — inputs, tasks, state, and outputs are committed to storage before display; interrupted work resumes from the exact interruption point
- **Crash-safe recovery** — one process per session store; orphaned locks are safely taken over by a live process
- **Full terminal UI** — themes, streaming transcript, todo panel, slash commands, interactive menus
- **Extensible** — Skills (`SKILL.md`), prompt templates, and durable-native extensions

## Requirements

- **Node.js ≥ 22.19.0** (built-in SQLite)
- **Bun 1.4.2** for installing dependencies

## Quick Start

```sh
bun install --frozen-lockfile --ignore-scripts
bun run start
```

If no model is available on launch, the provider login opens automatically (startup arguments suppress the hijack). Afterwards, configure providers anytime with `/login` and pick a model with `/model`. Provider environment variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` also work.

## Usage

Without arguments, the tool working directory is `~/.hodipor/workspace` (no longer the launch directory):

```sh
hodipor                                  # home = ~/.hodipor, cwd = ~/.hodipor/workspace
hodipor --home /path/to/dev-hodipor      # isolated development home
hodipor --cwd /path/to/project           # credentials live in home; tools operate on project
hodipor --print "Summarize this directory"   # print mode: answer once and exit (default without a TTY)
hodipor --continue                       # resume the most recent session
```

## Capabilities

| Capability | How to use |
|---|---|
| Keybindings | Esc stop; Ctrl+C quit; Ctrl+D quit (empty editor); Ctrl+T fold thinking |
| Themes | `/theme` selects the theme for the current home; follows the terminal palette by default |
| Models & thinking levels | `/model`, `/thinking`, `--model provider/model:high` |
| Sessions | `/new` (new session group), `/resume` (switch), `--continue`, `--session <id>`; one SQLite store per session group |
| Forking | `/fork` forks at the latest entry, inheriting the todo list at the fork point |
| Context compaction | Automatic, or `/compact`; `/reset` starts a fresh context |
| Recovery | Reopen the same store after a crash or exit; unfinished work continues from the interruption point |
| Core tools | read, write, edit, bash |
| Skills | Standard `SKILL.md` discovery, description index, on-demand loading; `/skill:name` to load explicitly |
| Prompt templates | `~/.hodipor/agent/prompts/<name>.md`; `/name args` expands `$ARGUMENTS` |
| Todo | The model maintains a task list via the `todo` tool; live panel display; Ctrl+Shift+T fold; Ctrl+O expand all; `/todos` grouped view |
| codemode / tool-search | Durable-native implementations, assembled by default |
| Extensions | Durable-native extensions (see the [extension guide](docs/extensions.md)) |

## Recovery Guarantees

- Inputs, tasks, state, and outputs are committed to storage **before** display; unfinished work resumes after reopening.
- Only one process may open a session store at a time; locks orphaned by a crash are safely taken over by a live process.
- Tools are not automatically rerun; tools proven safe to replay (e.g. todo) resume after a crash without duplicate effects.
- External effects (bash, sending mail, payments) are not in the same transaction as local commits — exactly-once execution is **not** guaranteed.
- Exit means pause, reopen means resume; there is no persistent background service.
- Durable is still **Experimental**: after upgrading versions, verify that old stores can be recovered.

## Configuration & Directories

```text
~/.hodipor/
├─ agent/
│  ├─ auth.json              API keys / OAuth
│  ├─ models.json            custom providers and models
│  ├─ skills/<name>/SKILL.md
│  ├─ prompts/<name>.md
│  └─ extensions/            durable-native extensions (reserved)
├─ sessions/<session-id>/
│  ├─ state.sqlite           durable database (WAL)
│  └─ owner.lock             exclusive process record
├─ logs/
├─ tmp/
└─ workspace/                default tool working directory
```

Relative `--home` and `--cwd` paths resolve against the launch directory. Homes do not share sessions or credentials, and personal `~/.pi` configuration is never inherited. To back up a session, close the program and copy the entire `sessions/<id>/` directory, or use a consistent SQLite backup — copying only the main file while running loses WAL contents.

## Development

```sh
bun run start -- --home /path/to/dev-hodipor
bun run check
bun run test
```

Tests use the official faux model — no keys required, no real model requests sent. Coverage includes: paths and locks, print mode, streaming and tool execution, session reopening, post-crash recovery (bash tools not re-executed), todo rules and receipt replay, fork isolation, Skills/project-context loading, and real CLI startup.

See [AGENTS.md](AGENTS.md) for architecture, conventions, and contributor guidance.

## Boundaries

- MCP, `/tree` session-tree browsing, HTML export, and legacy Pi plugins are not yet wired into the durable host; follow phase 4 of the [design document](docs/durable-native-design.md) to add them.
- Saving a session does not mean it keeps running after the terminal closes; it resumes on reopen.
- Third-party extensions run with process permissions — no additional sandbox or approval layer.
- Legacy Pi JSONL sessions stay in place and are not automatically converted; an explicit import would need a separate design.

## Documentation

- [Architecture](docs/architecture.md) — current implementation map
- [Durable-native design](docs/durable-native-design.md) — target design and rationale
- [Extension guide](docs/extensions.md) — Skills, prompt templates, durable extensions
- [Manual testing](docs/manual-testing.md) — acceptance checklist

## License

[MIT](LICENSE)
