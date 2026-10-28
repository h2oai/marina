// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Capability posture: for everything Marina ships but does not run by
 * default — every non-core {@link FEATURE_STATUS} entry and every `MARINA_*`
 * setting whose documented default is `off`, `observe` or `false` — what
 * measurement would switch it on, and the date by which someone decides.
 *
 *   measure    a technique waiting on evidence. `evidence` names where the
 *              evidence lands (an outcome source, a judge-ledger surface, the
 *              benchmark ledger, or an operator's decision that is never
 *              automatic) and `decideBy` is the ISO date by which it is
 *              promoted, kept as it is with a new date, or reclassified.
 *   by-design  off on purpose (security, spend, external accounts, a
 *              deployment shape, a demo or a compatibility alias): a one-line
 *              reason and no deadline.
 *
 * `posture` (the command), the `capability-posture` readiness line and
 * `docs/reference/capability-posture.md` read this table;
 * `test/capability-posture.test.ts` fails when an off/observe/false setting in
 * `config/environment.reference` has no entry here, or an entry names a
 * setting that no longer exists.
 */

import type { FeatureStatus } from "./feature-status";
import { FEATURE_STATUS } from "./feature-status";

/** Where the evidence that would promote an entry lands. */
export type PostureEvidence =
  /** Resolved outcomes (`outcomes` table): by source (a prefix ends in `:`) and/or kind. */
  | {
      kind: "outcomes";
      source?: string;
      outcomeKind?: "forecast" | "task" | "request" | "benchmark";
    }
  /** Judge opinions (`judge_ledger`): one surface (a prefix ends in `:`), or every surface. */
  | { kind: "judge"; surface?: string }
  /** The benchmark ledger (`benchmark_runs`): one benchmark, or any. */
  | { kind: "benchmark"; benchmark?: string }
  /** A person decides; nothing promotes it automatically. */
  | { kind: "operator" };

export type Posture =
  | { class: "measure"; evidence: PostureEvidence; promoteWhen: string; decideBy: string }
  | { class: "by-design"; reason: string };

/** Decision tiers (ISO dates). */
const NOV_15 = "2026-11-15";
const DEC_1 = "2026-12-01";
const JAN_15 = "2027-01-15";

const measure = (evidence: PostureEvidence, promoteWhen: string, decideBy: string): Posture => ({
  class: "measure",
  evidence,
  promoteWhen,
  decideBy,
});
const byDesign = (reason: string): Posture => ({ class: "by-design", reason });
const outcomes = (
  source?: string,
  outcomeKind?: "forecast" | "task" | "request" | "benchmark",
): PostureEvidence => ({
  kind: "outcomes",
  ...(source ? { source } : {}),
  ...(outcomeKind ? { outcomeKind } : {}),
});
const judge = (surface?: string): PostureEvidence => ({
  kind: "judge",
  ...(surface ? { surface } : {}),
});
const bench = (benchmark?: string): PostureEvidence => ({
  kind: "benchmark",
  ...(benchmark ? { benchmark } : {}),
});
const operator: PostureEvidence = { kind: "operator" };

const EARNED_JUDGE = "the judge earns on its surface (`judge stats`), then `on`";
const PAIRED = "a paired `benchmark compare-run` wins on the board";
const ARENA = "a lock-ordered arena backtest beats the incumbent on mean per-round skill";
const MEMORY_BOARD = "a paired run on the memory board wins without a retrieval regression";
const FORECAST_BOARD = "a held-out forecast backtest wins by the promotion margin";
const RECORDS_ONLY = "a world uses the records in live work (core) or nothing does (deprecate)";

/**
 * Every `MARINA_*` setting whose documented default is `off`, `observe` or
 * `false`, keyed by name.
 */
