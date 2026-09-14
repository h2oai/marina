// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard mirror of the memory-observability contract served by
 * `GET /api/memory/overview`, `GET /api/memory/jobs*`, and the
 * `memory_job` / `memory_service_event` WebSocket events.
 *
 * Keep this file in lockstep with the backend contract — it is a mirror,
 * not a place for dashboard-only fields.
 */

export type MemoryJobState = "pending" | "running" | "answered" | "abstained" | "cancelled";
export type MemoryJobRole = "librarian" | "reflector" | "evaluator";
export type MemoryJobMarker = "hygiene" | "accumulation" | "shared-write-review";

export type MemoryJobView = {
  id: string;
  state: MemoryJobState;
  workOpen: boolean;
  role: MemoryJobRole;
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
  marker?: MemoryJobMarker | null;
  task?: string;
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
  rationale?: string;
};

export type MemoryRatificationView = {
  recordId: string;
  spaceId: string;
  spaceName: string;
  ratifiedBy: { name: string; standing: number; basis: string };
  at: number;
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
  spaces: {
    institutional: { id: string; name: string; records: number; ratified: number }[];
  };
};

export type MemoryJobsResponse = { jobs: MemoryJobView[]; nextCursor?: string | null };

/** `{ type: "memory_job" }` WebSocket event payload. */
export type MemoryJobEvent = { type: "memory_job"; job: MemoryJobView; timestamp: number };

/** `{ type: "memory_service_event" }` WebSocket event payload. */
export type MemoryServiceEvent = {
  type: "memory_service_event";
  kind: string;
  spaceId: string;
  spaceName?: string;
  ownerName?: string;
  referenceId?: string;
  version?: number;
  actorName?: string;
  seq: number;
  timestamp: number;
};

/**
 * The `marina.memory.receipt.v1` payload as it rides a trace span's
 * `attributes.memoryReceipt` (JSON string). Mirrors `src/net/memory-receipt.ts`.
 */
export type MemoryReceiptAttribute = {
  schema: "marina.memory.receipt.v1";
  requestId: string;
  entity: string;
  tiers: { tier: string; ids: { id: string; version?: number; hash?: string }[]; bytes: number }[];
  budgetBytes: number;
  usedBytes: number;
  truncated: boolean;
  degraded: string[];
};
