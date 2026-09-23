// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared JSON contract for the operator-facing runtime surface.
 *
 * Served by `src/net/ops-api.ts` through `GET /api/ops/overview` and
 * `POST /api/ops/agents/:name/stop`; consumed by the dashboard, which
 * re-exports these types type-only from `dashboard/src/lib/ops-types.ts`
 * (never mirrors them — `dashboard/src/__tests__/ops-contract.test.tsx` pins
 * the derived aliases). Keep this file dependency-free.
 *
 * Privacy contract: rows carry names, states, counters and the last error
 * TEXT of an agent (an operator diagnostic, already shown by `agent status`).
 * Credentials, tokens, IPs, prompts and raw input never appear. Scoping is
 * server-side: a privileged principal sees every row; a resident sees only
 * the agents it spawned (or is) and gets `providers: null`.
 */

export type OpsToolProfile = "full" | "crew" | "minimal";

export type OpsAgentPauseKind = "budget" | "spend-cap" | "upstream-errors";

/** One running (or in-flight) agent as the operator sees it. */
export type AgentOperatorRow = {
  name: string;
  entityId: string | null;
  /** `AgentStatus.state` — starting / connected / autonomous / idle / stopping / stopped / error. */
  state: string;
  /** `AgentStatus.healthState` when the adapter derives one. */
  health: string | null;
  role: string;
  model: string;
  toolProfile: OpsToolProfile;
  /** Entity that spawned this agent (`agent_configs.spawned_by`; `system` when unknown). */
  spawnedBy: string;
  uptimeMs: number;
  toolCalls: number;
  modelCalls: number | null;
  tokens: { input: number; output: number };
  cost: { totalUsd: number; lastHourUsd: number };
  consecutiveErrors: number;
  lastError: { text: string; at: number } | null;
  paused: {
    kind: OpsAgentPauseKind;
    reason: string;
    since: number;
    /** Wall-clock when the pause lifts on its own; null = until the cause clears. */
    until: number | null;
  } | null;
  /** Milliseconds until the autonomous loop's next wake; null when the loop is not running. */
  nextTickInMs: number | null;
  /**
   * False when the handle has no operator accounting (an in-flight spawn or a
   * non-lean adapter): tokens/cost/errors above are then zeros, not measurements.
   */
  operatorStatus: boolean;
};

export type OpsSpend = {
  /** Sum of every visible agent's rolling-hour spend (USD). */
  lastHourUsd: number;
  /** Sum of every visible agent's lifetime spend (USD). */
  totalUsd: number;
  caps: {
    /** `MARINA_MAX_AGENT_COST_USD_PER_HOUR`; null = unlimited. */
    perAgentUsd: number | null;
    /** `MARINA_MAX_COST_USD_PER_HOUR`; null = unlimited. */
    globalUsd: number | null;
  };
};

export type OpsRetentionPolicy = {
  table: string;
  kind: "telemetry" | "ledger" | "audit" | "append-only";
  /** Human keep window: `"90d"`, `"12h"`, `"never"`, `"250000 rows"`. */
  keep: string;
  /** True when `MARINA_RETENTION_OVERRIDES` changed this table's window. */
  overridden: boolean;
  note?: string;
};

export type OpsRetentionReport = {
  at: number;
  deleted: Record<string, number>;
  skipped: string[];
  durationMs: number;
};

export type OpsRetention = {
  /** The last hourly pass this process ran; null before the first one. */
  lastReport: OpsRetentionReport | null;
  policies: OpsRetentionPolicy[];
};

/**
 * One continuation-prompt section aggregated over the sampled agent turns
 * (`agent_turn_start.promptSections`). Byte statistics cover the appearances
 * that reached the prompt (non-deferred); `deferralRate` counts every one.
 */
