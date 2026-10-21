# Feature status

What Marina ships, and what actually runs. Every major feature has one status:

| Status | Meaning |
|---|---|
| core | Used broadly; on by default or in every world. |
| siloed | General, but only one subsystem uses it (arena, forecasting, benchmarks). |
| experimental | Built and tested, but no production deployment uses it yet, or it is off / observe-only by default. Interfaces may change. |
| demo | Used only by demos, showcase worlds and tests. |
| deprecated | Kept for compatibility; do not build on it. |

The table mirrors `FEATURE_STATUS` in [`src/config/feature-status.ts`](../../src/config/feature-status.ts);
`test/feature-status.test.ts` fails when the two disagree. A world command that exists only for an
experimental feature starts its help text with `[experimental]`, and `marina worlds` marks demo worlds
`[demo]` (`"status"` in `--json`).

| Feature | Status | How to enable | Owner area |
|---|---|---|---|
| Engine, tick loop, command registry | core | Always on | src/engine |
| Default world (Workbench) | core | `MARINA_WORLD` unset or `default` | worlds/default |
| Empty world | core | `MARINA_WORLD=empty` (minimal base for tests and hosts) | worlds |
| Resident agents, roles, traits | core | Seeded by the world; `agent spawn` | src/agent |
| Channels and DMs | core | `channel`, `tell` | src/engine |
| Tasks | core | `task` | src/engine |
| Memory (canonical records, unified context) | core | Always on | src/memory |
| MCP exposure (world tools, capabilities) | core | `MCP_PORT` | src/net/mcp |
| Model API (`/v1`, passthru) | core | `MODEL_API_KEYS` or `MARINA_OPEN_API=true` | src/net/model-api |
| Dashboard | core | `WS_PORT` | dashboard |
| Chronicle | core | `chronicle` | src/engine |
| Spend ledger (per world) and daily cap | core | Always on; cap with `MARINA_DAILY_SPEND_CAP_USD` | src/engine |
| Harness decisions (gate, classifier, verify) | core | `MARINA_DECISIONS` (default `auto`), `MARINA_DECISION_GATE=on` | src/decisions |
| Standing, rank and safety gates | core | Always on; `standing`, `gate` | src/agent, src/engine |
| Challenges (approval holds) | core | Always on; `challenge` | src/engine |
| Outcomes and lessons | core | `MARINA_LESSONS` | src/outcomes, src/learning |
| Memory assistance (evaluator/reflector jobs) | core | Workers with the evaluator/reflector roles | src/persistence |
| Code Mode | core | `code` | src/engine/commands/code |
| Canvas | siloed | `canvas`; the feed publisher writes the `feed` canvas | src/engine/commands/canvas.ts, src/net/feed-publisher.ts |
| Forecast pipeline | siloed | `forecast`, `POST /v1/forecast`, forecasting scripts | src/forecast |
| Social Simulation Arena (routed forecaster, shadow challengers) | siloed | `arena`, `scripts/arena.ts`, `MARINA_ARENA_*` | src/arena |
| Benchmarks | siloed | `benchmark` (rank 4), `bun run benchmark` | benchmarks |
| TabH2O | siloed | `TABH2O_API_KEY`; arena challenger, `market forecast` | src/arena, src/net/clients |
| Quant helpers, data lookups, read swarm | siloed | `quant`, `data`, `web swarm` | src/quant, src/forecast, src/research |
| Formation catalogue (Score templates, pure combiners) | siloed | Always on: typed forecast formations (`MARINA_FORECAST_FORMATION`), resident forecasts, `pattern run`, arena `formation:ensemble` and `formation:delphi` | src/orchestration/formations |
| Research evidence loop and survey | siloed | `MARINA_RESEARCH_*` | src/research |
| Research web agent, cited answers, fact pass | siloed | In world: `research ask` (rank 0, spend-guarded) and the typed `marina_research` tool; benchmark scripts (`scripts/mind2web2.ts`, deepresearch) | src/research |
| Skills | core | `skill`; 5 built-ins (`skill builtin`); residents get the best-fitting skill in their prompt (`MARINA_SKILLS_RESIDENT`, default on); note seeds with `MARINA_SEED_SKILLS=true` (showcase) | src/agent |
| Embedding lifecycle (data dir, endpoint file, idle shutdown, parent watch) | experimental | Experimental: for embedders (Flow, Nov 2026). `MARINA_DATA_DIR`, `MARINA_IDLE_SHUTDOWN`, `MARINA_PARENT_PID`; `marina endpoint` | src/net/instance-lifecycle.ts |
| Shared spend ledger | experimental | `MARINA_SPEND_LEDGER=<path>` | src/engine/shared-spend-ledger.ts |
| Adaptive load-balance routing | experimental | Request header `X-Load-Balance: adaptive` | src/net/model-api |
| Benchmark route evidence for `model:route` | experimental | `MARINA_ROUTE_EVIDENCE=on` (default `observe` records only) | src/engine/benchmark-evidence.ts |
| Earned forecast routing | experimental | `MARINA_FORECAST_HISTORY` with enough resolved outcomes | src/forecast |
| Supervised residents | experimental | `MARINA_SUPERVISED_RESIDENTS=on` (server and supervisor) | src/routing/residents.ts, src/routing/supervisor.ts, src/routing/attention-bridge.ts |
| Peer code review | experimental | `code review request <name>` or `auto`; supervised residents attach worktree snapshots | src/engine/commands/code/review-request.ts, src/routing/review-snapshot.ts |
| Research authority mode | experimental | `MARINA_RESEARCH_AUTHORITY=on` | src/research |
| The Arbiter | experimental | `MARINA_FORECAST_ARBITER`, `MARINA_VERIFY_ARBITER`; `arbiter` | src/orchestration/arbiter.ts |
| Forecasts by residents (as-of fence) | experimental | `MARINA_FORECAST_RESIDENTS=on`; `forecast <q> crew:<c> pattern:<p>` (ensemble, delphi, tournament, skeptic) | src/forecast/resident-part.ts, src/forecast/resident-forecast.ts, src/engine/evidence-fence.ts |
| Hybrid and vector retrieval | experimental | `MARINA_MEMORY_EMBEDDINGS`, `MARINA_CORPUS_EMBEDDINGS` | src/memory, src/research |
| H2O-Lightning decision preset | experimental | `MARINA_LIGHTNING_MODEL=<OpenRouter id>` then `MARINA_DECISIONS=lightning` (no default id; off) | src/decisions/config.ts |
| Text patterns (`pattern run`, `POST /v1/patterns/run`) | experimental | `pattern run <pattern> -- <task>` (rank 0, spend-guarded) and the typed `marina_pattern` tool; `POST /v1/patterns/run` | src/orchestration/text-patterns.ts, src/orchestration/formations, src/engine/commands/pattern.ts |
| Typed resident analysis tools (`marina_forecast`, `marina_research`, `marina_swarm`, `marina_data`, `marina_quant`, `marina_calc`, `marina_decision_check`, `marina_triage`, `marina_arbiter`, `marina_pattern`) | experimental | Deferred in the `full` tool profile: loaded by name through `marina_tool_search` (`MARINA_DEFERRED_TOOLS=off` keeps them resident); each runs its world command | src/agent/tools/analysis.ts, src/agent/analysis-commands.ts |
| Investigations | experimental | `inquiry`, `marina inquiry`, `/api/investigations` | src/investigations |
| Schedules | experimental | `schedule add …` | src/schedules |
| Evolution (coach, native protocols, `marina_evolve`, child worlds) | experimental | `evolve`; protocols and the `marina_evolve` tool need `MARINA_EVOLUTION_PROTOCOLS=true` | src/engine/commands/evolve.ts, src/agent/tools/evolution.ts |
| Experiments | experimental | `experiment` | src/engine/commands/experiment.ts |
| Markets and positions | experimental | `market`, `position` (paper); live trading needs `MARINA_TRADING_ENABLED=true` | src/resolvers, src/net/clients |
| Federation (gateways, meshes) | experimental | `gateway`, `mesh`; `GATEWAY_SECRET` | src/engine/gateway-runtime.ts |
| Learned bundles | experimental | `learned`, `bun run learned` | src/learned |
| Media generation jobs | experimental | `image generate`, `video generate`, `audio` (needs a media-capable provider) | src/engine/commands/image.ts, src/persistence/db-media.ts |
| Built-in worlds other than `default` and `empty` (13) | demo | `MARINA_WORLD=<slug>`; `marina worlds` shows each status | worlds |
| Orchestration templates (16 pool-note patterns) | demo | `project <name> orchestrate <pattern>` | src/world/templates/orchestration.ts |
| `MARINA_HOST` | deprecated | Alias of `WS_HOST` (`WS_HOST` wins) | src/net |
| `NSED` pattern name | deprecated | Accepted as Deliberation, never advertised | src/world/templates/orchestration.ts |

