// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard view of the memory-observability contract served by
 * `GET /api/memory/overview`, `GET /api/memory/jobs*`,
 * `GET /api/memory/hygiene/history`, `POST /api/memory/hygiene/snapshot` and
 * the `memory_job` / `memory_service_event` WebSocket events.
 *
 * The wire contract is NOT mirrored here — it is re-exported (type-only) from
 * the backend's single source of truth, `src/net/memory-observability-types.ts`,
 * so a field added or renamed on the server is the same field here, with no
 * copy to drift. `export type … from` is erased by Vite (`isolatedModules`) and
 * the backend file is dependency-free, so the dashboard bundle and its
 * `tsc --noEmit` pass never pull in anything else from `src/`.
 *
 * What IS declared locally is dashboard-only: the named aliases the components
 * key on (derived by indexed access, so they follow the contract), the WebSocket
 * envelopes, the `/api/memory/jobs` page, and the trace-span receipt attribute.
 * `src/__tests__/memory-observability-contract.test.ts` pins these to the
 * backend shapes.
 */

export type {
  MemoryCreditView,
  MemoryHygieneHistory,
  MemoryHygieneRatios,
  MemoryHygieneSample,
  MemoryJobView,
  MemoryOverview,
  MemoryRatificationView,
  MemoryRatio,
  MemoryReceiptView,
  MemoryResolutionView,
  MemorySpaceHealth,
  MemoryStorageBudgetView,
} from "../../../src/net/memory-observability-types";

import type { MemoryJobView, MemoryReceiptView } from "../../../src/net/memory-observability-types";

// ── Named aliases (derived — never restate the union) ───────────────────────

export type MemoryJobState = MemoryJobView["state"];
export type MemoryJobRole = MemoryJobView["role"];
/** The three dispatch markers; `MemoryJobView.marker` itself is `MemoryJobMarker | null | undefined`. */
export type MemoryJobMarker = NonNullable<MemoryJobView["marker"]>;
/** Passthru protocol a receipt was minted on — `unknown` renders as "—". */
export type MemoryReceiptSurface = MemoryReceiptView["surface"];

// ── Dashboard-only envelopes ────────────────────────────────────────────────

/** `GET /api/memory/jobs` page (`listJobs` in src/net/memory-observability.ts). */
export type MemoryJobsResponse = { jobs: MemoryJobView[]; nextCursor?: string | null };

/**
 * `{ type: "memory_job" }` WebSocket event payload. The backend strips
 * `task` / `answer` / `citations` before broadcasting (all three are optional
 * on `MemoryJobView`, so the full view type is the honest superset here).
 */
export type MemoryJobEvent = { type: "memory_job"; job: MemoryJobView; timestamp: number };

/** `{ type: "memory_service_event" }` WebSocket event payload (mirrors the `EngineEvent` member in src/types.ts). */
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
 * `attributes.memoryReceipt` (JSON string) — the backend's `MemoryReceipt`
 * from `src/net/memory-receipt.ts`, re-exported under the attribute's name.
 *
 * Sibling string attributes on the same span: `memoryCacheHit` ("true" | "false")
 * and `memorySurface` (a `MemoryReceiptSurface`).
 */
export type { MemoryReceipt as MemoryReceiptAttribute } from "../../../src/net/memory-receipt";
