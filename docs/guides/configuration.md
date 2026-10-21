# Configuration

Marina reads process environment values first, then Bun's `.env` files in the instance's
working directory. Every setting is optional. [`.env.example`](../../.env.example) is a short
starter to copy; [`config/environment.reference`](../../config/environment.reference) is the
complete annotated catalog that the dashboard settings editor (Admin → Settings) and the
generated [environment reference](../reference/environment.md) are built from.

```bash
bun run init --yes --preset minimal --directory /path/to/instance
bun run init --check --directory /path/to/instance
```

`minimal` starts the empty world without background agents or auxiliary listeners.
`workbench` selects the default world. `shared-team` selects the same default world with sign-in and
persistent auth storage, generating a private auth secret when absent. All presets bind
loopback initially. Configure your public URL, TLS proxy, verified admins and deliberate
bind policy before exposing a shared instance. Capability presets and trust profiles are
separate choices.

Existing settings and comments are preserved; existing values override preset defaults.
`--print` previews a preset with secrets redacted. `--check` validates without writing.
Files are written atomically with mode 0600. Run `marina start` from that instance directory
when using the installed CLI. Process environment overrides remain effective at startup.
Use `readiness` for actual capability configuration and `readiness providers` for live
connectivity checks (the latter may spend provider tokens).

What Marina stores, what it sends where, and the switches for each web source (robots.txt,
the keyless DuckDuckGo and Yahoo Finance fallbacks) are in
[Data, privacy and terms](data-privacy-and-terms.md).

---

## Minimal Setup

No configuration needed for local development. Just run:

```bash
bun run start
```

This starts the dashboard and default Workbench on loopback under the `local` trust profile. The
model API accepts a key Marina generates into `<DB_PATH>.local-api-key` and prints at boot; the
Memory API (`/mem`) stays closed until `MEM_API_KEYS` is set. Agents need one provider key (or a
local model) to think. With `AGENT_AUTORESPAWN` unset, the seeded Workbench agents start at boot on
a `local` install that has a provider; set `AGENT_AUTORESPAWN=false` to keep them stopped, or `true`
to start them on a shared or public instance. Telnet is off by default because it is plaintext and unauthenticated; enable it with
`TELNET_PORT=4000` only on a trusted network.

---

## Common Configurations

### Trust profile: local (ungated) vs shared vs public

Marina decides who it is for from how it is bound, and removes friction accordingly:

| Profile | When (if `MARINA_PROFILE` is unset) | What it means |
|---|---|---|
| `local` | every listener binds loopback and `MARINA_AUTH` is off | **Ungated for you.** Every safety gate except live trading (`trading.live`) auto-passes for the loopback operator, every loopback person login is sovereign, your arbitrary host commands run without a prompt (`code exec-mode auto`), rate limits, login caps and memory budgets are off, database durability defaults to `normal`. An **agent's** host shell (`shell.exec`) and arbitrary host commands (`code.exec.unrestricted`) are held for your approval. Audit stays on. |
| `shared` | `MARINA_AUTH=better-auth` is on | Gates, ranks and limits enforced; sign-in identifies people. |
| `public` | any non-loopback bind without sign-in | Everything enforced; passwordless names carry no authority. |

A fresh `bun run start` on your own machine is therefore `local` with nothing to configure. To keep
the gates on a personal instance anyway, set `MARINA_AUTONOMY=guarded` or `MARINA_PROFILE=shared`.
Forcing `MARINA_PROFILE=local` on a public bind is a fatal startup error unless you set
`MARINA_ALLOW_INSECURE_PUBLIC=true` — enabling sign-in does not help, because `local` ungates every
gate for every signed-in user. The boot log prints the resolved profile and
why. The realistic risk on a local instance is a poisoned shared-pool note leading an agent to run a
host command, so that is the one thing still held: an agent's `run raw` / `shell` and its
non-allowlisted Code Mode commands raise a challenge (`challenge approve <token>`, or
`code exec-approve <token>` in Code Mode) and run once you approve them. The agent is never
blocked while it waits. Agents promoted on an older database may still hold shell grants:
`gate audit` lists them and `gate reset agents all apply` revokes them.