export const KNOB_POSTURE: Readonly<Record<string, Posture>> = {
  // ── Network, access and safety ──────────────────────────────────────────
  MARINA_PUBLIC: byDesign("network exposure is the operator's choice; loopback by default"),
  MARINA_ALLOW_INSECURE_PUBLIC: byDesign("acknowledges an unauthenticated non-loopback bind"),
  MARINA_SINGLE_PORT: byDesign("a deployment shape, not a capability"),
  MARINA_TRUST_PROXY: byDesign("trusting X-Forwarded-For is safe only behind a known proxy"),
  MARINA_OPEN_API: byDesign("development only: unauthenticated API access"),
  MARINA_OPS_NOTIFY: byDesign("needs an operator-supplied destination"),
  MARINA_FEDERATION_ALLOW_UNSIGNED: byDesign("accepts events whose origin cannot be verified"),
  MARINA_URL_GUARD_DNS_FAIL_OPEN: byDesign("weakens the SSRF guard; restricted-DNS hosts only"),
  MARINA_TRADING_ENABLED: byDesign("live orders move money; operator-grant `trading.live`"),
  MARINA_DECISION_GATE: byDesign("a fail-closed restriction an operator adds, never by evidence"),
  MARINA_CODE_CONTAINER_NETWORK: byDesign("container egress is an operator's sandbox choice"),
  MARINA_CODE_CONTAINER_MODEL_API: byDesign(
    "container egress to the model API is an operator's choice",
  ),
  MARINA_COGNITIVE_PROVENANCE: byDesign("records full payloads; privacy cost by default"),
  MARINA_OTLP_ENABLED: byDesign("needs an operator-run collector"),
  MARINA_OTLP_LOGS_ENABLED: byDesign("needs an operator-run collector"),
  MARINA_OTLP_ALLOW_INSECURE: byDesign("plaintext export to a remote collector"),
  MARINA_ARENA_AUTOPILOT: byDesign("filing an external competition is an operator act"),
  MARINA_MODEL_ROUTE_FALLBACK: byDesign("moves library calls (data and spend) to another route"),
  MARINA_PASSTHRU_RESPONSE_CACHE: byDesign("replays an earlier answer; the caller opts in"),
  MARINA_AGENT_CACHE_KEEPALIVE: byDesign(
    "spends tokens on idle pings; worth it only for known traffic",
  ),
  MARINA_MEMORY_EMBEDDING_LOCAL_ONLY: byDesign("a restriction an operator adds to the embedder"),
  MARINA_CORPUS_EMBEDDING_LOCAL_ONLY: byDesign("a restriction an operator adds to the embedder"),
  MARINA_PERCEIVE_SELF_ECHO: byDesign(
    "a debugging aid; on puts self-echo noise back in perceptions",
  ),
  MARINA_SEED_SKILLS: byDesign("a showcase-world seed option"),
  MARINA_UNIFIED_CANVAS: byDesign("a retired view kept reachable"),

  // ── Judges ──────────────────────────────────────────────────────────────
  MARINA_JUDGE: measure(judge(), EARNED_JUDGE, DEC_1),
  MARINA_CHALLENGE_JUDGE: measure(judge("challenge"), EARNED_JUDGE, DEC_1),
  MARINA_ATTENTION_JUDGE: measure(judge("attention:"), EARNED_JUDGE, DEC_1),
  MARINA_DECISION_VERIFY: measure(judge("verify"), EARNED_JUDGE, NOV_15),
  MARINA_MEDIA_VERIFY: measure(
    operator,
    "the verifier's labels agree with a person's review of generated images",
    JAN_15,
  ),
  MARINA_FORECAST_ARBITER: measure(
    judge("arbiter"),
    "overrule precision clears the Arbiter's earned bar",
    DEC_1,
  ),
  MARINA_VERIFY_ARBITER: measure(
    judge("arbiter"),
    "overrule precision clears the Arbiter's earned bar",
    DEC_1,
  ),

  // ── Agent runtime and routing ───────────────────────────────────────────
  MARINA_AGENT_THINKING: measure(bench(), `${PAIRED} on cost per success`, DEC_1),
  MARINA_PEER_REPLY_CHAIN: measure(
    judge("attention:"),
    "the converge judge earns and long exchanges end without lost work",
    DEC_1,
  ),
  MARINA_EVOLUTION_PROTOCOLS: measure(
    operator,
    "an evolve trial's adopted role beats its parent in a child world",
    JAN_15,
  ),
  MARINA_ROUTE_EVIDENCE_WINDOW: measure(
    outcomes(),
    "live-work evidence picks the same or better models as the benchmark ledger",
    DEC_1,
  ),
  MARINA_ANTHROPIC_AUTO_CACHE: measure(bench(), `${PAIRED} on cost per success`, NOV_15),

  // ── Harness decisions (advisory use cases) ──────────────────────────────
  MARINA_RESEARCH_ADVICE: measure(bench("frames"), PAIRED, DEC_1),
  MARINA_MEMORY_CONTEXT_VALUE: measure(bench("longmemeval-v2-small"), MEMORY_BOARD, DEC_1),
  MARINA_CREW_DELIVERABLE_REVIEW: measure(
    outcomes("task:verdict"),
    "reviewed crew deliverables are approved more often by their creators",
    DEC_1,
  ),

  // ── Forecasting and research ────────────────────────────────────────────
  MARINA_RESEARCH_EVIDENCE: measure(bench("forecastbench-backtest"), FORECAST_BOARD, DEC_1),
  MARINA_RESEARCH_TARGET_EVIDENCE: measure(bench("forecastbench-backtest"), FORECAST_BOARD, DEC_1),
  MARINA_RESEARCH_AUTHORITY: measure(bench("futurex-past-clean"), FORECAST_BOARD, DEC_1),
  MARINA_FORECAST_CONTRACT: measure(bench("futurex-past-clean"), FORECAST_BOARD, DEC_1),
  MARINA_FORECAST_QUANT: measure(bench("forecastbench-backtest"), FORECAST_BOARD, DEC_1),
  MARINA_FORECAST_TRIAGE: measure(bench("futurex-past-clean"), FORECAST_BOARD, DEC_1),
  MARINA_FORECAST_SHADOW: measure(
    operator,
    "an operator accepts the daily spend for paired live evidence",
    NOV_15,
  ),
  MARINA_FORECAST_RESIDENTS: measure(
    outcomes(undefined, "forecast"),
    "resident-answered forecasts score at least as well as the model panel",
    JAN_15,
  ),

  // ── Social Simulation Arena ─────────────────────────────────────────────
  MARINA_ARENA_EVIDENCE_REFRESH: measure(outcomes("arena:"), ARENA, JAN_15),
  MARINA_ARENA_TRENDS_PARTIAL: measure(outcomes("arena:"), ARENA, JAN_15),
  MARINA_ARENA_NOWCAST_HORIZON: measure(outcomes("arena:"), ARENA, JAN_15),
  MARINA_ARENA_RESEARCH_REQUIRED: measure(outcomes("arena:"), ARENA, JAN_15),
  MARINA_ARENA_RESEARCH_LOOKUPS: measure(outcomes("arena:"), ARENA, JAN_15),
  MARINA_ARENA_RESEARCH_SIGNALS: measure(outcomes("arena:"), ARENA, JAN_15),
  MARINA_ARENA_FORMATION_LESSONS: measure(outcomes("arena:"), ARENA, JAN_15),
  MARINA_ARENA_RESEARCH_LESSONS: measure(outcomes("arena:"), ARENA, JAN_15),

  // ── Memory and the obligations ledger ───────────────────────────────────
  MARINA_MEMORY_RANKING: measure(bench("longmemeval-v2-small"), MEMORY_BOARD, DEC_1),
  MARINA_MEMORY_RELEVANCE_GATE: measure(bench("longmemeval-v2-small"), MEMORY_BOARD, DEC_1),
  MARINA_MEMORY_INGEST_NOTES: measure(bench("longmemeval-v2-small"), MEMORY_BOARD, DEC_1),
  MARINA_OBLIGATIONS_CONSENT: measure(bench("tau2-airline"), PAIRED, DEC_1),
};

