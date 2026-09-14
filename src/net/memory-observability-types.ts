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
  surface: string;
  tiers: { tier: string; count: number; bytes: number }[];
  usedBytes: number;
  budgetBytes: number;
  truncated: boolean;
  cacheHit: boolean;
  at: number;
};

export type MemoryOverview = {
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
  spaces: { institutional: { id: string; name: string; records: number; ratified: number }[] };
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
