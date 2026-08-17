#!/usr/bin/env bash
set -euo pipefail
mkdir -p /data/agent/sessions /data/keys /data/logs /data/workspaces
if [ ! -f "$MASTER_KEY_PATH" ] && [ -z "${OMP_WEBUI_MASTER_KEY:-}" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '\n' > "$MASTER_KEY_PATH"
  chmod 600 "$MASTER_KEY_PATH"
fi
touch "$CRONTAB_PATH"
supercronic -passthrough-logs "$CRONTAB_PATH" >> /data/logs/supercronic.log 2>&1 &
exec bun /app/dist/index.js