/**
 * Every non-core feature, keyed by its exact {@link FEATURE_STATUS} name.
 */
export const FEATURE_POSTURE: Readonly<Record<string, Posture>> = {
  "Shared task work, structured deliverables and declared checks": measure(
    operator,
    "paired long-horizon tasks produce more complete, source-supported deliverables per total cost without restricting participant autonomy",
    DEC_1,
  ),
  "Orchestration › one free-text task (`pattern run`, `POST /v1/patterns/run`)": measure(
    bench(),
    `${PAIRED} against the single-model control`,
    DEC_1,
  ),
  "Orchestration › a room's turn rule (formations in a room)": measure(
    operator,
    "a world runs a room formation in live work",
    JAN_15,
  ),
  "Orchestration › projects (pool notes generated from the catalogue)": byDesign(
    "a demo surface for the catalogue",
  ),
  "Orchestration › legacy names (`nsed`, `custom`)": byDesign("compatibility aliases"),
  Canvas: byDesign("a view surface; its status follows use, not a measurement"),
  "Forecast pipeline": measure(
    outcomes(undefined, "forecast"),
    "resolved forecasts beat the plain-model baseline outside the arena",
    DEC_1,
  ),
  "Social Simulation Arena (routed forecaster, shadow challengers)": byDesign(
    "one external competition; filing is an operator act",
  ),
  Benchmarks: byDesign("an operator's instrument; benchmarks never become defaults"),
  TabH2O: byDesign("needs an external account key"),
  "Quant helpers, data lookups, read swarm": measure(
    bench("forecastbench-backtest"),
    FORECAST_BOARD,
    DEC_1,
  ),
  "Research evidence loop and survey": measure(
    bench("forecastbench-backtest"),
    FORECAST_BOARD,
    DEC_1,
  ),
  "Research web agent, cited answers, fact pass": measure(
    outcomes("research:ask"),
    "cited answers are accepted in live work as often as uncited ones",
    DEC_1,
  ),
  "Resolvers, probes and watches": measure(
    operator,
    "a second subsystem resolves its own outcomes through a resolver",
    JAN_15,
  ),
  "Embedding lifecycle (data dir, endpoint file, idle shutdown, parent watch)": byDesign(
    "for embedding hosts only",
  ),
  "OpenShell sandbox provider": byDesign("needs an operator-run gateway"),
  "Shared spend ledger": byDesign("a deployment shape an operator chooses"),
  "Adaptive load-balance routing": measure(
    operator,
    "judged traces show adaptive picks beat least-busy",
    JAN_15,
  ),
  "Benchmark route evidence for `model:route`": measure(
    bench(),
    "a route chosen from ledger evidence wins its role's board",
    NOV_15,
  ),
  "Earned forecast routing": measure(
    outcomes(undefined, "forecast"),
    "routed formations beat the default formation on resolved history",
    DEC_1,
  ),
  "Attention judges": measure(judge("attention:"), EARNED_JUDGE, DEC_1),
  "Peer code review": measure(
    outcomes("code:verify"),
    "reviewed attempts pass their checks more often than unreviewed ones",
    DEC_1,
  ),
  "Private rooms": byDesign("an owner's choice per room; public is the default"),
  "Research authority mode": measure(bench("futurex-past-clean"), FORECAST_BOARD, DEC_1),
  "The Arbiter": measure(judge("arbiter"), "overrule precision clears the earned bar", DEC_1),
  "Forecasts by residents (as-of fence)": measure(
    outcomes(undefined, "forecast"),
    "resident-answered forecasts score at least as well as the model panel",
    JAN_15,
  ),
  "Hybrid and vector retrieval": measure(bench("longmemeval-v2-small"), MEMORY_BOARD, DEC_1),
  "H2O-Lightning decision preset": byDesign("needs an operator-chosen model id"),
  "Typed resident analysis tools (`marina_forecast`, `marina_research`, `marina_swarm`, `marina_data`, `marina_quant`, `marina_calc`, `marina_decision_check`, `marina_triage`, `marina_arbiter`, `marina_pattern`)":
    measure(bench(), `${PAIRED} with the tools resident vs deferred`, DEC_1),
  Investigations: measure(operator, "investigations run in live work", JAN_15),
  Schedules: measure(operator, "people or agents keep schedules running in live work", NOV_15),
  "Evolution (coach, native protocols, `marina_evolve`, child worlds)": measure(
    operator,
    "an evolve trial's adopted role beats its parent in a child world",
    JAN_15,
  ),
  Experiments: measure(operator, "replicated experiments run in live work", JAN_15),
  "Markets and positions": measure(
    outcomes("market"),
    "paper positions resolve with positive calibrated edge",
    JAN_15,
  ),
  "Federation (gateways, meshes)": byDesign("needs a peer instance and a shared secret"),
  "Learned bundles": measure(
    operator,
    "an imported bundle's lessons are served and a fresh install uses them",
    DEC_1,
  ),
  "Intellect records (identity across models and processes, lifecycle claims)": measure(
    operator,
    RECORDS_ONLY,
    JAN_15,
  ),
  "Lineage records (derived intellects, world manifests, child worlds)": measure(
    operator,
    RECORDS_ONLY,
    JAN_15,
  ),
  "Change records (`mutation`)": measure(operator, RECORDS_ONLY, JAN_15),
  "Associations (who takes part and how they relate)": measure(operator, RECORDS_ONLY, JAN_15),
  "Economic provenance records": measure(operator, RECORDS_ONLY, JAN_15),
  "Simulation run records (`lab`)": measure(operator, RECORDS_ONLY, JAN_15),
  "Media generation jobs": byDesign("needs a media-capable provider"),
  "Scores (`conduct`, `marina_conduct`)": measure(
    bench(),
    `${PAIRED} against the same crew without a Score`,
    JAN_15,
  ),
  "Scenario boards": measure(operator, RECORDS_ONLY, JAN_15),
  "Built-in worlds other than `default` and `empty` (13)": byDesign("demo worlds"),
  "`MARINA_HOST`": byDesign("deprecated alias of `WS_HOST`"),
};

