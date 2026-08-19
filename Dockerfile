# syntax=docker/dockerfile:1.26-labs
ARG BUN_VERSION=1.3.14
ARG SUPERCRONIC_VERSION=v0.2.33
ARG OMP_VERSION=17.3.7

FROM python:3.12-slim-bookworm AS base
ARG BUN_VERSION
ARG OMP_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates unzip xz-utils openssh-client tini sqlite3 build-essential pkg-config libssl-dev && rm -rf /var/lib/apt/lists/* \
 && NODE_ARCH=$(case "$(uname -m)" in x86_64) echo x64;; aarch64) echo arm64;; *) echo x64;; esac) \
 && curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-${NODE_ARCH}.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
 && node --version && npm --version \
 && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && if [ "$(uname -m)" = "x86_64" ]; then \
      curl -fsSL -o /tmp/bun-baseline.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" \
      && unzip -j -o /tmp/bun-baseline.zip "*/bun" -d /opt/bun/bin && rm /tmp/bun-baseline.zip; \
    fi \
 && /opt/bun/bin/bun --version \
 && bun install -g @oh-my-pi/pi-coding-agent@${OMP_VERSION} && /opt/bun/bin/omp --version

FROM base AS builder
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts ./
RUN --mount=type=cache,target=/root/.bun/install/cache OMPI_WEBUI_SKIP_PTY=1 bun install
COPY src ./src
COPY web ./web
RUN bun run build

FROM base AS runtime
ARG SUPERCRONIC_VERSION
ENV PI_CODING_AGENT_DIR=/data/agent OMP_WEBUI_DATA_DIR=/data OMP_WEBUI_PORT=8787 OMP_WEBUI_BIND=0.0.0.0 OMP_WEBUI_WEBHOOK_PORT=8788 CRONTAB_PATH=/data/crontab MASTER_KEY_PATH=/data/keys/master.key
RUN ARCH=$(case "$(uname -m)" in x86_64) echo amd64;; aarch64) echo arm64;; *) echo amd64;; esac) \
 && curl -fsSL -o /usr/local/bin/supercronic https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${ARCH} \
 && chmod +x /usr/local/bin/supercronic && supercronic -h 2>&1 | head -5
COPY --from=builder /app/dist /app/dist

# Terminal PTY host: node + node-pty (compiled for this arch), resolvable from /app/dist/pty-host.mjs
WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm npm install node-pty@1.1.0 --no-save --omit=dev --loglevel=error && node -e "require('node-pty')"
COPY entrypoint.sh /usr/local/bin/omp-webui-entrypoint
RUN chmod +x /usr/local/bin/omp-webui-entrypoint
VOLUME ["/data"]
EXPOSE 8787 8788
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/omp-webui-entrypoint"]
