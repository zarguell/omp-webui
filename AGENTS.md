# AGENTS.md

Critical context for working in the omp-webui codebase.

## Architecture

- **Runtime**: Bun (not Node). Entry point `src/index.ts` → `bun build --target=bun` → `dist/index.js`. Frontend: Vite React → `dist/web/`.
- **PTY host**: `src/terminals/pty-host.mjs` is a separate Node.js process (not bundled). Uses `node-pty` (native addon). Spawns on first terminal creation; communicates via newline-delimited JSON over stdin/stdout. **Must be copied to `dist/` during build** (see `build:server` script).
- **Database**: SQLite via `bun:sqlite`. Migrations in `src/db/migrate.ts` use `hasColumn()` additive ALTER pattern (never rebuild tables).
- **Cron**: Jobs table drives `supercronic` via a generated crontab file. Webhook jobs store `cron_expr=''` and are omitted from the crontab.

## Key Gotchas

### SQLite reserved words
`trigger` is a reserved keyword. **Always quote** in SQL: `"trigger"`, never bare `trigger`. Same for INSERT column lists, UPDATE SET, SELECT.

### node-pty
- **Linux container**: compiles from source via `node-gyp` during `npm install`. Requires `build-essential`, `python3`, `nodejs` (official Node tarball, NOT Debian's broken `node-gyp`).
- **macOS**: The prebuilt `darwin-arm64` binary in node-pty 1.1.0 is broken on newer macOS (posix_spawnp fails). The `postinstall` script in `package.json` forces a source rebuild via `npm rebuild node-pty` when `OMPI_WEBUI_SKIP_PTY` is not set. The Dockerfile builder stage sets `OMPI_WEBUI_SKIP_PTY=1` to skip this (no PTY needed at build time).
- **Runtime**: `dist/pty-host.mjs` resolves `node-pty` from `/app/node_modules/`. The Dockerfile runtime stage runs `npm install node-pty@1.1.0` separately from the app's bun dependencies.

### Dockerfile layer order
`curl` and `xz-utils` must be installed via `apt-get` BEFORE downloading the Node.js tarball (which requires both). Base image is `python:3.12-slim-bookworm`.

### Bun baseline
Standard Bun x64 builds require AVX2. The Dockerfile swaps in `bun-linux-x64-baseline.zip` for x86_64 builds to support older CPUs (e.g. Intel Gemini Lake NAS).

## Conventions

- **CSS**: Theme vars in `web/src/tokens.css`. Dark mode is the default (`:root`). Light mode: `:root[data-theme="light"]`. Toggle persisted in `localStorage("omp-theme")`.
- **Model selection**: Use `<ModelSelect>` from `web/src/components/model-select.tsx`. Fetches `/api/models` on mount. Supports `allowNone` for optional model fields.
- **Cron runs**: Per-job history via "History" button toggles `historyJob` state and fetches `/api/cron/runs?jobId=<id>`.
- **Terminal polling**: `web/src/pages/terminal.tsx` polls `/api/terminals` every 3 seconds (silent, no loading spinner) so new terminals appear without page reload.

## Verification Checklist

Before pushing:
1. `bun run check:types` — zero errors
2. `bun run build` — produces `dist/index.js` + `dist/pty-host.mjs` + `dist/web/`
3. `docker build -t omp-webui:local .` — builds without errors
4. Container smoke test: start, create terminal, WS input/output round-trip
5. `bun run check` — lint consistent with repo baseline (dist excluded)
