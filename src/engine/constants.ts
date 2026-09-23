// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Engine Constants ─────────────────────────────────────────────────────────
//
// Named constants replacing magic numbers scattered across the codebase.

// ─── Tick Maintenance Intervals ──────────────────────────────────────────────
// Values are in ticks (default 1 tick = 1 second)

/** Board auto-archive runs every 3600 ticks (hourly) */
export const BOARD_ARCHIVE_INTERVAL = 3600;

/** Board posts older than this many days are archived */
export const BOARD_ARCHIVE_AGE_DAYS = 30;

/** Channel message pruning runs every 1800 ticks (30 min) */
export const CHANNEL_PRUNE_INTERVAL = 1800;

/** Stale conversation cleanup runs every 3600 ticks (hourly) */
export const CONVERSATION_CLEANUP_INTERVAL = 3600;

/** Note importance adjustment runs every 3600 ticks (hourly) */
export const NOTE_IMPORTANCE_INTERVAL = 3600;

/** Orphaned agent cleanup runs every 60 ticks */
export const AGENT_CLEANUP_INTERVAL = 60;

// ─── Command Queue Limits ────────────────────────────────────────────────────

/** Max commands processed per tick */
export const MAX_COMMANDS_PER_TICK = 1000;

/** Max commands queued before dropping (DoS prevention) */
export const MAX_COMMAND_QUEUE_SIZE = 5000;

// ─── Event Log ───────────────────────────────────────────────────────────────

/** Max in-memory events before trimming */
export const MAX_EVENT_LOG = 10_000;

/**
 * Durable event_log row retention (pruned hourly on the engine tick). Sized
 * well above the 5,000-row trace-projection window so pruning never truncates
 * a trace a consumer can still request. Override: MARINA_EVENT_RETENTION.
 */
export const EVENT_LOG_DB_RETENTION = Math.max(
  10_000,
  Math.min(Number(process.env.MARINA_EVENT_RETENTION) || 100_000, 10_000_000),
);

/** Trim to this size when over MAX_EVENT_LOG */
export const EVENT_LOG_TRIM_SIZE = 5_000;

// ─── Room HTTP Fetch ─────────────────────────────────────────────────────────

/** Rate limit for room HTTP fetch (ms between requests per room) */
export const ROOM_FETCH_RATE_MS = 10_000;

/** Timeout for room HTTP fetch requests (ms) */
export const ROOM_FETCH_TIMEOUT_MS = 5_000;

// ─── Connector Rate Limits & Timeouts ────────────────────────────────────────

/** Rate limit for MCP tool calls (ms between calls per entity) */
export const CONNECTOR_TOOL_RATE_MS = 2_000;

/** Rate limit for HTTP GET/POST via connectors (ms between calls per entity) */
export const CONNECTOR_HTTP_RATE_MS = 5_000;

/** Timeout for connector HTTP requests (ms) */
export const CONNECTOR_HTTP_TIMEOUT_MS = 10_000;

/** Max response body size from connector HTTP (bytes) — 200KB for readability extraction */
export const CONNECTOR_MAX_BODY_BYTES = 204_800;

// ─── Note Decay Thresholds ───────────────────────────────────────────────────

/** Orphan notes (0-2 links) decay after this many days */
export const NOTE_ORPHAN_DECAY_DAYS = 7;

/** Well-linked notes (3+ links) decay after this many days */
export const NOTE_LINKED_DECAY_DAYS = 14;

/** Minimum link count to be considered "well-linked" */
export const NOTE_WELL_LINKED_THRESHOLD = 3;

// ─── Recall Scoring Defaults ─────────────────────────────────────────────────

export const DEFAULT_WEIGHT_IMPORTANCE = 0.33;
export const DEFAULT_WEIGHT_RECENCY = 0.33;
export const DEFAULT_WEIGHT_RELEVANCE = 0.34;

