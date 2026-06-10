# Deployment

This guide takes Marina from a local `bun run start` to a running deployment on AWS or any other cloud, with TLS, persistence, and backups. It assumes you've read [Getting Started](getting-started.md) and [Configuration](configuration.md).

## The one rule that shapes everything

**Marina is a single process backed by a single SQLite file.** There is one writer. You scale it **vertically** (a bigger box), not **horizontally** (more replicas). Do not run two instances against the same database file — you will corrupt it.

This is a deliberate design choice: the first target is a personal computer, and a single SQLite file makes the whole world trivially portable, backupable, and forkable. For the vast majority of deployments — a team, a demo, a research instance, even a public endpoint — one well-provisioned instance is the right answer. If you genuinely outgrow it, the path is [federation](federation.md) (many independent instances bridged together), not a shared database.

Everything below follows from this: pick a single durable volume, put the database on it, run one container, and back it up.

## What you're deploying

A single Bun process serves everything on **`WS_PORT`** (default `3300`):

| Surface | Path / Protocol | Notes |
|---------|-----------------|-------|
| Web chat | `GET /` | Browser client |
| Dashboard SPA | `/dashboard`, `/canvas`, `/who/<name>` | Built from `dashboard/` into `dist/dashboard` |
| WebSocket | `/ws` | Live agent/human connection |
| OpenAI/Ollama API | `/v1/*`, `/api/*` | Drop-in LLM endpoint ([Model API](model-api.md)) |
| Memory API | `/mem` | REST notes/recall ([Memory API](memory-api.md)) |
| Health | `GET /health` | Returns JSON `{status:"ok", uptime, connections, ...}` |

Three more ports run alongside it:

| Port | Env var | Purpose | Expose publicly? |
|------|---------|---------|------------------|
| `3300` | `WS_PORT` | HTTP + WebSocket + API (above) | **Yes** (behind TLS) |
| `4000` | `TELNET_PORT` | Plain-text telnet client | No — internal/admin only |
| `3301` | `MCP_PORT` | MCP server for tool clients | Only if you use MCP remotely |
| `3302` | `LOG_PORT` | Real-time event log viewer | No — internal only |

**Persistent state** is just two things, both under `/app/data` in the container image:

- `DB_PATH` — the SQLite database (default `/app/data/marina.db`), plus its `-wal`/`-shm` sidecars in WAL mode.
- `ASSETS_DIR` — uploaded canvas assets (default `/app/data/assets`).

Put a single durable volume at `/app/data` and your entire world persists across restarts and redeploys.

## Prerequisites

- **Bun ≥ 1.1** if running outside Docker. Install via the official installer (`curl -fsSL https://bun.sh/install | bash`) — some distro-packaged Bun 1.3.x builds have a broken `Date.now()`; `scripts/build.sh` checks for this.
- **Docker** (with the Compose plugin) for the containerized path below.
- At least one **LLM provider key** (e.g. `ANTHROPIC_API_KEY`) if you want agents to think. Without any key, rooms fall back to static entities and the world still runs.

## Quick start with Docker

The repo ships a multi-stage `Dockerfile` and a `docker-compose.yml`. From a clean checkout:

```bash
cp .env.example .env        # fill in keys + secrets (see Security below)
docker compose up -d --build
docker compose logs -f
```

Then open `http://localhost:3300`. State lives in the named volume `marina-data`; `docker compose down` stops the instance without deleting it, and `docker compose down -v` wipes the world.

The image builds the dashboard SPA, runs as an unprivileged `bun` user, and ships a `HEALTHCHECK` that polls `/health`. `docker compose up` waits for it to report healthy.

### Without Compose

```bash
docker build -t marina .
docker run -d --name marina \
  -p 3300:3300 \
  -v marina-data:/app/data \
  --env-file .env \
  marina
```

## Configuration essentials

