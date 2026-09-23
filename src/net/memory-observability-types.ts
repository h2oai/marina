// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared JSON contract for the memory observability surface.
 *
 * Consumed by the dashboard (`dashboard/src/**`) and the canvas layer; served
 * by `src/net/memory-observability.ts` through `/api/memory/overview`,
 * `/api/memory/jobs[/:id]`, `/api/memory/graph` and the two WebSocket events
 * `memory_job` / `memory_service_event`. Keep this file dependency-free: it is
 * imported by `src/types.ts` (type-only) and mirrored on the frontend.
 *
 * Privacy contract: every view carries ids, names, states and counts. Note or
 * record CONTENT (`task`, `answer`, `rationale`, `preview`) is present only
 * when the server decided the principal may read it — a job's `task`/`answer`
 * for its requester, its worker or an operator; a `preview` only for records
 * in institutional (public-read) spaces.
 */

export type MemoryJobView = {
  id: string;
  state: "pending" | "running" | "answered" | "abstained" | "cancelled";
  workOpen: boolean;
  role: "librarian" | "reflector" | "evaluator";
  workerName: string;
  requesterName: string;
  spaceId: string;
  spaceName?: string;
  rootId: string;
  parentId: string | null;
  depth: number;
  remainingOperations: number;
  deadline: number;
  createdAt: number;
  marker?: "hygiene" | "accumulation" | "shared-write-review" | null;
  /** Only when visible (requester, worker, operator). */
  task?: string;
  /** Only when visible; ≤ 2 KB. */
  answer?: string;
  citations?: number;
  adopted?: { recordId: string; spaceId: string; at: number } | null;
};

export type MemoryResolutionView = {
  id: string;
  policy: string;
  spaceId: string;
  spaceName?: string;
  actorName: string;
  at: number;
  winnerId: string | null;
  loserIds: string[];
  /** Visible only to the space owner / an operator. */
  rationale?: string;
};

export type MemoryRatificationView = {
  recordId: string;
  spaceId: string;
  spaceName: string;
  ratifiedBy: { name: string; standing: number; basis: string };
  at: number;
  /** ≤ 160 chars; institutional spaces are public-read so a preview is fine. */
  preview?: string;
};

export type MemoryCreditView = {
  kind: string;
  entityName: string;
  amount: number;
  ref: string;
  at: number;
};

export type MemoryReceiptView = {
  requestId: string;
  entity: string;
  /** The PROTOCOL surface the request arrived on (the `applyInjection` format), not the route kind. */
  surface: "openai" | "anthropic" | "ollama-generate" | "responses" | "unknown";
  tiers: { tier: string; count: number; bytes: number }[];
  usedBytes: number;
  budgetBytes: number;
  truncated: boolean;
  cacheHit: boolean;
  at: number;
};

/**
 * One continuous-hygiene ratio. `value` is `numerator / denominator`, or
 * `null` when the denominator is zero (the UI shows "n/a", never 0%). Most
 * ratios are 0..1; `consolidationRoi` is an average (inputs per adopted
 * lesson) and may exceed 1.
 */
export type MemoryRatio = { value: number | null; numerator: number; denominator: number };
/** Storage usage against the admission budget for one durable owner. `null` limit = unlimited. */
export type MemoryStorageBudgetView = {
  ownerName: string;
  logicalBytes: number;
  maxBytes: number | null;
  sources: number;
  maxSources: number | null;
  revisions: number;
  maxRevisions: number | null;
  spaces: number;
  maxSpaces: number | null;
  /** logicalBytes / maxBytes, or null when unlimited. */
  utilization: number | null;
  overLimit: string[];
};
/**
 * The continuous-hygiene dashboard (design §7 "published beside any headline
 * number"). Computed on demand from both silos for the observer's scope
 * (`scope: "all"` for operators, `"own"` for a resident) over `windowMs`
 * (24 h) where a window applies; structural ratios (redundancy, provenance,
 * staleness, contradictions) are over the current live state. Every ratio
 * carries its numerator/denominator so the number is inspectable.
 */