/** Min relevance score for similar note matching */
export const SIMILAR_NOTE_RELEVANCE_THRESHOLD = 0.5;

// ─── Memory Tiers ────────────────────────────────────────────────────────────
//
// Enforced tier column on notes (migration 37). Recall defaults to the
// FACT-LIKE set below; 'process' is returned only when explicitly requested.
// See migration 37 in database.ts for the architectural rationale.

export type NoteTier = "fact" | "reflection" | "skill" | "core" | "process";

/** Tiers returned by default recall. Process notes (transient agent-process
 *  metadata like [compaction] summaries) are excluded. */
export const FACT_LIKE_TIERS: readonly NoteTier[] = ["fact", "reflection", "skill", "core"];

/** Per-entity cap on process-tier notes. On insert-over-cap, the oldest
 *  lowest-importance process notes are evicted. Bounded growth invariant. */
export const PROCESS_TIER_QUOTA = 500;

// ─── WebSocket/Network ───────────────────────────────────────────────────────

/** Bun.serve idleTimeout (seconds). Applies to BOTH WebSocket and HTTP
 *  keepalive. Bun caps this at 255s — anything above throws at boot
 *  (`Bun.serve expects idleTimeout to be 255 or less`). For long-running
 *  benchmark dispatch the harness must keep the connection live by
 *  streaming or chunked progress; HTTP requests that idle more than
 *  255s WILL be closed regardless of MODEL_REQUEST_TIMEOUT_MS. */
export const WS_IDLE_TIMEOUT_SECONDS = 255;

/** Max WebSocket connections per IP address (env-overridable for multi-agent
 *  benchmark setups where 10+ providers run on localhost) */
export const WS_MAX_CONNECTIONS_PER_IP = Number.parseInt(
  process.env.WS_MAX_CONNECTIONS_PER_IP ?? "100",
  10,
);

/** Max total WebSocket connections (all types combined) */
export const WS_MAX_TOTAL_CONNECTIONS = 1000;

/** Instance-wide concurrent login cap (total entity-bound connections).
 *  0 (or unset) = unlimited. Internal room/crew agents are exempt and don't
 *  consume slots — they're capped separately by MAX_AGENTS. */
export const MARINA_MAX_LOGINS = Number.parseInt(process.env.MARINA_MAX_LOGINS ?? "0", 10);

/** Login/reconnect attempts allowed per minute, keyed per client IP (falls
 *  back to connection id when IP is unavailable, e.g. MCP sessions).
 *  0 = disabled. */
export const MARINA_LOGIN_ATTEMPTS_PER_MIN = Number.parseInt(
  process.env.MARINA_LOGIN_ATTEMPTS_PER_MIN ?? "10",
  10,
);

// ─── Agent Model Defaults ─────────────────────────────────────────────────────

/** Default model ("provider/model-id") for agents spawned without an explicit
 *  model, and the fallback when a requested model isn't recognized.
 *
 *  The default is the self-referential Marina loopback: agents call this
 *  instance's own OpenAI-compatible `/v1` endpoint (authenticated with the
 *  auto-generated internal token), and the proxy fan-out picks the first
 *  upstream provider that actually has a key (env or Admin → Keys). This makes
 *  `agent spawn <name>` work with whichever provider the operator configured
 *  instead of failing on a hardcoded provider they hold no key for. Override
 *  with a concrete "provider/model-id" to pin every default-model agent. */
export const MARINA_DEFAULT_MODEL = process.env.MARINA_DEFAULT_MODEL ?? "marina/default";

/** Fraction of a local model's context window reserved for the completion.
 *  Default 1/4 (was 1/2 until 2026-09-22): the compactor (`context-manager.ts`)
 *  reserves `model.maxTokens` out of the window before budgeting the prompt, so
 *  at 1/2 a 16k local model kept only 8k for input — not enough for the fixed
 *  prefix (system prompt + tool schemas) plus any history. A quarter still
 *  leaves a reasoning model (Qwen3) 4k tokens of `<think>` + tool call on a
 *  16k window and grows with the configured window. Clamped to (0, 0.5] — the
 *  compactor never reserves more than half. Override with
 *  MARINA_LOCAL_OUTPUT_FRACTION. */