All variables are optional with sane defaults — the canonical, annotated list is [`.env.example`](https://github.com/h2oai/Marina/blob/main/.env.example). The load-bearing ones for a deployment:

```bash
MARINA_WORLD=default          # which world to load
DB_PATH=/app/data/marina.db   # keep on the durable volume
ASSETS_DIR=/app/data/assets     # ditto
MARINA_NAME=my-instance       # shown in the dashboard topbar
LOG_FORMAT=json                 # structured logs for your aggregator
ANTHROPIC_API_KEY=sk-ant-...     # (or OPENAI_API_KEY, GEMINI_API_KEY, ...)
```

### Security checklist (do this before exposing to the internet)

Marina's HTTP API requires authentication **by default** — but it's easy to weaken it, so verify:

- [ ] **Set `MODEL_API_KEYS`** (comma-separated bearer tokens) for the `/v1/*` and `/api/*` LLM endpoints. Clients send `Authorization: Bearer <token>`.
- [ ] **Set `MEM_API_KEYS`** (comma-separated `secret:agent` pairs) if you expose the `/mem` Memory API.
- [ ] **Never set `MARINA_OPEN_API=true`** on a public host — it disables API auth entirely. It's a local-dev convenience only.
- [ ] **Set `ALLOWED_ORIGINS`** to your real dashboard origin(s) if clients run cross-origin. Unset = same-origin only (no CORS header), which is the safe default.
- [ ] **Don't publish ports 4000 (telnet) and 3302 (log viewer)** — neither is authenticated. Keep them off your public load balancer / security group. The shipped Compose maps `4000` for local convenience; drop that line for a public host.
- [ ] **Set `GATEWAY_SECRET`** if (and only if) you use [federation](federation.md). Otherwise leave it unset.
- [ ] **Terminate TLS at a reverse proxy** (next section). Marina speaks plain HTTP/WS; never expose `3300` directly to the internet.
- [ ] Rate limits are built in (WS 5/s, MCP 5/s, Model API 2/s per IP, Memory API 10/s per agent) but a proxy-level limit is still wise.

## Reverse proxy + TLS

Put a proxy in front of `WS_PORT`. It must forward WebSocket upgrade headers (for `/ws` and the dashboard's live feed). [Caddy](https://caddyserver.com) does this with automatic HTTPS in two lines:

```caddyfile
marina.example.com {
    reverse_proxy localhost:3300
}
```

Caddy proxies WebSockets transparently. The equivalent nginx `location /` needs `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`. Behind an AWS ALB, enable the WebSocket-compatible defaults and a generous idle timeout (the WS server caps idle at ~255s; set the ALB idle timeout to 300s+).

## Persistence & backups

The database is one file. Backing it up is one command — but use SQLite's online backup, not `cp`, because WAL mode means a raw copy can be mid-write:

```bash
# Consistent, WAL-safe backup (sqlite3 is installed in the image)
docker compose exec marina ./scripts/backup.sh /app/data/marina.db /app/data/backups
```

`scripts/backup.sh` uses `sqlite3 .backup` (falling back to a checkpointed copy). `scripts/restore.sh` reverses it. For moving a whole world between hosts (DB + assets), use `scripts/export.sh` / `scripts/import.sh`.

Recommended: a cron/systemd timer (or an ECS scheduled task) that runs the backup and ships the result to S3. Snapshotting the underlying volume (EBS/EFS snapshot) also works as long as you snapshot the whole `/app/data` directory.

> Note: admin DB snapshots (`admin snapshot <name>`) write to `/app/seeds` **inside the container**, which is *not* on the volume — they're lost on redeploy. Use the backup/export scripts (which target `/app/data`) for anything you need to keep.

## Example setups

### A. Single VM with Docker Compose (recommended baseline)

The simplest production-grade setup, and the one that best fits the single-writer model. Works on an **AWS EC2** instance, Lightsail VM, DigitalOcean droplet, GCP/Azure VM — anything that runs Docker.

1. Provision a small VM (a 2 vCPU / 4 GB box handles a busy instance; agents are I/O- and API-bound, not CPU-bound). Attach a persistent disk.
2. Install Docker + the Compose plugin.
3. Clone the repo, create `.env`, point the `marina-data` volume at the persistent disk (e.g. bind-mount `/mnt/data:/app/data` instead of the named volume).
4. `docker compose up -d --build`.
5. Run Caddy (or your proxy) on the same box for TLS, pointing at `localhost:3300`.
6. Add a daily backup timer that runs `scripts/backup.sh` and `aws s3 cp` the result.

This keeps the database on a single fast local/EBS disk (ideal for SQLite) and the whole instance is one `docker compose pull && up -d` away from an upgrade.

### B. AWS ECS on Fargate + EFS

Managed containers, no VM to patch. The trick is keeping it to **exactly one task** with the database on durable shared storage.

- **Image**: build and push to ECR (`docker build -t <ecr>/marina . && docker push ...`).
- **Storage**: create an **EFS** file system, mount it into the task at `/app/data` via an EFS volume + mount point. (EFS, not ephemeral task storage — the latter vanishes when the task recycles.)
- **Service**:
  - `desiredCount: 1`.
  - Deployment config `minimumHealthyPercent: 0`, `maximumPercent: 100` — this stops the old task **before** starting the new one, so two tasks never touch the SQLite file at once. (The usual rolling default would briefly run two writers — don't use it here.)
  - Health check: container `HEALTHCHECK` already polls `/health`; also point the ALB target group health check at `/health`.
- **Networking**: an ALB in front of the `3300` target group, TLS cert via ACM, WebSocket-friendly (ALB supports WS natively; bump idle timeout to ≥300s). Do **not** add target groups for 4000/3302.
- **Secrets**: put `MODEL_API_KEYS`, provider keys, etc. in AWS Secrets Manager / SSM Parameter Store and inject as task `secrets`.

> EFS works fine for a single-writer SQLite file, but it has higher latency than EBS. If write latency matters, prefer setup A (EC2 + EBS) — local block storage is the happiest home for SQLite.

### C. AWS Lightsail Containers

The middle ground — managed containers without ECS's complexity, with built-in TLS.

- Push the image to a Lightsail container service (or ECR).
- Deploy with the public endpoint pointed at port `3300` and the health check path set to `/health`.
- **Caveat**: Lightsail container services have **no persistent volume**. Use this only for ephemeral/demo instances, or point `DB_PATH` at an external store you control. For durable Lightsail, use a **Lightsail VM** with an attached disk and setup A instead.

### D. Fly.io (non-AWS Docker example)

Fly maps cleanly onto the model: one machine, one volume.

```toml
# fly.toml
app = "marina"

[build]
  dockerfile = "Dockerfile"

[env]
  DB_PATH = "/app/data/marina.db"
  ASSETS_DIR = "/app/data/assets"
  MARINA_WORLD = "default"

[[mounts]]
  source = "marina_data"
  destination = "/app/data"

[http_service]
  internal_port = 3300
  force_https = true
  auto_stop_machines = false   # keep the single writer alive

[[http_service.checks]]
  path = "/health"
```

```bash
fly volumes create marina_data --size 10
fly secrets set MODEL_API_KEYS=sk-... ANTHROPIC_API_KEY=sk-ant-...
fly deploy
```

Keep `auto_stop_machines = false` and `min_machines_running = 1` — and **do not scale `count` above 1**. The same pattern applies to Render, Railway, and Koyeb: one instance, one attached disk at `/app/data`, health check on `/health`, secrets for keys.

## Scaling, limits, and what not to do

- **Don't run replicas against one DB.** Two writers corrupt SQLite. Scale up the box, not out.
- **Vertical headroom**: in-memory entity storage is fine into the thousands of entities; a single SQLite writer comfortably handles a busy instance. Most load is outbound LLM API calls, so size for memory and network, not CPU.
- **Need multiple regions or teams?** Run independent instances and bridge them with [federation](federation.md) and `GATEWAY_SECRET` — each keeps its own database.
- **Cost control**: set `MARINA_ROOM_AGENTS=false` to stop rooms from auto-spawning LLM-connected agents, or omit provider keys entirely for a static world.

## Operations

- **Logs**: set `LOG_FORMAT=json` and collect stdout with your aggregator (CloudWatch, Loki, etc.).
- **Health**: `curl https://your-host/health` returns 200 + JSON when live; this is what the container and load balancer probes use.
- **Upgrades**: `git pull` (or pull a new image tag), then `docker compose up -d --build`. Back up first; migrations in `src/persistence/database.ts` run automatically on boot and are append-only.
- **Stuck?** See [Troubleshooting](troubleshooting.md).

## Continuous deployment (CI/CD)

On push to `main`, [`Deploy to EC2`](../../.github/workflows/deploy-ec2.yml) builds the image, pushes it to ECR (`h2oai-marina` in account `<aws-account-id>`), and — because the host is in a private subnet — uses **AWS SSM Run Command** (not SSH) to pull the pinned `:<commit-sha>` image and `docker compose up -d` via [`scripts/deploy.sh`](../../scripts/deploy.sh). Auth is via **GitHub OIDC** (no static keys). Setup lives in repo **secret** `GH_OIDC_ROLE_H2O_MARINA` and **variables** `AWS_REGION` / `MARINA_INSTANCE_ID` / `MARINA_APP_DIR`; the AWS side is in `terraform/aws/internal-deployments/{git-oidc-roles,ecr}`.

### Rollback
The pipeline always deploys the commit that triggered it — there is **no "re-deploy a previous run" button**, by design. Because every image is tagged by **commit SHA** (immutable), you roll back by redeploying an older tag — no rebuild needed. On the host:
```bash
MARINA_IMAGE=<aws-account-id>.dkr.ecr.us-east-1.amazonaws.com/h2oai-marina:<old-sha> \
AWS_REGION=us-east-1 sudo -H bash /home/ubuntu/Marina/scripts/deploy.sh
```
(or `git revert` the bad commit on `main` and let CI deploy the revert). The prior image is usually still cached locally (we only prune *dangling* images), so the rollback pull is instant.

### Running `docker compose` manually on the host
- The CI deploy runs as **root** via SSM. If you SSH in (as `ubuntu`) and run `docker compose up -d` yourself, Compose resolves the image from `${MARINA_IMAGE:-…/h2oai-marina:latest}` — i.e. **`:latest`** unless you `export MARINA_IMAGE=…:<sha>`. That can differ from the SHA the pipeline last deployed, so prefer setting `MARINA_IMAGE` (or just re-trigger the workflow) to stay deterministic.
- **Heads-up:** the next CI deploy runs `git reset --hard`, which **overwrites local edits to tracked files** (e.g. a hand-edited `docker-compose.yml`) on the host. Keep host-specific config in `.env` (untracked) and persistent data in the `./marina-data` bind-mount — both survive deploys.

### Image retention
`deploy.sh`'s `docker image prune -f` only removes **dangling** layers; old `:<sha>` tags are not dangling, so they accumulate on the host **and** in ECR. Add an **ECR lifecycle policy** on `h2oai-marina` (e.g. keep last N / expire untagged) to bound storage; optionally `docker image prune -a` on the host on a schedule.

### Known improvements (follow-ups)
- Replace the raw `docker build`/`push` with [`docker/build-push-action`](https://github.com/docker/build-push-action) + `docker/metadata-action` (build cache, multi-tag/labels).
- Pin/refresh action versions (`actions/checkout`, `aws-actions/*`) to current majors.