/** A setting the posture table must cover: a `MARINA_*` key whose default is off. */
export function isOffByDefault(key: string, example: string): boolean {
  return key.startsWith("MARINA_") && /^(off|observe|false)$/i.test(example.trim());
}

export interface PostureEntry {
  /** The setting name, or the feature's name. */
  subject: string;
  type: "setting" | "feature";
  /** The feature's status (features only). */
  status?: FeatureStatus;
  posture: Posture;
}

/** Every entry, features first (in registry order), then settings by name. */
export function postureEntries(): PostureEntry[] {
  const features: PostureEntry[] = FEATURE_STATUS.flatMap((f) => {
    const posture = FEATURE_POSTURE[f.name];
    return posture
      ? [{ subject: f.name, type: "feature" as const, status: f.status, posture }]
      : [];
  });
  const settings: PostureEntry[] = Object.keys(KNOB_POSTURE)
    .sort()
    .map((k) => ({ subject: k, type: "setting" as const, posture: KNOB_POSTURE[k]! }));
  return [...features, ...settings];
}

const DAY = 86_400_000;

/** Whole days from `now` to the end of `decideBy` (UTC); negative once past. */
export function daysUntil(decideBy: string, now = Date.now()): number {
  return Math.floor((Date.parse(`${decideBy}T23:59:59.999Z`) - now) / DAY);
}

