# Siftory

A desktop foundation for an AI research-to-video agent: React/Vite frontend, Tauri shell, Bun sidecar and pi-durable 1.1.0 with SQLite persistence.

**Current scope:** persistent chat, model/provider configuration, streaming, cancellation and desktop process supervision. Research, synthesis, narration and rendering extensions currently supply prompts; research tools and the video workflow are not implemented yet. See [product](docs/product.md) and [architecture](docs/architecture.md).

The frontend uses shadcn/ui (Base UI) and Tailwind CSS v4 with a shared light/dark/system theme. See the [UI foundation](docs/ui.md).

## Development

Prerequisites: Bun 1.4.2, Rust and the [Tauri platform dependencies](https://v2.tauri.app/start/prerequisites/).

```sh
bun install --frozen-lockfile
bun run dev                 # browser UI at localhost:5173; fake model, no API key needed
bun run dev:desktop         # same services plus Tauri; builds the host sidecar first
```

Development data lives in `apps/agent/.data`. Release desktop data uses Tauri's application data directory for `ai.appchain.siftory`. Standalone source runs accept `--port 0 --data-dir /path/to/data`; outside dev mode the server requires a token from `SIFTORY_TOKEN` or prints a newly generated token.

## Validation and packaging

The approved pelican artwork supplies the UI, browser, macOS and Windows icons.
Run `bun run icons` to regenerate them; see [branding](docs/branding.md) for the
platform exports and source artwork.

```sh
bun run check               # strict Agent types and frontend production build
bun run test                # storage conformance, host/API and crash-recovery tests
bun run build:sidecar --current
bun run test:native          # native supervisor handshake and shutdown test
bun run test:sidecar         # run transport/recovery tests against the compiled binary
bun run build:desktop       # builds frontend + target sidecar before Tauri packaging
```

`bun run build:sidecar bun-darwin-arm64` selects an explicit supported target. Cross-compiling the sidecar does not build the matching native desktop installer. The `managed-sidecar` Cargo feature allows type-checking the release process supervisor in a development profile; ordinary debug builds use the separately launched dev server.

CI checks source and compiled-sidecar behavior plus both Rust configurations on macOS, Linux and Windows. Installer signing, macOS notarization and installed-app testing remain separate release checks.

## Persistence and recovery

- `siftory.sqlite` holds conversations, submissions, per-conversation settings and pending durable tasks.
- `agent.lock.sqlite` holds an exclusive process ownership lock. It is automatically released by the OS when the Agent exits or crashes; the file may remain. Do not delete it while the Agent runs.
- `auth.json` holds credentials with mode `0600` on Unix. `providers.json` holds custom provider definitions. Writes use atomic replacement; malformed existing files cause errors instead of silently being overwritten.
- The desktop shell holds `desktop.lock`, launches the bundled Agent by absolute path, waits for its readiness message, and retries failures up to three consecutive attempts. The UI reacquires the current port/token after reload or disconnect.
- Graceful exit closes the Harness without cancelling pending work. Forced process termination is covered by recovery tests. Recovery of future paid generation or rendering tools still requires their own replay/idempotency design.

For backups, stop the Agent before copying the data directory, or use a SQLite-aware backup. Do not copy only a live database file while ignoring its WAL. Atomic configuration files are separate from database commits; they do not form one transaction together.