To lift every gate regardless of profile, for a sovereign, self-hosted Marina with no guests (a
homelab or a private network you control), set `MARINA_AUTONOMY=sovereign`. Every gate (the core
included), rank floor and hold is off for every principal, agents' host commands included; audit stays on, and the profile still
sets the performance defaults. On a non-loopback bind it also needs
`MARINA_ALLOW_INSECURE_PUBLIC=true`, signed in or not. `MARINA_AUTONOMY=open` is not this switch:
it never lifts the core.

### Set yourself as admin

```bash
MARINA_ADMINS=YourName bun run start
```

When `YourName` logs in from a loopback connection, it is bootstrapped as a sovereign and receives
the rank-tiered operator gates. Remote connections claiming the name are refused, and the list is
redundant under the `local` profile, where every loopback login is already sovereign; with sign-in
on, use `MARINA_AUTH_ADMIN_EMAILS` instead. Arbitrary unrestricted host execution remains separately governed and is not granted by
rank. Multiple admins:

```bash
MARINA_ADMINS=Alice,Bob bun run start
```

### Choose a world

```bash
MARINA_WORLD=showcase bun run start
```

Available worlds (`default` and `empty` are core; the others are demo worlds, marked `[demo]` by
`marina worlds` — see [feature status](../reference/feature-status.md)):

| World | What You Get |
|-------|-------------|
| `default` | Four-room reactive Workbench with Host/Builder/Critic/Chronicler, Demo Pulse tasks, and progressive complexity. |
| `showcase` | Full 5x5 grid, specialist crews, benchmarks, markets, and broad capability demos. |
| `commons` | Pre-seeded projects and room templates on a themed grid. |
| `research` | Lab, observatory, archive spaces. Good for structured experimentation. |
| `personal` | Privacy-focused workspaces. Good for a solo agent evolving itself. |
| `craft` | Workshop + review spaces. Good for spec-driven development. |
| `evolve` | 8 benchmark objectives. Good for testing agent capabilities. |
| `markets` | Live Kalshi/Polymarket feeds, prediction spaces, Brier scoring. Good for forecasting. |
| `prediction-lab` | Focused forecasting loop: resolvable question, base rate, independent evidence, probability, resolution, and calibration review. |
| `deep-research` | Parallel source-grounded research with claim verification, contradiction handling, and cited synthesis. |
| `red-team` | Structured proposal attack, evidence-backed rebuttal, adjudication, dissent, and remediation. |
| `due-diligence` | Parallel market, product, technical, and business workstreams ending in a decision memo and risk register. |
| `data-investigation` | Dataset profiling, competing hypotheses, reproducible analysis, independent validation, and findings report. |
| `demos` | Lobby, workshop, bridge. Good for interactive demonstrations. |
| `empty` | One empty space. Good for building everything from scratch. |

### Choose models (cheap by default)

Work that names no model runs on one of two **model tiers**
(`src/config/model-tiers.ts`):

| Tier | Runs | Unset |
|------|------|-------|
| `cheap` — `MARINA_MODEL_TIER_CHEAP` | residents spawned without a model, room agents, boot-seeded crews (the Workbench, answerer and orchestration crews, the Chronicler), memory helpers | `MARINA_DEFAULT_MODEL` or a runtime default when one is set; else the cheapest adequate tool-capable model for your keys (`openrouter/deepseek/deepseek-v4.1-flash` with an OpenRouter key; `anthropic/claude-haiku-5-5`, `openai/gpt-6-luna`, … otherwise); else `marina/default` |
| `strong` — `MARINA_MODEL_TIER_STRONG` | what grades or overrules: the benchmark judge, outcome extractor, lesson writer and judge, decision classifier, the Arbiter | `marina/default`, exactly as before — judging never turns cheap by accident |

One line moves a tier; one entry moves a single role:

```bash
MARINA_MODEL_TIER_CHEAP=openrouter/deepseek/deepseek-v4.1-flash   # every resident and crew
MARINA_MODEL_TIER_STRONG=openrouter/anthropic/claude-opus-5.5     # every judge and the Arbiter
MARINA_AGENT_MODELS=role:crew=anthropic/claude-sonnet-5-5,Host=openai/gpt-6.1-sol
```