export const LOCAL_OUTPUT_BUDGET_FRACTION = (() => {
  const raw = Number.parseFloat(process.env.MARINA_LOCAL_OUTPUT_FRACTION ?? "");
  return Number.isFinite(raw) && raw > 0 && raw <= 0.5 ? raw : 0.25;
})();

/** Completion cap for the `marina/default` self-proxy model (and any other
 *  cloud-routed model without a registry entry). The proxy enforces the real
 *  local-upstream budget in `prepareLlamaBody`, so the agent-side value only
 *  needs to be an honest output reservation for the compactor — NOT a fraction
 *  of a 128k window (that reserved 64k of a cloud window for output and left
 *  agents an effective 64k prompt). Override with MARINA_DEFAULT_MAX_TOKENS. */
export const DEFAULT_CLOUD_MAX_TOKENS = (() => {
  const raw = Number.parseInt(process.env.MARINA_DEFAULT_MAX_TOKENS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4096;
})();

/** Optional hard cap (tokens) on the local-model completion budget. Unset by
 *  default, so the budget is purely the context-window fraction above. Set it
 *  to bound output on a shared or cost-sensitive box. */
export const LOCAL_MAX_OUTPUT_TOKENS_CAP = (() => {
  const raw = Number.parseInt(process.env.MARINA_LOCAL_MAX_OUTPUT_TOKENS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : Number.POSITIVE_INFINITY;
})();

/** Completion-token budget for a self-hosted local model (llama.cpp / Ollama),
 *  and the `marina/default` self-proxy when it routes to one. Half the context
 *  window by default (see LOCAL_OUTPUT_BUDGET_FRACTION), floored at 512 and
 *  bounded by the optional hard cap. Reasoning models (e.g. Qwen3) spend output
 *  tokens on `<think>` before the tool call, so too small a budget truncates
 *  mid-reasoning and the agent returns no action ("connected but nothing
 *  happens"). NOTE: this scales with the *configured* context window — set
 *  LLAMA_CONTEXT_WINDOW to your server's real size (e.g. 262144) or the
 *  conservative 16384 default keeps the budget small. */
export function localOutputBudget(contextWindow: number): number {
  const fraction = Math.floor(contextWindow * LOCAL_OUTPUT_BUDGET_FRACTION);
  return Math.max(512, Math.min(LOCAL_MAX_OUTPUT_TOKENS_CAP, fraction));
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

/** Dashboard state broadcast interval (ms) */
export const DASHBOARD_BROADCAST_INTERVAL_MS = 2_000;

// ─── Time Constants ──────────────────────────────────────────────────────────

/** Milliseconds in one day (86,400,000) */
export const DAY_MS = 86_400_000;

/** Milliseconds in one hour (3,600,000) */
export const HOUR_MS = 3_600_000;

// ─── Database Query Defaults ─────────────────────────────────────────────────

export const DEFAULT_NOTE_IMPORTANCE = 5;

// ─── Agent Spawn Policy (emergent-organization guardrails) ───────────────────
// See the conductor design (private archive: marina-internal design/conductor-design.md), Phase 2. These bound agent-initiated spawning
// so emergence can't become a fork bomb; they do not apply to operators who
// hold the agent.spawn gate by grant rather than by standing.

/**
 * Standing required per concurrent child an agent may keep alive. Budget =
 * floor(standing / this). Reputation sizes the team: standing 40 → 1 child,
 * 100 → 4, 250 → 10. Clamped by the global MAX_AGENTS cap.
 */
export const STANDING_PER_SPAWNED_CHILD = 25;

/**
 * Standing (rank 2, "contributor") required to recruit idle agents into a
 * crew. Deliberately lower than the agent.spawn gate (40): pulling in an
 * existing, idle, free-to-leave agent is lighter and more reversible than
 * spawning a new mind, so the bar is lower. Operators (rank ≥ 2 by explicit
 * grant) pass on rank alone.
 */
export const RECRUIT_MIN_STANDING = 15;

/**
 * Maximum lineage depth for agent-spawned agents. An agent at or beyond this
 * depth may not spawn further, capping recursive team-building (lead →
 * sub-lead → specialist). Operators/humans sit at depth 0 (not in the
 * spawned_by chain) and are unaffected.
 */
export const MAX_SPAWN_DEPTH = 3;

// ─── Agent Spend Ceiling & Upstream-Error Guards ─────────────────────────────
// Rolling-window cost caps and the consecutive-failure circuit breaker for the
// autonomous agent loop (src/agent/lean-agent-adapter.ts). Env parsing lives
// here so the adapter, runtime and tests read one definition.

/** Rolling window over which agent spend is summed for the cost caps (1 hour). */
export const SPEND_WINDOW_MS = HOUR_MS;

/** How often a loop paused on a spend cap re-checks the rolling window (ms). */
export const SPEND_CAP_POLL_MS = 30_000;

/** Parse a positive finite number from `env[name]`; unset / 0 / invalid ⇒ undefined. */
export function positiveNumberFromEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Base delay of the exponential backoff after an upstream LLM error (ms). */
export const UPSTREAM_ERROR_BACKOFF_BASE_MS = 5_000;

/** Ceiling of the per-attempt backoff after an upstream LLM error (ms). */
export const UPSTREAM_ERROR_BACKOFF_CAP_MS = 30_000;

/**
 * Backoff before retrying after the `attempt`-th consecutive upstream error:
 * 5 s, 10 s, 20 s, then capped at 30 s. Attempt counts from 1.
 */
export function upstreamErrorBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(UPSTREAM_ERROR_BACKOFF_CAP_MS, UPSTREAM_ERROR_BACKOFF_BASE_MS * 2 ** (n - 1));
}

/**
 * Consecutive upstream/loop errors that trip the circuit breaker: the loop
 * pauses for UPSTREAM_ERROR_PAUSE_MS, tells its spawner once, then resumes
 * with the counter reset. Override: MARINA_MAX_CONSECUTIVE_UPSTREAM_ERRORS.
 */
export function maxConsecutiveUpstreamErrorsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = positiveNumberFromEnv("MARINA_MAX_CONSECUTIVE_UPSTREAM_ERRORS", env);
  return n === undefined ? 20 : Math.max(1, Math.floor(n));
}
export const MAX_CONSECUTIVE_UPSTREAM_ERRORS = maxConsecutiveUpstreamErrorsFromEnv();

/** Pause length after the consecutive-error breaker trips (default 10 min).
 *  Override: MARINA_UPSTREAM_ERROR_PAUSE_MS. */
export function upstreamErrorPauseMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumberFromEnv("MARINA_UPSTREAM_ERROR_PAUSE_MS", env) ?? 10 * 60 * 1000;
}
export const UPSTREAM_ERROR_PAUSE_MS = upstreamErrorPauseMsFromEnv();

