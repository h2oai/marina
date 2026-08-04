# Operating a Marina — capability readiness

This is the operator's answer to "what do I need to spawn/configure so that all of
a Marina's abilities actually work?"

Run **`readiness`** in-world (aliases `doctor`, `health`) at any time to see the
live answer. This doc explains the model behind it. (A matching dashboard
`GET /api/readiness` endpoint exposes the same checks plus a measured demo score.)

## The three tiers

Marina's abilities fall into three tiers. **Only the third needs operator action.**

1. **Always-on** — work the moment the world boots, no agent / no keys / no config:
   - All **read** commands: `chronicle`, `chronicle show/since/about/pending`, canvas
     reads, `feed`, `standing`, `recap`, `recall`.
   - **Engine auto-emit**: the engine itself writes chronicle `event` rows on
     canonical happenings (`task_approved`, crew lifecycle, `rank_change`,
     `market_consensus`) via `FeedPublisher.recordChronicleEvent`. No agent involved.

2. **Seeded but passive** — a world's `seed(db)` registers **definitions**
   (roles/traits) and persistent **agent configs**. A definition/config is *not* a
   running agent. The showcase world seeds: the `chronicler`, `watcher`,
   `market-oracle` roles + traits, a persistent **Chronicler** agent config, and the
   TabH2O connector (`worlds/showcase.ts → seed()`, `worlds/seed.ts`). The default
   Workbench seeds a deliberately small Host/Builder/Critic/Chronicler population and
   a Demo Pulse project; they remain passive configs until auto-respawn or manual spawn.

3. **Agent-driven** — the actual synthesis/automation. Needs **(a)** an upstream LLM
   **provider key** and **(b)** the agent **spawned and running**:
   - Chronicler writing **narrative/digest** entries
   - the **watcher** observation loop
   - **room agents** (guide, market-oracle, …)
   - **crews** / orchestration specialists

The confusion this doc resolves: a seeded agent **config** does not auto-run.
`AGENT_AUTORESPAWN` defaults to **off** (`engine.ts:initAgents`), so seeded/saved
agents only start on boot when `AGENT_AUTORESPAWN=true`, or when an operator spawns
them manually with `agent spawn`.

## Load-bearing env vars

| Var | Effect | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) | Upstream provider key — **gates whether any agent can call a model** | unset |
| `AGENT_AUTORESPAWN` | `true` → seeded/saved agents respawn on boot | off |
| `MARINA_ROOM_AGENTS` | `false` → rooms never spawn their agents | enabled |
| `MODEL_API_KEYS` | Bearer token(s) for external `/v1` callers (Marina-as-LLM). Caller auth, **not** an upstream key | unset |
| `MARINA_OPEN_API` | `true` → dev-only: skip `/v1` + dashboard caller auth | off |
| `TABH2O_API_KEY` | Enables `market forecast` tabular inference | unset |

Provider keys can also be added at runtime (admin) via `key add` / Admin → Keys.

## Capability → enable / needs a running agent / verify

| Capability | What enables it | Needs a running agent? | Verify |
| --- | --- | --- | --- |
| Chronicle reads + auto `event` rows | (nothing) | No | `chronicle since 1h` |
| Chronicle **narrative/digest** | provider key + Chronicler running | **Yes** (Chronicler) | `agent list` → `Chronicler`; `chronicle pending` |
| Watch / probe commands | (nothing) | No | `watch due`, `probe` |
| Watcher **loop** (auto-probe on cadence) | provider key + watcher agent | **Yes** | `agent list` → role `watcher` |
| Room agents | provider key + `MARINA_ROOM_AGENTS≠false` | Yes (lazy, on entry) | enter a room; `agent list` |
| Crews / orchestration | provider key + spawned specialists | Yes | `crew list`; `agent list` |
| Canvas / feed / standing | (nothing) | No | `canvas list`, `feed`, `standing` |
| `market forecast` (tabular) | `TABH2O_API_KEY` | No (HTTP call) | `market forecast <id>` |
| Marina-as-LLM (`/v1`) | `MODEL_API_KEYS` (or `MARINA_OPEN_API`) + provider key | No | startup `model-api` log; `curl /v1/health` |

## Worked example: making Chronicle fully functional

Reads and auto `event` rows already work. For **narrative/digest synthesis** you need
the seeded Chronicler to *run*:

```bash
# Option A — auto-spawn the seeded Chronicler on boot
AGENT_AUTORESPAWN=true ANTHROPIC_API_KEY=sk-ant-... bun run start
```

```text
# Option B — spawn it manually in-world (admin)
agent spawn Chronicler model marina/default role chronicler
```

Verify:

```text
readiness                    # → Chronicler ✓ running  (or ⚠ seeded, not running)
agent list                   # → Chronicler [autonomous] marina/default role:chronicler
chronicle pending            # → un-narrated engine events the Chronicler will write up
chronicle since 1h           # → entries (event + any narrative/digest)
```

## Checking readiness

`readiness` (in-world, rank 0; aliases `doctor`/`health`) returns a per-capability
report — `ok` / `degraded` / `off` with a remediation hint. Example:

```text
readiness

Marina readiness — Marina · world: default
3 ok · 2 degraded · 2 off

  ✓ LLM provider key — a provider key is configured — agents can run
  ✗ Agent auto-respawn — saved agents do NOT auto-spawn on boot
      → Set AGENT_AUTORESPAWN=true to auto-spawn seeded/saved agents, or spawn them manually with `agent spawn`.
  ⚠ Chronicler — seeded but not running — only auto `event` rows are recorded; no narrative/digest synthesis
      → Set AGENT_AUTORESPAWN=true, or run: agent spawn Chronicler model marina/default role chronicler
  ✗ Watcher — watcher role seeded, but no watcher agent running
      → Spawn one: agent spawn Watcher model marina/default role watcher (watch & probe still work without it).
  ✓ Room agents — enabled — rooms spawn their agents (guide, market-oracle, …) on first entry
  ✗ TabH2O forecasting — TABH2O_API_KEY unset — `market forecast` degrades (LLM reasoning still works)
      → Set TABH2O_API_KEY to enable tabular forecasting.
  ⚠ Model API (/v1) — auth set but no upstream provider — /v1 returns 503 until a key or model agent exists
      → Configure an LLM provider key (or run a model-channel provider agent).
```

The check logic lives in `src/engine/readiness.ts` (`computeReadiness(engine)`),
reused by the planned dashboard endpoint. See also [`.env.example`](../.env.example)
for the full env reference and
[`docs/marina-as-llm.md`](marina-as-llm.md) for the `/v1` endpoint.