export type OpsPromptSection = {
  name: string;
  /** Turns in which the section appeared (deferred or not). */
  turns: number;
  meanBytes: number;
  /** Nearest-rank p95 of the non-deferred byte sizes. */
  p95Bytes: number;
  /** deferred appearances / turns, 0..1. */
  deferralRate: number;
  /** This section's non-deferred bytes / total prompt bytes of the window, 0..1. */
  share: number;
};

export type OpsPrompt = {
  /** `MARINA_DEFERRED_TOOLS` is not `off`: the `full` profile ships a loader instead of every schema. */
  deferredTools: boolean;
  /** Byte length of `getLeanSystemPrompt(null)`. */
  systemPromptBytes: number;
  /** `LEAN_SYSTEM_PROMPT_BYTE_CAP`. */
  systemPromptCapBytes: number;
  /** Serialized resident tool-schema bytes per profile (what every request carries). */
  residentSchemaBytesByProfile: Record<OpsToolProfile, number>;
  /** Bytes of `full`-profile schemas loadable on demand (0 when deferral is off). */
  deferredSchemaBytes: number;
  deferredToolCount: number;
  /** `CONTINUATION_PROMPT_BUDGET_BYTES`. */
  continuationBudgetBytes: number;
  /** When these sizes were last measured (memoized per minute). */
  computedAt: number;
  /**
   * Per-section prompt mechanics over the last 24 h of `agent_turn_start`
   * events in the event log, largest share first — scoped like `agents`
   * (a resident sees only the turns of its own lineage). Empty until a
   * producer emits `promptSections`.
   */
  sections: OpsPromptSection[];
  /** Agent turns (last 24 h, in scope) that carried section metrics. */
  turnsSampled: number;
};

/** One provider from the last `readiness providers` conformance probe. */
export type ProviderProbeSummary = {
  provider: string;
  model: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  textOk: boolean;
  systemHonored: boolean;
  /** null = the provider was not tool-probed. */
  toolCallOk: boolean | null;
  toolCallError: string | null;
  /** `provider/model` that actually answered (a fallback when it differs from `provider`). */
  servedBy: string | null;
  error: string | null;
  checkedAt: number;
};

export type OpsLimiter = {
  name: string;
  maxTokens: number;
  refillIntervalMs: number;
  /** `per principal` or `per IP`. */
  keyedBy: "principal" | "ip";
};

export type OpsSecurity = {
  trustProfile: "local" | "shared" | "public";
  /** Local profile without `MARINA_AUTONOMY=guarded` — permission checks are off. */
  ungated: boolean;
  autonomy: "guarded" | "earned" | "open";
  /** `/mcp` requires a bearer at the transport layer. */
  mcpAuthRequired: boolean;
  /** `MARINA_OPEN_API=true` — dev-only read bypass is on. */
  openApi: boolean;
  /** `MARINA_TRUST_PROXY=true` — `X-Forwarded-For` feeds the per-IP limiters. */
  trustProxy: boolean;
  /** `MARINA_AUTH` sign-in gates passwordless name-login. */
  authRequired: boolean;
  /** The WebSocket/HTTP bind resolves to a loopback address. */
  loopbackBind: boolean;
  /** In-world command limiter bypassed (`RateLimiter.bypass`, set under `local`). */
  commandLimiterBypassed: boolean;
  /** Named HTTP limiters (`HTTP_RATE_LIMITS`) currently enforced. */
  limiters: OpsLimiter[];
};

export type OpsOverview = {
  generatedAt: number;
  /** `privileged` = every agent; `resident` = only the caller's own agents. */
  scope: "privileged" | "resident";
  agents: AgentOperatorRow[];
  spend: OpsSpend;
  retention: OpsRetention;
  prompt: OpsPrompt;
  /** Last provider probe; null when never run OR for a resident scope. */
  providers: ProviderProbeSummary[] | null;
  security: OpsSecurity;
};

/** `POST /api/ops/agents/:name/stop` response. */
export type OpsAgentStopResponse = {
  stopped: string;
  /** Children cascaded (recursively, children-first) — excludes `stopped` itself. */
  stoppedChildren: string[];
};
