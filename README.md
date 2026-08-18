> **Attribution:** This project was originally developed as `packages/omp-webui` inside [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, Copyright (c) 2025 Mario Zechner, 2025-2026 Can Bölük) and extracted as a standalone repository. See [LICENSE](./LICENSE).

# omp-webui

Headless management layer for [oh-my-pi](https://github.com/can1357/oh-my-pi) — sessions, secrets, cron, and a browser terminal.

## Threat Model

**omp-webui is designed for trusted, single-user, local-only deployments.** It has no authentication, no authorization, and no session management. Every endpoint is fully open.

### What this means

- **Anyone who can reach the port has full control.** The terminal gives shell access. The secrets page exposes API keys. Sessions can be read, resumed, and prompted. Cron jobs can be created and deleted.
- **There is no auth layer by design.** Adding authentication is out of scope — the app assumes network-level access control.
- **The terminal is RCE.** A browser terminal session runs arbitrary commands on the host with the server's permissions.

### Safe deployment

| Scenario | Safe? | Notes |
|---|---|---|
| `localhost:8787` on a personal machine | ✅ | Default config. Only reachable from the same machine. |
| Behind Tailscale / WireGuard | ✅ | Network-level auth. Only trusted devices reach the port. |
| Behind reverse proxy with auth (e.g. Cloudflare Access, oauth2-proxy) | ✅ | Proxy handles auth before traffic reaches the app. |
| Docker with `-p 127.0.0.1:8787:8787` | ✅ | Bound to loopback only. |
| `0.0.0.0` on a LAN | ⚠️ | Anyone on the network can access it. Use only on trusted LANs. |
| Exposed to the internet | ❌ | **Never.** Full RCE with no auth. |

### If you need multi-user or internet access

This is not the right tool. Use a proper IDE environment with auth (e.g. GitHub Codespaces, Gitpod, code-server with auth).

## Run

```bash
docker build -f packages/omp-webui/Dockerfile -t omp-webui:dev .
docker run --rm -v omp-webui-data:/data -p 8787:8787 omp-webui:dev
# open http://localhost:8787
```

`OMP_WEBUI_BIND=0.0.0.0` to listen on all interfaces (logs a warning).

## Env

- `OMP_WEBUI_DATA_DIR` / `DATA_DIR` — default `/data`
- `PI_CODING_AGENT_DIR` — default `$DATA_DIR/agent` (sessions, `config.yml`, `models.yml`, `agent.db`)
- `OMP_WEBUI_PORT` / `PORT` — default `8787`
- `OMP_WEBUI_BIND` — default `127.0.0.1`
- `CRONTAB_PATH` — default `$DATA_DIR/crontab`
- `MASTER_KEY_PATH` — default `$DATA_DIR/keys/master.key`
- `OMP_WEBUI_MASTER_KEY` — override master key (hex 64 or base64 32 bytes)

## Secrets

Add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. via the Secrets page. Stored AES-256-GCM in `omp-webui.db`, injected as env into every `omp` spawn and every terminal PTY. Back up `/data/keys/master.key`.

## Terminal

Each terminal is a PTY (`PtySession` / `portable-pty`). Default shell, or `command: "omp login"` / `omp config` / `vim`. Use it for `omp login` (OAuth), `omp models`, `omp config`, `models.yml` edits — the escape hatch so the web UI doesn't need to reimplement every CLI surface. `xterm.js` renders in browser; `ghostty-web` WASM VT is swappable via `TerminalView`.

## Cron

Jobs use `supercronic` (`aptible/supercronic`). Crontab at `$DATA_DIR/crontab`, managed by the API. Each tick `curl`s `POST /internal/cron/trigger/:id` on localhost so secret decryption and `omp --mode json -p` happen in one place.

## Sessions

Filesystem is source of truth (`$PI_CODING_AGENT_DIR/sessions/.../*.jsonl`). Listing scans the dir; streaming tails via `fs.watch` + SSE; interactive chats use `omp --mode rpc` over WS.
