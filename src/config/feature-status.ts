// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Feature status: an honest map of what Marina ships and what actually runs.
 * `docs/reference/feature-status.md` renders this table for readers;
 * `test/feature-status.test.ts` keeps the page, the command help text and this
 * list in step.
 *
 *   core          used broadly; on by default or by every world
 *   siloed        general, but used by one subsystem (arena, forecasting, …)
 *   experimental  built and tested, but nothing in production uses it yet, or
 *                 it is off/observe-only by default
 *   demo          used only by demos, showcase worlds and tests
 *   deprecated    kept for compatibility; do not build on it
 *
 * A whole command that is experimental lists itself in `commands`: its help
 * text then starts with {@link EXPERIMENTAL_HELP_PREFIX}.
 */

export type FeatureStatus = "core" | "siloed" | "experimental" | "demo" | "deprecated";

export interface FeatureStatusEntry {
  /** Feature name as the docs table shows it. */
  name: string;
  status: FeatureStatus;
  /** How to turn it on or reach it. */
  enable: string;
  /** Owner area (source directory or subsystem). */
  owner: string;
  /** World commands that exist only for this feature (help is labelled). */
  commands?: readonly string[];
}

/** The first token of an experimental command's help text. */
export const EXPERIMENTAL_HELP_PREFIX = "[experimental]";

/** Label a command's help text experimental (idempotent). */
export function experimentalHelp(help: string): string {
  return help.startsWith(EXPERIMENTAL_HELP_PREFIX) ? help : `${EXPERIMENTAL_HELP_PREFIX} ${help}`;
}