/** Measure entries past their `decideBy` date, oldest deadline first. */
export function overduePosture(now = Date.now(), entries = postureEntries()): PostureEntry[] {
  return entries
    .filter((e) => e.posture.class === "measure" && daysUntil(e.posture.decideBy, now) < 0)
    .sort((a, b) =>
      a.posture.class === "measure" && b.posture.class === "measure"
        ? a.posture.decideBy.localeCompare(b.posture.decideBy)
        : 0,
    );
}

/** One line naming where an entry's evidence lands. */
export function describeEvidence(e: PostureEvidence): string {
  switch (e.kind) {
    case "outcomes":
      return `outcomes ${[e.source ? `source ${e.source}` : "", e.outcomeKind ? `kind ${e.outcomeKind}` : ""].filter(Boolean).join(", ") || "(any)"}`;
    case "judge":
      return `judge ledger ${e.surface ? `surface ${e.surface}` : "(every surface)"}`;
    case "benchmark":
      return `benchmark ledger ${e.benchmark ?? "(any board)"}`;
    case "operator":
      return "operator choice: never automatic";
  }
}

const cell = (s: string) => s.replaceAll("|", "\\|");

/** `docs/reference/capability-posture.md`, generated by `bun run docs:api`. */
export function renderPostureReference(): string {
  const entries = postureEntries();
  const measured = entries.filter((e) => e.posture.class === "measure");
  const lines = [
    "# Capability posture",
    "",
    "Generated from `src/config/capability-posture.ts` by `bun run docs:api`. Do not edit by hand.",
    "",
    "Every non-core feature in the [feature status](feature-status.md) table and every `MARINA_*`",
    "setting whose documented default is `off`, `observe` or `false` has one posture:",
    "",
    "| Posture | Meaning |",
    "|---|---|",
    "| measure | Waiting on evidence. The entry names where that evidence lands and the date by which it is promoted, kept with a new date, or reclassified. |",
    "| by-design | Off on purpose (security, spend, an external account, a deployment shape, a demo or an alias). No deadline. |",
    "",
    "In the world, `posture` lists each entry with its current value, the last time its evidence",
    "source recorded anything, and the days left before its date; the `capability-posture` readiness",
    "line is degraded while any date has passed. The dates are development deadlines; informational",
    "on installs: that line is optional and never raises an alert. `test/capability-posture.test.ts`",
    "fails when a new",
    "off-by-default setting has no entry.",
    "",
    `## Measure (${measured.length})`,
    "",
    "| Subject | Evidence | Promote when | Decide by |",
    "|---|---|---|---|",
    ...measured.map((e) =>
      e.posture.class === "measure"
        ? `| ${cell(e.type === "setting" ? `\`${e.subject}\`` : e.subject)} | ${cell(describeEvidence(e.posture.evidence))} | ${cell(e.posture.promoteWhen)} | ${e.posture.decideBy} |`
        : "",
    ),
    "",
    `## By design (${entries.length - measured.length})`,
    "",
    "| Subject | Reason |",
    "|---|---|",
    ...entries.flatMap((e) =>
      e.posture.class === "by-design"
        ? [
            `| ${cell(e.type === "setting" ? `\`${e.subject}\`` : e.subject)} | ${cell(e.posture.reason)} |`,
          ]
        : [],
    ),
  ];
  return `${lines.join("\n")}\n`;
}