// ─── Agent Prompt Budget ─────────────────────────────────────────────────────

/** Byte ceiling for the assembled continuation prompt (the per-cycle dynamic
 *  context). Sections are added in priority order and the lowest-priority
 *  ones that would overflow are deferred with a `[+N sections deferred]` note.
 *  Override: MARINA_CONTINUATION_BUDGET_BYTES. */
export const CONTINUATION_PROMPT_BUDGET_BYTES = (() => {
  const n = positiveNumberFromEnv("MARINA_CONTINUATION_BUDGET_BYTES");
  return n === undefined ? 6000 : Math.max(1000, Math.floor(n));
})();

/** Max characters of one World Events perception line in the continuation
 *  prompt (room chatter, movement, channel posts). */
export const PERCEPTION_LINE_MAX_CHARS = 400;

/** Max characters of a `model_request` perception line. Larger than the
 *  general clamp because the payload's `content` IS the caller's question — a
 *  400-char cut would make endpoint answers unanswerable. Override:
 *  MARINA_PERCEPTION_MODEL_REQUEST_MAX_CHARS. */
export const PERCEPTION_MODEL_REQUEST_MAX_CHARS = (() => {
  const n = positiveNumberFromEnv("MARINA_PERCEPTION_MODEL_REQUEST_MAX_CHARS");
  return n === undefined ? 2000 : Math.max(PERCEPTION_LINE_MAX_CHARS, Math.floor(n));
})();

