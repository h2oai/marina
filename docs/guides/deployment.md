# Deployment

This guide takes Marina from a local `bun run start` to a running deployment on AWS or any other cloud, with TLS, persistence, and backups. It assumes you've read [Getting Started](getting-started.md) and [Configuration](configuration.md).

## The one rule that shapes everything

**Marina is a single process backed by a single SQLite file.** There is one writer. You scale it **vertically** (a bigger box), not **horizontally** (more replicas). Do not run two instances against the same database file — you will corrupt it.

This is a deliberate design choice: the first target is a personal computer, and SQLite makes the world database portable; complete recovery also requires the instance files and optional auth database. For the vast majority of deployments — a team, a demo, a research instance, even a public endpoint — one well-provisioned instance is the right answer. If you genuinely outgrow it, the path is [federation](federation.md) (many independent instances bridged together), not a shared database.

Everything below follows from this: pick a single durable volume, put the database on it, run one container, and back it up.

## What you're deploying

The repository's EC2 workflow starts after successful main-branch CI. It verifies
the exact revision before checkout and uses that same SHA for the image tag and
server checkout. Failed, cancelled, fork, and pull-request runs cannot deploy.
Superseded revisions are skipped before building and again before production
changes. Manual deployments and rollbacks also require successful main-branch CI
for their target; rollbacks additionally require the existing image in ECR.

Deployment waits for container health, then checks the running HTTP service and
configured providers with `scripts/smoke-production.ts`. A failing smoke check
makes the deployment workflow fail; it does not automatically roll back the
database or image. The full report stays at `/tmp/marina-production-smoke.json`
inside the container. See [Operating a Marina](../operations.md) for the probe's
scope and authentication settings.

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
| `4000` | `TELNET_PORT` | Plain-text telnet client (off by default; set to enable) | No — internal/admin only |
| `3301` | `MCP_PORT` | MCP server for tool clients | Only if you use MCP remotely |
| `3302` | `LOG_PORT` | Real-time event log viewer | No — internal only |

**Persistent state** is just two things, both under `/app/data` in the container image:

- `DB_PATH` — the SQLite database (default `/app/data/marina.db`), plus its `-wal`/`-shm` sidecars in WAL mode.
- `ASSETS_DIR` — uploaded canvas assets (default `/app/data/assets`).

Put a single durable volume at `/app/data` and your entire world persists across restarts and redeploys.

## Prerequisites

- **Bun ≥ 1.4.2** if running outside Docker. Install via the official installer (`curl -fsSL https://bun.sh/install | bash`) — some distro-packaged Bun 1.3.x builds have a broken `Date.now()`; `scripts/build.sh` checks for this.
- **Docker** (with the Compose plugin) for the containerized path below.
- At least one **LLM provider key** (e.g. `ANTHROPIC_API_KEY`) if you want agents to think. Without any key, rooms fall back to static entities and the world still runs.

## Quick start with Docker

The repo ships a multi-stage `Dockerfile` and a `docker-compose.yml`. From a clean checkout:

```bash
cp .env.example .env        # uncomment keys + secrets (see Security below)
docker compose up -d --build
docker compose logs -f
```

Then open `http://localhost:3300`. State lives in the named volume `marina-data`; `docker compose down` stops the instance without deleting it, and `docker compose down -v` wipes the world.

The image builds the dashboard SPA, runs as an unprivileged `bun` user, and ships a `HEALTHCHECK` that polls `/health`. `docker compose up` waits for it to report healthy.

Inside the container Marina binds `0.0.0.0`, so it derives the **`public`** trust profile: the
OpenAI-compatible API stays closed until you set `MODEL_API_KEYS`, safety gates are enforced, and
seeded agents do not start on their own. That is the right default for a server. For a personal
instance on your own machine, add the local overlay, which declares `MARINA_PROFILE=local` and so
behaves like a native `bun run start` (generated model-API key in `docker compose logs`, seeded
agents start once a provider key is set, $50/day default spend cap):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

The overlay is safe only because `docker-compose.yml` publishes the ports on the host's
`127.0.0.1`. Never use it with widened `ports:`, a reverse proxy in front of the host, or the
EC2/server deploy (`scripts/deploy.sh` does not use it).

### Publishing beyond loopback (`MARINA_BIND_IP`)

`docker-compose.yml` publishes every port on `127.0.0.1` by default, so a fresh `docker compose up`
is reachable from that machine only. A reverse proxy or load balancer on **another** host connects
to this host's routable address, not its loopback — so with the default it cannot connect at all and
every health check fails. Set the host interface to publish on:

