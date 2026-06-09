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
 *  model, and the fallback when a requested model isn't recognized. Override to
 *  match the provider you actually hold a key for. */
export const MARINA_DEFAULT_MODEL = process.env.MARINA_DEFAULT_MODEL ?? "google/gemini-2.0-flash";

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
// See docs/conductor-design.md, Phase 2. These bound agent-initiated spawning
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