## Notes

- **Embedding lifecycle.** Experimental: for embedders (Flow, Nov 2026). `MARINA_DATA_DIR`, the
  `endpoint.json` file, `MARINA_IDLE_SHUTDOWN` and `MARINA_PARENT_PID` let a host find, adopt and stop
  a Marina it did not start. No host uses them yet (the desktop app embeds Marina in-process); they are
  kept for the Flow integration. The shared spend ledger (`MARINA_SPEND_LEDGER`) is the matching
  per-host cap for one process per world.
- **`marina_evolve`.** The typed evolution tool is deliberately not in `createAllTools`: the agent
  adapter attaches it only while a native evolution protocol is active
  (`MARINA_EVOLUTION_PROTOCOLS=true`).
- **H2O-Lightning.** `MARINA_DECISIONS=lightning` asks H2O-Lightning over OpenRouter's Decisions API.
  Marina ships no model id, so the preset stays off until `MARINA_LIGHTNING_MODEL` names one.
  `decision settings` (and `admin decisions`) print one line: not configured, configured without an
  OpenRouter key, available, or active. Nothing is probed, so the line never costs a call.
- **Text patterns.** `pattern run <pattern> [budget:<usd>] -- <task>` runs the same protocols as
  `POST /v1/patterns/run` in world (rank 0; per-run budget, default $0.50, at most $2; the daily cap;
  one run per entity), over the operator's models only. Residents reach it as the typed
  `marina_pattern` tool. Experimental until a world uses it.
- **Formation catalogue.** One entry per formation (`src/orchestration/formations/catalogue.ts`):
  its one-line description, the Score templates it runs as (typed forecasts with model or resident
  members, free-text `pattern run`, the arena's ensemble and delphi) and pure combiners per answer
  type. The other ten arena formations still run their own code (byte-identical, held by
  `test/formation-equivalence-arena.test.ts`); crew-only formations stay crew briefs that name their
  entry.
- **Typed analysis tools.** Residents load `marina_forecast`, `marina_research`, `marina_swarm`,
  `marina_data`, `marina_quant`, `marina_calc`, `marina_decision_check`, `marina_triage`,
  `marina_arbiter` and `marina_pattern` through `marina_tool_search`. Each builds one world command,
  so rank, gates, rate limits and spend caps apply as typed. Experimental until residents use them.
- **Adaptive load balancing** runs only when a request sends `X-Load-Balance: adaptive`; otherwise
  routing is round-robin (or `least-busy` on request).
- **Experimental is not unsafe.** Experimental commands go through the same rank, gates, challenges
  and spend caps as every other command. The label says that nothing in production depends on them
  yet.

See also: [environment reference](environment.md) for every knob, and the
[generated command API](commands.md) for exact syntax.