Roles are `resident`, `room`, `crew`, `helper`, `judge`, `outcome-judge`,
`lessons-judge`, `decisions` and `arbiter`. Older specific variables still win
over the tier (`MARINA_CREW_MODEL`, `MARINA_WORKBENCH_MODEL`,
`MARINA_BENCHMARK_JUDGE_MODEL`, `MARINA_DECISION_MODEL`, …), and so do a
model named on `agent spawn`, `agent config <name> model …`, and a per-agent
`MARINA_AGENT_MODELS` entry. `marina/cheap` and `marina/strong` are also model
ids on `/v1`, resolved per request, so an agent saved on `marina/cheap` follows
a later tier change after a restart. The `/v1` `marina` model is unchanged.

`admin models` (readable by everyone) prints the effective model for each tier
and role and where it came from; the boot log prints the two tier lines.
Escalation stays where it was: the Arbiter runs only on contested items, and
`model:route` / earned routing can pick a stronger candidate per agent.

**Upgrading:** with no model variable set, residents, room agents, seeded crews
and memory helpers move from `marina/default` (and the Workbench from each
provider's flagship) to the cheap tier. Judges, decisions and the Arbiter do
not change. An operator who set `MARINA_DEFAULT_MODEL`, a runtime default,
`MARINA_CREW_MODEL` or `MARINA_WORKBENCH_MODEL` sees no change for what those
cover. Agents saved with an explicit model keep it.

### Change ports

```bash
WS_PORT=8080 TELNET_PORT=4001 MCP_PORT=8081 bun run start
```

### Host names the server answers to

On a loopback bind (the default) and under the `local` profile, the HTTP and WebSocket listener
answers only to loopback `Host` names (`localhost`, `127.0.0.1`, `[::1]`) and the `BETTER_AUTH_URL` host, and returns `421` for
anything else, so a web page on a DNS name that points at 127.0.0.1 cannot reach your instance.
If you reach it by another name — a reverse proxy on the same host, a LAN name — list it:

```bash
MARINA_ALLOWED_HOSTS=marina.example.com,marina.lan:3300 bun run start
```

A bare name matches on any port, `name:port` only on that port. On a non-loopback bind `Host` is
not checked unless you set this variable. `/mcp` on its own port uses `MARINA_MCP_ALLOWED_HOSTS`.

### Secure the model API

```bash
MODEL_API_KEYS=sk-my-secret-key-1,sk-my-secret-key-2 bun run start
```

Now API requests need `Authorization: Bearer sk-my-secret-key-1` (the same keys guard MCP). Without
this variable the model API accepts only the generated local key under the `local` profile and is
closed otherwise.

### Connect Discord or Telegram

```bash
DISCORD_TOKEN=your-discord-bot-token bun run start
TELEGRAM_TOKEN=your-telegram-bot-token bun run start
```

See [Discord & Telegram](chat-adapters.md) for bot setup.

---

## All Environment Variables

The complete list, with defaults and which settings the dashboard may not edit, is the
[environment reference](../reference/environment.md), generated from
[`config/environment.reference`](../../config/environment.reference). Room agents spawned by a
world authenticate with an internal token generated at startup, so they need no `MODEL_API_KEYS`
entry, only a configured provider or reachable local model. For collector export, see
[Execution Traces and Evaluations](observability.md).

### Flywheel isolated execution (optional)

Flywheel is additive: Marina and local Code Mode work normally when these variables are absent. When
configured, Marina creates one durable sandbox per entity and exposes both the identity-scoped MCP
tool and the `code sandbox`/`project`/`service` workflow. Marina must reach the Flywheel Connect RPC
endpoint from its own process or container.

| Variable | Default | What It Does |
|----------|---------|-------------|
| `FLYWHEEL_TOKEN` | *(off)* | Server-side Flywheel operator credential. Enables the integration; never returned to entities or persisted in Marina. |
| `FLYWHEEL_RPC_URL` | `http://localhost:8088/rpc` | Flywheel Connect RPC base URL as seen by Marina. In Docker, `localhost` means the Marina container, so use a reachable service or host address. |
| `FLYWHEEL_IMAGE` | `localhost/h2oai/flywheel-agentd:latest` | Default image for `code sandbox start` and MCP `flywheel create`. The image must be resolvable by the configured Flywheel backend. |

The live qualification knobs (`MARINA_FLYWHEEL_LIVE_*`) are in
[Release qualification](release-qualification.md#script-knobs). Start with `code doctor`, then
`code sandbox status`. Configuration alone never changes a coding
session from local to Flywheel, and a Flywheel failure never retries a sandbox command on the host.
See [Coding](coding.md) and [Flywheel integration](../integrations/flywheel.md).

### Drop-in Compatibility (Passthru)

Marina plays three roles with respect to agents — **participant** (agents inside worlds), **consumer** (Marina calling out to upstream LLMs), and **passthru** (external clients calling in). This section is about passthru.

External OpenAI-compatible clients point at Marina by way of **compat profiles** registered in `src/net/adapters/compat-profiles.ts`. Each profile declares model-id aliases that all resolve to the default `model` channel. All profiles are enabled by default; override with `MARINA_COMPAT=name1,name2` or `MARINA_COMPAT=none`.

**OpenAI clients** (OpenWebUI, LobeChat, curl, any OpenAI SDK): point `base_url` at `http://<host>:3300/v1` and use any registered alias as the model id (e.g. `assistant`) or just `marina`. The `/v1/responses` endpoint provides server-side state (`previous_response_id` threading) backed by conversation channels.

**Ollama clients**: same host, use `/api/tags`, `/api/chat`, `/api/generate`.

**Editor / agent clients** (Zed, JetBrains, VS Code, Neovim, …): launch the ACP bridge with `bun run scripts/acp.ts <name>` — stdio ndjson JSON-RPC 2.0 speaking ACP protocol 1. ACP is a generic protocol; any client that speaks it works.

**MCP clients**: `/mcp` endpoint on `:3301`.

Adding an alias is a one-line entry in `src/net/adapters/compat-profiles.ts`. Today's registered profiles:

| Profile | Aliases |
|---|---|
| `openai` | `assistant` |

Compat profiles only register model-id aliases on `/v1/models` and resolve to the default `model` channel — they are independent of which world is loaded. Disable them with `MARINA_COMPAT=none`.

---

### Tabular Foundation Model (TabH2O)

Marina is built by H2O. When `TABH2O_API_KEY` is set, any agent in a markets-capable world can call `market forecast <id>` to get a calibrated probability from H2O's tabular foundation model, trained in-context on past resolved markets. The forecast writes a provenance `inference` note; when the market resolves, a calibration outcome note is linked back automatically (see the calibration finder registry in `src/resolvers/calibration.ts`).

| Variable | Default | What It Does |
|----------|---------|-------------|
| `TABH2O_API_KEY` | *(none)* | Bearer token for the TabH2O prediction API. Without it, `market forecast` returns a clear admin hint and agents fall back to LLM reasoning. |
| `TABH2O_ENDPOINT` | `https://tabh2o.h2oai.com/api/v1/predict` | Override for self-hosted / dedicated TabH2O deployments. |

A `tabh2o` connector row is seeded on every world boot so `connect list` always shows the integration point. Missing key leaves the connector discoverable-but-inactive so admins can notice and configure it.

---

## Production Example

```bash
# .env
WS_PORT=8080
TELNET_PORT=0          # telnet off (plaintext/unauthenticated) — recommended in production
MCP_PORT=8081
LOG_PORT=8082
DB_PATH=/data/marina.db
ASSETS_DIR=/data/assets
MARINA_WORLD=default
MARINA_ADMINS=Alice,Bob
MODEL_API_KEYS=sk-prod-key-1,sk-prod-key-2
LOG_FORMAT=json
LOG_LEVEL=info
DISCORD_TOKEN=your-discord-bot-token
TELEGRAM_TOKEN=123:ABC...
```

---

## Docker

```bash
docker build -t marina .
docker run -p 3300:3300 -p 3301:3301 \
  -e MARINA_WORLD=default \
  marina
```

---

## Hard-Coded Limits

These aren't configurable via env vars but are good to know (the per-IP WebSocket connection cap
is: `WS_MAX_CONNECTIONS_PER_IP`, default 100):

| What | Value |
|------|-------|
| Max total WebSocket connections | 1000 |
| WebSocket idle timeout | 255 seconds |
| Max commands processed per tick | 1000 |
| Command queue size before dropping | 5000 |
| Dashboard update interval | 2 seconds |
