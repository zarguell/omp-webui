# syntax=docker/dockerfile:1.26-labs
ARG BUN_VERSION=1.3.14
ARG SUPERCRONIC_VERSION=v0.2.33

FROM python:3.14-slim-bookworm AS base
ARG BUN_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates unzip openssh-client tini sqlite3 build-essential pkg-config libssl-dev && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && /opt/bun/bin/bun --version \
 && bun install -g @oh-my-pi/pi-coding-agent && /opt/bun/bin/omp --version

FROM base AS builder
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts ./
RUN bun install
COPY src ./src
COPY web ./web
COPY public ./public 2>/dev/null; true
RUN bun run build

FROM base AS runtime
ARG SUPERCRONIC_VERSION
ENV PI_CODING_AGENT_DIR=/data/agent OMP_WEBUI_DATA_DIR=/data OMP_WEBUI_PORT=8787 CRONTAB_PATH=/data/crontab MASTER_KEY_PATH=/data/keys/master.key
RUN curl -fsSL -o /usr/local/bin/supercronic https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64 && chmod +x /usr/local/bin/supercronic && supercronic -h 2>&1 | head -5
COPY --from=builder /app/dist /app/dist
COPY entrypoint.sh /usr/local/bin/omp-webui-entrypoint
RUN chmod +x /usr/local/bin/omp-webui-entrypoint
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/omp-webui-entrypoint"]