export const FEATURE_STATUS: readonly FeatureStatusEntry[] = [
  // ── core ────────────────────────────────────────────────────────────────
  {
    name: "Engine, tick loop, command registry",
    status: "core",
    enable: "Always on",
    owner: "src/engine",
  },
  {
    name: "Default world (Workbench)",
    status: "core",
    enable: "`MARINA_WORLD` unset or `default`",
    owner: "worlds/default",
  },
  {
    name: "Empty world",
    status: "core",
    enable: "`MARINA_WORLD=empty` (minimal base for tests and hosts)",
    owner: "worlds",
  },
  {
    name: "Resident agents, roles, traits",
    status: "core",
    enable: "Seeded by the world; `agent spawn`",
    owner: "src/agent",
  },
  { name: "Channels and DMs", status: "core", enable: "`channel`, `tell`", owner: "src/engine" },
  { name: "Tasks", status: "core", enable: "`task`", owner: "src/engine" },
  {
    name: "Memory (canonical records, unified context)",
    status: "core",
    enable: "Always on",
    owner: "src/memory",
  },
  {
    name: "MCP exposure (world tools, capabilities)",
    status: "core",
    enable: "`MCP_PORT`",
    owner: "src/net/mcp",
  },
  {
    name: "Model API (`/v1`, passthru)",
    status: "core",
    enable: "`MODEL_API_KEYS` or `MARINA_OPEN_API=true`",
    owner: "src/net/model-api",
  },
  { name: "Dashboard", status: "core", enable: "`WS_PORT`", owner: "dashboard" },
  { name: "Chronicle", status: "core", enable: "`chronicle`", owner: "src/engine" },
  {
    name: "Spend ledger (per world) and daily cap",
    status: "core",
    enable: "Always on; cap with `MARINA_DAILY_SPEND_CAP_USD`",
    owner: "src/engine",
  },
  {
    name: "Harness decisions (gate, classifier, verify)",
    status: "core",
    enable: "`MARINA_DECISIONS` (default `auto`), `MARINA_DECISION_GATE=on`",
    owner: "src/decisions",
  },
  {
    name: "Standing, rank and safety gates",
    status: "core",
    enable: "Always on; `standing`, `gate`",
    owner: "src/agent, src/engine",
  },
  {
    name: "Challenges (approval holds)",
    status: "core",
    enable: "Always on; `challenge`",
    owner: "src/engine",
  },
  {
    name: "Outcomes and lessons",
    status: "core",
    enable: "`MARINA_LESSONS`",
    owner: "src/outcomes, src/learning",
  },
  {
    name: "Memory assistance (evaluator/reflector jobs)",
    status: "core",
    enable: "Workers with the evaluator/reflector roles",
    owner: "src/persistence",
  },
  { name: "Code Mode", status: "core", enable: "`code`", owner: "src/engine/commands/code" },
  // ── siloed ──────────────────────────────────────────────────────────────
  {
    name: "Canvas",
    status: "siloed",
    enable: "`canvas`; the feed publisher writes the `feed` canvas",
    owner: "src/engine/commands/canvas.ts, src/net/feed-publisher.ts",
  },
  {
    name: "Forecast pipeline",
    status: "siloed",
    enable: "`forecast`, `POST /v1/forecast`, forecasting scripts",
    owner: "src/forecast",
  },
  {
    name: "Social Simulation Arena (routed forecaster, shadow challengers)",
    status: "siloed",
    enable: "`arena`, `scripts/arena.ts`, `MARINA_ARENA_*`",
    owner: "src/arena",
  },
  {
    name: "Benchmarks",
    status: "siloed",
    enable: "`benchmark` (rank 4), `bun run benchmark`",
    owner: "benchmarks",
  },
  {
    name: "TabH2O",
    status: "siloed",
    enable: "`TABH2O_API_KEY`; arena challenger, `market forecast`",
    owner: "src/arena, src/net/clients",
  },
  {
    name: "Quant helpers, data lookups, read swarm",
    status: "siloed",
    enable: "`quant`, `data`, `web swarm`",
    owner: "src/quant, src/forecast, src/research",
  },
  {
    name: "Formation catalogue (Score templates, pure combiners)",
    status: "siloed",
    enable:
      "Always on: typed forecast formations (`MARINA_FORECAST_FORMATION`), resident forecasts, `pattern run`, arena `formation:ensemble` and `formation:delphi`",
    owner: "src/orchestration/formations",
  },
  {
    name: "Research evidence loop and survey",
    status: "siloed",
    enable: "`MARINA_RESEARCH_*`",
    owner: "src/research",
  },
  {
    name: "Research web agent, cited answers, fact pass",
    status: "siloed",
    enable:
      "In world: `research ask` (rank 0, spend-guarded) and the typed `marina_research` tool; benchmark scripts (`scripts/mind2web2.ts`, deepresearch)",
    owner: "src/research",
  },
  {
    name: "Skills",
    status: "core",
    enable:
      "`skill`; 5 built-ins (`skill builtin`); residents get the best-fitting skill in their prompt (`MARINA_SKILLS_RESIDENT`, default on); note seeds with `MARINA_SEED_SKILLS=true` (showcase)",
    owner: "src/agent",
  },
  // ── experimental ────────────────────────────────────────────────────────
  {
    name: "Embedding lifecycle (data dir, endpoint file, idle shutdown, parent watch)",
    status: "experimental",
    enable:
      "Experimental: for embedding hosts. `MARINA_DATA_DIR`, `MARINA_IDLE_SHUTDOWN`, `MARINA_PARENT_PID`; `marina endpoint`",
    owner: "src/net/instance-lifecycle.ts",
  },
  {
    name: "Shared spend ledger",
    status: "experimental",
    enable: "`MARINA_SPEND_LEDGER=<path>`",
    owner: "src/engine/shared-spend-ledger.ts",
  },
  {
    name: "Adaptive load-balance routing",
    status: "experimental",
    enable: "Request header `X-Load-Balance: adaptive`",
    owner: "src/net/model-api",
  },
  {
    name: "Benchmark route evidence for `model:route`",
    status: "experimental",
    enable: "`MARINA_ROUTE_EVIDENCE=on` (default `observe` records only)",
    owner: "src/engine/benchmark-evidence.ts",
  },
  {
    name: "Earned forecast routing",
    status: "experimental",
    enable: "`MARINA_FORECAST_HISTORY` with enough resolved outcomes",
    owner: "src/forecast",
  },
  {
    name: "Supervised residents",
    status: "experimental",
    enable: "`MARINA_SUPERVISED_RESIDENTS=on` (server and supervisor)",
    owner: "src/routing/residents.ts, src/routing/supervisor.ts, src/routing/attention-bridge.ts",
  },
  {
    name: "Peer code review",
    status: "experimental",
    enable:
      "`code review request <name>` or `auto`; supervised residents attach worktree snapshots",
    owner: "src/engine/commands/code/review-request.ts, src/routing/review-snapshot.ts",
  },
  {
    name: "Research authority mode",
    status: "experimental",
    enable: "`MARINA_RESEARCH_AUTHORITY=on`",
    owner: "src/research",
  },
  {
    name: "The Arbiter",
    status: "experimental",
    enable: "`MARINA_FORECAST_ARBITER`, `MARINA_VERIFY_ARBITER`; `arbiter`",
    owner: "src/orchestration/arbiter.ts",
  },
  {
    name: "Forecasts by residents (as-of fence)",
    status: "experimental",
    enable:
      "`MARINA_FORECAST_RESIDENTS=on`; `forecast <q> crew:<c> pattern:<p>` (ensemble, delphi, tournament, skeptic)",
    owner:
      "src/forecast/resident-part.ts, src/forecast/resident-forecast.ts, src/engine/evidence-fence.ts",
  },
  {
    name: "Hybrid and vector retrieval",
    status: "experimental",
    enable: "`MARINA_MEMORY_EMBEDDINGS`, `MARINA_CORPUS_EMBEDDINGS`",
    owner: "src/memory, src/research",
  },
  {
    name: "H2O-Lightning decision preset",
    status: "experimental",
    enable:
      "`MARINA_LIGHTNING_MODEL=<OpenRouter id>` then `MARINA_DECISIONS=lightning` (no default id; off)",
    owner: "src/decisions/config.ts",
  },
  {
    name: "Text patterns (`pattern run`, `POST /v1/patterns/run`)",
    status: "experimental",
    enable:
      "`pattern run <pattern> -- <task>` (rank 0, spend-guarded) and the typed `marina_pattern` tool; `POST /v1/patterns/run`",
    owner:
      "src/orchestration/text-patterns.ts, src/orchestration/formations, src/engine/commands/pattern.ts",
    commands: ["pattern"],
  },
  {
    name: "Typed resident analysis tools (`marina_forecast`, `marina_research`, `marina_swarm`, `marina_data`, `marina_quant`, `marina_calc`, `marina_decision_check`, `marina_triage`, `marina_arbiter`, `marina_pattern`)",
    status: "experimental",
    enable:
      "Deferred in the `full` tool profile: loaded by name through `marina_tool_search` (`MARINA_DEFERRED_TOOLS=off` keeps them resident); each runs its world command",
    owner: "src/agent/tools/analysis.ts, src/agent/analysis-commands.ts",
  },
  {
    name: "Investigations",
    status: "experimental",
    enable: "`inquiry`, `marina inquiry`, `/api/investigations`",
    owner: "src/investigations",
    commands: ["inquiry"],
  },
  {
    name: "Schedules",
    status: "experimental",
    enable: "`schedule add …`",
    owner: "src/schedules",
    commands: ["schedule"],
  },
  {
    name: "Evolution (coach, native protocols, `marina_evolve`, child worlds)",
    status: "experimental",
    enable:
      "`evolve`; protocols and the `marina_evolve` tool need `MARINA_EVOLUTION_PROTOCOLS=true`",
    owner: "src/engine/commands/evolve.ts, src/agent/tools/evolution.ts",
    commands: ["evolve"],
  },
  {
    name: "Experiments",
    status: "experimental",
    enable: "`experiment`",
    owner: "src/engine/commands/experiment.ts",
    commands: ["experiment"],
  },
  {
    name: "Markets and positions",
    status: "experimental",
    enable: "`market`, `position` (paper); live trading needs `MARINA_TRADING_ENABLED=true`",
    owner: "src/resolvers, src/net/clients",
    commands: ["market", "position"],
  },
  {
    name: "Federation (gateways, meshes)",
    status: "experimental",
    enable: "`gateway`, `mesh`; `GATEWAY_SECRET`",
    owner: "src/engine/gateway-runtime.ts",
    commands: ["gateway", "mesh"],
  },
  {
    name: "Learned bundles",
    status: "experimental",
    enable: "`learned`, `bun run learned`",
    owner: "src/learned",
    commands: ["learned"],
  },
  {
    name: "Media generation jobs",
    status: "experimental",
    enable: "`image generate`, `video generate`, `audio` (needs a media-capable provider)",
    owner: "src/engine/commands/image.ts, src/persistence/db-media.ts",
  },
  // ── demo ────────────────────────────────────────────────────────────────
  {
    name: "Built-in worlds other than `default` and `empty` (13)",
    status: "demo",
    enable: "`MARINA_WORLD=<slug>`; `marina worlds` shows each status",
    owner: "worlds",
  },
  {
    name: "Orchestration templates (16 pool-note patterns)",
    status: "demo",
    enable: "`project <name> orchestrate <pattern>`",
    owner: "src/world/templates/orchestration.ts",
  },
  // ── deprecated ──────────────────────────────────────────────────────────
  {
    name: "`MARINA_HOST`",
    status: "deprecated",
    enable: "Alias of `WS_HOST` (`WS_HOST` wins)",
    owner: "src/net",
  },
  {
    name: "`NSED` pattern name",
    status: "deprecated",
    enable: "Accepted as Deliberation, never advertised",
    owner: "src/world/templates/orchestration.ts",
  },
];