export type MemoryHygieneRatios = {
  computedAt: number;
  windowMs: number;
  scope: "all" | "own";
  /** Exact-content duplicates (case-folded, trimmed) across fact-like legacy notes and active records: (group size − 1) summed / notes+records. */
  redundancy: MemoryRatio;
  /** Records in a contradiction now or settled by a resolution in the window / active records that carry a claim. */
  contradictionRate: MemoryRatio;
  /** Competing now / (competing now + records settled by applied resolutions in the window). */
  unresolvedContradictionRate: MemoryRatio;
  /** Records with ≥ 1 non-twin source + legacy notes with ≥ 1 non-twin `note_sources` row / all of them. */
  provenanceCoverage: MemoryRatio;
  /** `stale = 1` records / active records. */
  stalenessRatio: MemoryRatio;
  /** Injected responses (window) that served a record already superseded, forgotten, past `valid_until`, or below its then-current version / injected responses citing ≥ 1 record. */
  unsafeServedRate: MemoryRatio;
  /** Reflection-tier notes written in the window that repeat an earlier reflection of the same entity (same case-folded content) / reflections in the window. */
  reflectionRepetitionRate: MemoryRatio;
  /** Inputs (dependencies + non-twin sources) per adopted reflector lesson in the window — an average, not a share. */
  consolidationRoi: MemoryRatio;
  /** Hygiene / shared-write-review evaluator jobs (window) that were answered AND followed by an adoption or a resolution in their space / such jobs that reached a final state. */
  repairSuccess: MemoryRatio;
  leakage: {
    /** Cross-scope reads/cancels refused by the observability layer since process start (a non-owner asked for another principal's job). */
    crossScopeAttempts: number;
    /** Always 0 — the response-cache key hashes the post-injection request, so a hit cannot cross identities. Reported so the gate is visible. */
    crossScopeCacheHits: number;
  };
  storage: MemoryStorageBudgetView[];
  cost: {
    /** Injected responses in the window. */
    receipts: number;
    avgInjectedBytes: number | null;
    cacheHitRate: MemoryRatio;
  };
};

/** One hourly (or on-demand) snapshot of the operator-scope hygiene ratios. */
export type MemoryHygieneSample = { at: number; ratios: MemoryHygieneRatios };
/**
 * `GET /api/memory/hygiene/history?hours=168` (default 168, max 720); privileged
 * only (403 otherwise); samples oldest → newest. Written by the hourly hygiene
 * tick and `POST /api/memory/hygiene/snapshot`; retained 30 days.
 */
export type MemoryHygieneHistory = { scope: "all"; hours: number; samples: MemoryHygieneSample[] };
/**
 * Health of one SHARED durable space — every institutional space plus any
 * space with ≥ 2 distinct writers (authors of `memory.created` / `memory.revised`
 * events) or ≥ 1 grant. Same predicates as the global ratios
 * (`COMPETING_RECORD_PREDICATE`; a "fresh" writer is one below
 * `SYBIL_STANDING_FLOOR` standing). Residents see only spaces they own or are
 * granted; operators see all, max 50, ordered by `competing` desc then
 * `records` desc.
 */
export type MemorySpaceHealth = {
  id: string;
  name: string;
  institutional: boolean;
  ownerName: string;
  records: number;
  ratified: number;
  writers: number;
  freshWriters: number;
  freshWriterShare: MemoryRatio;
  competing: number;
  resolutions24h: number;
  unresolvedContradictionRate: MemoryRatio;
  lastWriteAt: number | null;
};

export type MemoryOverview = {
  ratios: MemoryHygieneRatios;
  trust: { profile: string; ungated: boolean; autonomy: string };
  hygiene: { entityName: string; line: string; at: number }[];
  jobs: {
    open: number;
    answered24h: number;
    abstained24h: number;
    cancelled24h: number;
    byMarker: Record<string, number>;
  };
  resolutions: MemoryResolutionView[];
  ratifications: MemoryRatificationView[];
  credits: MemoryCreditView[];
  receipts: {
    recent: MemoryReceiptView[];
    cache: { hits: number; misses: number; stores: number };
  };
  dispatch: { accumulationJobs24h: number; sharedWriteJobs24h: number; hygieneJobs24h: number };
  spaces: {
    institutional: { id: string; name: string; records: number; ratified: number }[];
    /** Per-space health for shared spaces (see `MemorySpaceHealth`). */
    shared: MemorySpaceHealth[];
  };
};

export type MemoryGraphNode = {
  /** `note:<id>`, `record:<id>`, `job:<id>`, `proposal:<recordId>`, `resolution:<id>`, `space:<id>`, `helper:<name>`. */
  id: string;
  kind: "note" | "record" | "job" | "proposal" | "resolution" | "space" | "helper";
  label: string;
  entityName?: string;
  spaceId?: string;
  state?: string;
  tier?: string;
  policy?: string;
  role?: string;
  institutional?: boolean;
  at?: number;
  meta?: Record<string, string | number | boolean | null>;
};

export type MemoryGraphEdge = {
  id: string;
  source: string;
  target: string;
  relationship:
    | "twin"
    | "cites"
    | "derived_from"
    | "resolves"
    | "superseded_by"
    | "in_space"
    | "worker"
    | "requester"
    | "adopted_as"
    | "related_to"
    | "part_of"
    | "supersedes"
    | "contradicts";
};

export type MemoryGraph = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  truncated: boolean;
};