```bash
# in .env — 0.0.0.0 for every interface, or pin a specific host IP
MARINA_BIND_IP=0.0.0.0
```

Before widening the bind, enable sign-in (`MARINA_AUTH=better-auth`) or set `MODEL_API_KEYS`, and
keep the host firewall / security group scoped to the proxy or load balancer. Publishing on
`0.0.0.0` makes the port reachable from anything that can route to the host; the network boundary is
then your security group, not Docker.

### Without Compose

```bash
docker build -t marina .
docker run -d --name marina \
  -p 127.0.0.1:3300:3300 \
  -v marina-data:/app/data \
  --env-file .env \
  -e MARINA_ALLOW_INSECURE_PUBLIC=true \
  marina
# The 127.0.0.1: publish prefix keeps the instance host-local (that's why the
# acknowledgment flag is safe here — the container-internal bind is 0.0.0.0 so
# the mapping works at all). Widening to -p 3300:3300 exposes passwordless
# login to the network: enable MARINA_AUTH=better-auth first.
```

## Configuration essentials

All variables are optional with sane defaults. [`.env.example`](https://github.com/h2oai/Marina/blob/main/.env.example) is a short starter; the complete annotated catalog is [`config/environment.reference`](https://github.com/h2oai/Marina/blob/main/config/environment.reference) (rendered as the [environment reference](../reference/environment.md)). The load-bearing ones for a deployment:

```bash
MARINA_WORLD=default          # which world to load
DB_PATH=/app/data/marina.db   # keep on the durable volume
ASSETS_DIR=/app/data/assets     # ditto
MARINA_NAME=my-instance       # shown in the dashboard topbar
LOG_FORMAT=json                 # structured logs for your aggregator
MARINA_LOG_RETENTION=10000      # durable structured-log rows retained in SQLite
ANTHROPIC_API_KEY=sk-ant-...     # (or OPENAI_API_KEY, GEMINI_API_KEY, ...)
```

### Security checklist (do this before exposing to the internet)

Marina's HTTP API requires authentication **by default** — but it's easy to weaken it, so verify:

- [ ] **Set `MODEL_API_KEYS`** (comma-separated bearer tokens) for the `/v1/*` and `/api/*` LLM endpoints. Clients send `Authorization: Bearer <token>`.
- [ ] **Set `MEM_API_KEYS`** (comma-separated `secret:agent` pairs) if you expose the `/mem` Memory API.
- [ ] **Never set `MARINA_OPEN_API=true`** on a public host — it disables API auth entirely. It's a local-dev convenience only.
- [ ] **Enable dashboard sign-in** with `MARINA_AUTH=better-auth` (+ `BETTER_AUTH_SECRET`) for any human-facing public host — see [authentication.md](../authentication.md). Without it the dashboard is open to anyone who can reach it.
- [ ] **Encrypt API keys at rest.** Provider keys saved in the Admin → Keys panel are AES-256-GCM encrypted in the DB. Without `MARINA_KEY_SECRET`, Marina generates the secret itself in `<DB_PATH>.key-secret` (mode 0600) and encrypts keys saved from then on (keys stored as plaintext before keep working until you re-save them or set an explicit secret). For a managed deployment set `MARINA_KEY_SECRET` (≥ 16 chars; `openssl rand -base64 32`) from your secret manager — an explicit secret also encrypts existing plaintext rows in place — or prefer the provider **env vars** (`ANTHROPIC_API_KEY`, …, `LLAMA_API_KEY`), which are read live and never persisted. Admin → Security shows the live state. (Back up the secret or the `.key-secret` file with the database — losing it orphans stored keys.)
- [ ] **Set `ALLOWED_ORIGINS`** to your real dashboard origin(s) if clients run cross-origin. Unset = same-origin only (no CORS header), which is the safe default.
- [ ] **Don't publish ports 4000 (telnet) and 3302 (log viewer)** — neither is authenticated. Telnet is off by default (`TELNET_PORT=0`), and both listeners now bind the resolved `WS_HOST` (loopback unless you opt into exposure), but the publish spec is still your boundary: keep them off your public load balancer / security group. The default docker-compose publishes all ports to the host's `127.0.0.1` only.
- [ ] **Set `GATEWAY_SECRET`** if (and only if) you use [federation](federation.md). Otherwise leave it unset.
- [ ] **Terminate TLS at a reverse proxy** (next section). Marina speaks plain HTTP/WS; never expose `3300` directly to the internet.
- [ ] Rate limits are built in (WS 5/s, MCP 5/s, Model API 2/s per IP, Memory API 10/s per agent, dashboard REST 60/10 s per principal, canvas + asset writes 30/10 s per principal, public `/api/entity/*` 30/10 s per IP, MCP sessions 10/min per IP, pre-auth `/api/setup-status` 20/min per IP, model-API reads 120/min per IP, public asset reads 300/min per IP, and 20 failed `/v1` / `/mem` credentials per IP per minute before that address is refused) but a proxy-level limit is still wise. Per-IP limits key on the TCP peer; set `MARINA_TRUST_PROXY=true` behind your reverse proxy so they key on `X-Forwarded-For` instead.
- [ ] **MCP behind a public hostname**: set `MARINA_MCP_ALLOWED_HOSTS=mcp.example.com` (DNS-rebinding guard; unset, a public bind accepts only loopback names, the bind address, the machine hostname and the `BETTER_AUTH_URL`/`ALLOWED_ORIGINS` hosts) — the transport already requires a `MODEL_API_KEYS` bearer on any non-loopback bind. See [mcp.md](../mcp.md#transport-security).
- [ ] **Request bodies** are capped at 8 MiB (`MARINA_MAX_REQUEST_BODY_BYTES`); asset uploads at 50 MiB (`MARINA_MAX_UPLOAD_BYTES`). Uploaded assets are MIME-allowlisted and served with `nosniff` + a no-script CSP; every HTML page gets `X-Frame-Options: SAMEORIGIN` and the dashboard Content-Security-Policy below.

### Dashboard Content-Security-Policy

Every HTML route (`/dashboard`, `/canvas`, `/who/*`, `/chat`, `/ask`, the "dashboard not built" placeholder) is served with this header (`HTML_CSP` in `src/net/http-utils.ts`):

```
default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/pdf.js/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self' https:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
```

The built dashboard loads one same-origin module script and no inline scripts, so `script-src 'self'` is enforced — an injected `<script>` or `javascript:` URL does not run. The grants beyond `'self'` are the ones the bundle genuinely uses: inline `style=` attributes (motion, React Flow), Google Fonts (the display/mono faces), the pdf.js worker from cdnjs (path-scoped to the pdf.js directory), `blob:`/`data:` object URLs for previews, WebSockets, and `https:` iframes for the `embed` canvas node / asset kind (sandboxed). `/chat` and `/ask` carry inline scripts and receive the same policy with their scripts' `'sha256-…'` digests appended — never `'unsafe-inline'`.

- **`MARINA_DASHBOARD_CSP=off`** removes the header (framing protection via `X-Frame-Options` stays). Use only while diagnosing a blocked resource.
- **`MARINA_DASHBOARD_CSP="<policy>"`** replaces it verbatim on every HTML route — e.g. to add the origin of an external asset store to `img-src`/`media-src`, or to drop the Google Fonts / cdnjs grants once you self-host them. A custom policy gets no inline-script hashes appended: include them (or `'unsafe-inline'` for `script-src`) yourself if `/chat` and `/ask` stay reachable, or keep only the SPA routes behind it.
- Blocked loads show up in the browser console as `Refused to load … because it violates the following Content Security Policy directive`. Report the resource and directive rather than switching the header off in production.

## Reverse proxy + TLS

Put a proxy in front of `WS_PORT`. It must forward WebSocket upgrade headers (for `/ws` and the dashboard's live feed). [Caddy](https://caddyserver.com) does this with automatic HTTPS in two lines:

```caddyfile
marina.example.com {
    reverse_proxy localhost:3300
}
```

Caddy proxies WebSockets transparently. The equivalent nginx `location /` needs `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`. Behind an AWS ALB, enable the WebSocket-compatible defaults and a generous idle timeout (the WS server caps idle at ~255s; set the ALB idle timeout to 300s+).

## Persistence & backups

The world database, optional auth database, assets, workspaces and configuration form the recoverable instance. A database-only online snapshot is useful independently:

```bash
# Consistent, WAL-safe and verified database snapshot
docker compose exec marina ./scripts/backup.sh /app/data/marina.db /app/data/backups
```

`scripts/backup.sh` uses the verified SQLite snapshot implementation (`VACUUM INTO`,
integrity/foreign-key checks, hash, restricted permissions). `scripts/restore.sh BACKUP NEW_DB`
refuses existing destinations. For complete instance recovery use the [offline recovery bundle](recovery.md).
The JSON export/import scripts move selected logical tables; they do not include binary assets,
workspaces or all credentials, and their output can still contain private content.

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

## Workspace tooling

The repository is a single [Bun workspace](https://bun.sh/docs/install/workspaces). One `bun install`
at the root resolves every member from the one `bun.lock`; the members have no lockfiles of their own.

| Member | Path | What it is |
|--------|------|------------|
| `marina` | `/` | the server, CLI, SDK build, tests |
| `marina-dashboard` | `dashboard/` | the React dashboard SPA (built into `dist/dashboard`) |
| `marina-site` | `site/` | the Astro + Starlight documentation site |
| `marina-desktop` | `marina-desktop/` | the Electrobun desktop shell |
| `marina-usecase-ui` | `examples/usecase-ui/` | example React front end |
| `marina-coding-agent-demo` | `examples/coding-agent-demo/` | Code Mode demo fixture (its failing test is deliberate) |
| `@marina/agent-sdk` | `src/sdk/` | the TypeScript SDK manifest |

Two packages are deliberately **not** workspace members and keep their own `bun.lock`:
`extensions/local-embeddings` (onnxruntime-node + MiniLM — a large native dependency that must not
enter the standard install) and `extensions/langgraph-store` (pulls LangGraph). Both are published
with their lockfiles via the root `files` list and installed on demand with
`bun install --cwd extensions/<name> --frozen-lockfile`.

Bun uses the *isolated* linker for workspaces: each member's `node_modules/` holds symlinks into the
shared `node_modules/.bun/` store, and only packages a member **declares** are resolvable from it. A
bare import of a transitive dependency ("phantom dependency") that used to work under a hoisted
`node_modules/` now fails at build or run time — declare it in that member's `package.json` instead.
Two root-only tables apply to the whole graph regardless of which member pulls the package in:
`overrides` and `patchedDependencies` (Bun ignores both in member manifests; `check:overrides`
lists any it finds there as IGNORED).

Build outputs are unchanged: `bun run dashboard:build` still emits `dist/dashboard`, `bun run
build:memory` still emits `dist/memory.js`, and `prepack` runs both so the npm tarball keeps them.

### `bun run check:versions`

Every versioned `package.json` in the repository (workspace member or not, `node_modules` excluded)
must carry the root version. The script prints one row per manifest and exits 1 on a mismatch; CI
runs it in the backend job before the tests, and `qualify:release` runs it first. Bump every manifest
together when cutting a release.

### `bun run check:overrides`

Audits the root `overrides` table against the dependency graph. For each override it reads every
dependent's declared range from `bun.lock`, asks the registry (`bun info <pkg> versions`) which
version each range would pick today **without** the override, and reports:

- `still needed` — some dependent would land below the floor (or, for an exact-version *pin*, the
  dependents would otherwise split across several versions);
- `no longer needed` — every dependent already lands at or above the floor on its own;
- `unknown` — registry unreachable and the lockfile alone cannot decide (`--offline` forces this
  mode).

The `note` lines flag the harmful case: a floor whose range excludes a version a dependent
explicitly declares (a `^6` floor forcing a `^8` dependent down to 6.x). The **documented** column
cross-references the rationale table below (plus `SECURITY.md`, `README.md`, and the rest of
`docs/`) — an override with no written reason shows `NO`. `--strict` exits 1 on any
`no longer needed`; `--json` emits the full report. The nightly workflow prints the table
non-blocking; run `bun run check:overrides --strict` before removing or adding an override.

Why each override exists (keep this table in sync with `package.json`):

| Override | Kind | Reason |
|----------|------|--------|
| `@hono/node-server` `^1.19.15`, `hono` `^4.13.5` | floor | security advisory floors for the MCP SDK's HTTP transport (initial audit, commit 8c1aab9). |
| `@protobufjs/utf8` `^1.1.1`, `protobufjs` `^7.6.3` | floor | security advisory floors below the Google GenAI / gRPC transitive chain (8c1aab9). |
| `basic-ftp` `^5.3.1` | floor | security advisory floor for a transitive of the upstream provider SDKs (8c1aab9). |
| `body-parser` `^2.3.0`, `qs` `^6.16.0`, `path-to-regexp` `^8.4.0` | floor | Express 5 transitive security advisories (body-parser floor from 90321d5 "update vulnerable dependencies"). |
| `express-rate-limit` `^8.2.2`, `ip-address` `^10.5.0` | floor | security advisory floors for the MCP SDK's rate limiter; the `ip-address` floor was lifted from `marina-desktop` (socks proxy chain under electrobun) when the workspace was unified. |
| `fast-uri` `^3.1.6` | floor | security advisory floor for ajv's URI parser (8c1aab9). |
| `fast-xml-builder` `^1.1.7`, `fast-xml-parser` `^5.7.0` | floor | security advisory floors for the AWS SDK XML layer (8c1aab9); nothing in the current graph depends on them — remove once `check:overrides --strict` agrees. |
| `lodash` `^4.18.0` | floor | prototype-pollution security advisories in older 4.17.x (8c1aab9). |
| `proxy-addr` `^2.0.8`, `source-map-js` `^1.2.2` | floor | security advisory floors (CVE-2026-90711 critical, Express's `trust proxy` parser; CVE-2026-93749 high, DoS in the bundler source-map chain) raised by the image scan on 2026-10-06; the dependents' ranges already admit the fixed versions, so remove once `check:overrides --strict` agrees and the lockfile holds them. |
| `undici` `^6.28.0` | floor | security advisory floor for discord.js's fetch client (8c1aab9). Caution: as a root-wide override it also forces `jsdom` (`^8`) and astro's `unifont` (`^8`) down to 6.x — the audit flags this; the floor is met naturally today. |
| `ws` `^8.20.1` | floor | security advisory floor (DoS with many headers) for the WebSocket client shared by discord.js and the MCP SDK (8c1aab9). |
| `zod` `4.6.5` | pin | dedup pin, not a security floor: the MCP SDK's zod types and better-auth's zod v4 must share one copy (commit 4bf8dbd). |

## Continuous deployment (CI/CD)

On push to `main`, [`Deploy to EC2`](../../.github/workflows/deploy-ec2.yml) builds the image, pushes it to ECR, and — because the host is in a private subnet — uses **AWS SSM Run Command** (not SSH) to pull the pinned `:<commit-sha>` image and `docker compose up -d` via [`scripts/deploy.sh`](../../scripts/deploy.sh). Auth is via **GitHub OIDC** (no static keys). Setup lives in repo **secret** `GH_OIDC_ROLE_H2O_MARINA` and **variables** `AWS_REGION` / `MARINA_INSTANCE_ID` / `MARINA_APP_DIR`; the AWS side (OIDC role + ECR repo) is managed in Terraform.

### Rollback
Every image is tagged by **commit SHA** (immutable), so rolling back means redeploying an older tag — no rebuild. Three ways, easiest first:

1. **One-click (recommended):** Actions → **Deploy to EC2 → Run workflow**, set the **`rollback_sha`** input to the full commit SHA you want live. The workflow **skips build/push** (verifies the `sha-<…>` image exists in ECR first) and redeploys that image via SSM.
2. **On the host:**
   ```bash
   MARINA_IMAGE=<account-id>.dkr.ecr.<region>.amazonaws.com/<ecr-repo>:sha-<old-sha> \
   AWS_REGION=<region> sudo -H bash /home/ubuntu/Marina/scripts/deploy.sh
   ```
3. **`git revert`** the bad commit on `main` and let CI build + deploy the revert.

The prior image is usually still cached locally (we only prune *dangling* images), so the rollback pull is instant.

### Running `docker compose` manually on the host
- The CI deploy runs as **root** via SSM. If you SSH in (as `ubuntu`) and run `docker compose up -d` yourself, Compose resolves the image from `${MARINA_IMAGE:-marina:local}` — i.e. a **local build** unless you `export MARINA_IMAGE=…:<sha>`. That can differ from the SHA the pipeline last deployed, so prefer setting `MARINA_IMAGE` (or just re-trigger the workflow) to stay deterministic.
- **Heads-up:** the next CI deploy runs `git reset --hard`, which **overwrites local edits to tracked files** (e.g. a hand-edited `docker-compose.yml`) on the host. Keep host-specific config in `.env` (untracked) and persistent data in the `./marina-data` bind-mount — both survive deploys.

### Image retention
`deploy.sh`'s `docker image prune -f` only removes **dangling** layers; old `:sha-…` tags are not dangling, so they're kept (on the host, that's deliberate — it makes rollback instant). Registry storage is bounded by an **ECR lifecycle policy** on the repo (archive images unpulled for 30d → expire 90d after), managed in Terraform. On the host, run `docker image prune -a` on a schedule if disk pressure arises.

### Build details
The image is built and pushed with `docker/build-push-action` + `docker/metadata-action` (Buildx layer cache via `type=gha`, OCI labels). Tags: `type=sha,format=long` → `sha-<commit-sha>` (immutable; what the deploy pins to) and `latest` on the default branch.