/** Max characters of the restated [Active Coding Task] section. */
export const ACTIVE_CODING_TASK_MAX_CHARS = 800;

/** Turns (model calls) one `agent.prompt()` may take before the loop yields
 *  to the next cycle; complements the tool-call run cap. Override:
 *  MARINA_MAX_TURNS_PER_PROMPT. */
export const MAX_TURNS_PER_PROMPT = (() => {
  const n = positiveNumberFromEnv("MARINA_MAX_TURNS_PER_PROMPT");
  return n === undefined ? 24 : Math.max(1, Math.floor(n));
})();

/** Provider-level retries pi-ai performs inside one request (transient 5xx /
 *  429 with a short retry-after) before Marina's loop-level backoff sees the
 *  error. Override: MARINA_PROVIDER_MAX_RETRIES (0 disables). */
export const PROVIDER_MAX_RETRIES = (() => {
  const raw = process.env.MARINA_PROVIDER_MAX_RETRIES;
  if (raw === undefined || raw.trim() === "") return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
})();

/** Context usage ratio (of the effective prompt window) at which the context
 *  manager compacts. Shared by the per-request transform and the mid-run
 *  `prepareNextTurn` gauge so both fire on the same threshold. */
export const CONTEXT_PRUNE_THRESHOLD = 0.8;
/** Usage ratio compaction targets once it fires. */
export const CONTEXT_PRUNE_TARGET = 0.6;

// ─── Memory helpers and perception hygiene (2026-09-22, agent track 2) ───────

/** Role name of the resident memory helper `reflect` delegates to. Shared by the
 *  `reflect` command (spawn / discovery) and the runtime's idle stop so both
 *  agree on which agents are bounded errands rather than residents. */
export const MEMORY_REFLECTOR_ROLE = "memory-reflector";

/** Default idle window after which a memory-reflector with no assigned job is stopped. */
export const REFLECTOR_IDLE_STOP_MS = 10 * 60 * 1000;

/** Idle window for memory-reflector helpers: a reflector that has had no
 *  assistance job created for it and holds no open one for this long is
 *  stopped by the runtime (the next `reflect` re-spawns one on demand).
 *  Override: MARINA_REFLECTOR_IDLE_STOP_MS (milliseconds; 0 disables).
 *  Read per check (not at module load) so operators — and tests — can change
 *  it without a restart. */
export function reflectorIdleStopMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_REFLECTOR_IDLE_STOP_MS;
  if (raw === undefined || raw.trim() === "") return REFLECTOR_IDLE_STOP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : REFLECTOR_IDLE_STOP_MS;
}

/** `MARINA_PERCEIVE_SELF_ECHO=on` restores the pre-2026-09-22 behaviour in
 *  which an agent's own command echoes (memory-service acknowledgements for
 *  its continuity journal, `You tell …` receipts) entered `[World Events]`.
 *  Off by default: those perceptions carry nothing the agent did not just do. */
export function perceiveSelfEcho(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MARINA_PERCEIVE_SELF_ECHO ?? "").trim().toLowerCase();
  return raw === "on" || raw === "true" || raw === "1";
}
