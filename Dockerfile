# syntax=docker/dockerfile:1
# ── Marina container image ──────────────────────────────────────────────
# Single-process server: WebSocket + web chat + dashboard SPA + OpenAI/Ollama
# compat API on WS_PORT, plus Telnet, MCP, and the log server. All persistent
# state is a single SQLite file (WAL mode) under /app/data — mount a volume
# there. See docs/guides/deployment.md.

# ── builder: install deps and build the dashboard SPA into dist/dashboard ───
FROM oven/bun:1 AS builder
WORKDIR /app

# Root deps first (layer cached unless package.json / lockfile change).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Dashboard has its own dependency tree.
COPY dashboard/package.json dashboard/bun.lock ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile

# Copy the rest of the source and build the dashboard. vite is configured to
# emit to /app/dist/dashboard — exactly where the server serves it from
# (src/net/websocket-server.ts → ../../dist/dashboard). No post-build move.
COPY . .
RUN bun run dashboard:build

# ── runtime: lean image that runs the server from source ────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# sqlite3 CLI enables WAL-safe backups (scripts/backup.sh, admin snapshots).
# Also pull in Debian security updates for the base-image packages Trivy flags
# (libc6, libcap2, libsystemd0/libudev1, sed) so the runtime layer ships
# patched OS libraries even when the base tag lags behind.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Bring the built app over, then drop the dashboard's build-only node_modules.
# Copying the whole tree (vs. an allow-list of dirs) keeps the image correct
# as the codebase grows — worlds/, benchmarks/, seeds/, rooms/ are all needed
# at runtime and easy to forget in an enumerated COPY.
COPY --from=builder /app /app
RUN rm -rf dashboard/node_modules

# Persistent state lives under /app/data (mount a volume here). The volume is
# owned by the unprivileged `bun` user so the server can write the DB + assets.
RUN mkdir -p data/assets data/scratch && chown -R bun:bun /app/data
USER bun

# Keep all persistent state inside the mounted volume by default.
ENV DB_PATH=/app/data/marina.db \
    ASSETS_DIR=/app/data/assets \
    WS_PORT=3300 \
    TELNET_PORT=4000 \
    MCP_PORT=3301 \
    LOG_PORT=3302

VOLUME ["/app/data"]

# WS/web/dashboard/API · Telnet · MCP · log server
EXPOSE 3300 4000 3301 3302

# Dependency-free health probe against the HTTP /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.WS_PORT||3300)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/main.ts"]
