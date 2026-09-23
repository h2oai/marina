// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * memory-map-types -- The unified canvas's view of the memory-graph contract
 * served by `GET /api/memory/graph?entity=<name>&limit=400`, plus the visual
 * vocabulary (state colors, unified tier colors, relationship styles) the
 * MEMORY layer renders from.
 *
 * The wire contract (`MemoryGraph`, `MemoryGraphNode`, `MemoryGraphEdge`) is
 * re-exported type-only from the backend's single source,
 * `src/net/memory-observability-types.ts` — Vite erases the import and the
 * backend file is dependency-free. The `…Kind` / `…Relationship` unions are
 * derived from it by indexed access, so they cannot drift.
 *
 * This file still deliberately does NOT import the components/ module
 * (`dashboard/src/lib/memory-observability-types.ts`): the two halves of the
 * dashboard share the backend contract, not each other.
 *
 * The live WebSocket payload types below are intentionally LOOSE (`| string`,
 * every job field optional): the reducer tolerates partial frames. The one
 * structured field, `adopted`, is typed from `MemoryJobView` so the live
 * frame and the REST view cannot disagree on its shape. See
 * `src/__tests__/memory-observability-contract.test.ts` for what is pinned.
 */

import type {
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryJobView,
} from "../../../../src/net/memory-observability-types";

// ── Wire contract (single-sourced from the backend) ─────────────────────────

export type {
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
} from "../../../../src/net/memory-observability-types";

export type MemoryGraphNodeKind = MemoryGraphNode["kind"];

export type MemoryGraphRelationship = MemoryGraphEdge["relationship"];

export const EMPTY_MEMORY_GRAPH: MemoryGraph = { nodes: [], edges: [], truncated: false };

// ── Live WebSocket payloads ─────────────────────────────────────────────────

export type MemoryJobState = MemoryJobView["state"];

export type MemoryJobMarker = NonNullable<MemoryJobView["marker"]>;

/** `{ type: "memory_job", job, timestamp }` on the dashboard WebSocket. */
export type MemoryJobEvent = {
  type: "memory_job";
  job: {
    id: string;
    state: MemoryJobState | string;
    workOpen?: boolean;
    role?: string;
    workerName?: string;
    requesterName?: string;
    spaceId?: string;
    rootId?: string;
    parentId?: string;
    depth?: number;
    remainingOperations?: number;
    deadline?: number;
    createdAt?: number;
    marker?: string;
    /** Same shape as the REST view: `{ recordId, spaceId, at }` once adopted, else null/absent. */
    adopted?: MemoryJobView["adopted"];
  };
  timestamp: number;
};

export type MemoryServiceEventKind =
  | "memory.created"
  | "memory.revised"
  | "memory.resolved"
  | "assistance.created"
  | "assistance.adopted"
  | "source.captured";

/** `{ type: "memory_service_event", kind, ... }` on the dashboard WebSocket. */
export type MemoryServiceEvent = {
  type: "memory_service_event";
  kind: MemoryServiceEventKind | string;
  spaceId?: string;
  spaceName?: string;
  ownerName?: string;
  referenceId?: string;
  version?: number;
  actorName?: string;
  seq?: number;
  timestamp: number;
};

export type MemoryLiveEvent = MemoryJobEvent | MemoryServiceEvent;

/** Service-event kinds that change graph shape and warrant a (debounced) refetch. */
export const MEMORY_REFETCH_KINDS: ReadonlySet<string> = new Set([
  "memory.resolved",
  "assistance.adopted",
  "memory.created",
]);

/** Minimum spacing between graph refetches triggered by service events. */
export const MEMORY_REFETCH_DEBOUNCE_MS = 2000;

/** Default node budget requested from the backend. */
export const MEMORY_GRAPH_LIMIT = 400;

// ── Id helpers ──────────────────────────────────────────────────────────────

/** Split a prefixed memory node id into `{ kind, ref }`. Returns null when unprefixed. */
export function parseMemoryNodeId(id: string): { kind: MemoryGraphNodeKind; ref: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon) as MemoryGraphNodeKind;
  if (!MEMORY_NODE_KINDS.has(kind)) return null;
  return { kind, ref: id.slice(colon + 1) };
}

export const MEMORY_NODE_KINDS: ReadonlySet<string> = new Set<MemoryGraphNodeKind>([
  "note",
  "record",
  "job",
  "proposal",
  "resolution",
  "space",
  "helper",
]);

/** ReactFlow node id for a memory-graph node. Legacy notes reuse the GRAPH layer's `note-<id>`. */
export function memoryFlowNodeId(nodeId: string): string {
  const parsed = parseMemoryNodeId(nodeId);
  if (parsed?.kind === "note") return `note-${parsed.ref}`;
  return `mem-${nodeId}`;
}

/** Inverse of `memoryFlowNodeId` for `mem-*` ids; null for anything else. */
export function memoryNodeIdFromFlowId(flowId: string): string | null {
  return flowId.startsWith("mem-") ? flowId.slice(4) : null;
}

// ── Visual vocabulary ───────────────────────────────────────────────────────

/** Job ring colors by state (pending amber, running cyan, answered emerald, abstained slate, cancelled rose). */
export const JOB_STATE_COLORS: Record<MemoryJobState, string> = {
  pending: "#f59e0b",
  running: "#06b6d4",
  answered: "#10b981",
  abstained: "#64748b",
  cancelled: "#f43f5e",
};

export function jobStateColor(state: string | undefined): string {
  return JOB_STATE_COLORS[(state ?? "pending") as MemoryJobState] ?? JOB_STATE_COLORS.pending;
}

/** Marker badge letters — H hygiene, A accumulation, S shared-write-review. */
export const JOB_MARKER_BADGES: Record<MemoryJobMarker, string> = {
  hygiene: "H",
  accumulation: "A",
  "shared-write-review": "S",
};

/** Normalise a marker string (`[hygiene]`, `hygiene`, `shared_write_review`) to a badge letter. */
export function jobMarkerBadge(marker: string | undefined | null): string | null {
  if (!marker) return null;
  const key = marker
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-") as MemoryJobMarker;
  return JOB_MARKER_BADGES[key] ?? null;
}

/** Single-letter glyph for the three curator helper roles. */
export function helperRoleGlyph(role: string | undefined): string {
  const r = (role ?? "").toLowerCase();
  if (r.includes("librarian")) return "L";
  if (r.includes("reflector")) return "R";
  if (r.includes("evaluator")) return "E";
  return r ? r[0]!.toUpperCase() : "?";
}

/**
 * The five unified retrieval tiers, in prompt order — the labels agents see in
 * `buildUnifiedContext`. Operators learn these visually via the Legend.
 */
export const UNIFIED_TIERS = ["skill", "trusted", "evidence", "proposal", "unverified"] as const;
export type UnifiedTier = (typeof UNIFIED_TIERS)[number];

export const UNIFIED_TIER_COLORS: Record<UnifiedTier, string> = {
  skill: "#f97316",
  trusted: "#22c55e",
  evidence: "#3b82f6",
  proposal: "#a855f7",
  unverified: "#9ca3af",
};

/** Legacy note tiers map onto the unified palette so twins and notes agree. */
const LEGACY_TIER_TO_UNIFIED: Record<string, UnifiedTier> = {
  fact: "evidence",
  reflection: "proposal",
  skill: "skill",
  core: "trusted",
  process: "unverified",
};

export function tierColor(tier: string | undefined): string {
  if (!tier) return UNIFIED_TIER_COLORS.unverified;
  const t = tier.toLowerCase();
  if (t in UNIFIED_TIER_COLORS) return UNIFIED_TIER_COLORS[t as UnifiedTier];
  const mapped = LEGACY_TIER_TO_UNIFIED[t];
  return mapped ? UNIFIED_TIER_COLORS[mapped] : UNIFIED_TIER_COLORS.unverified;
}

/** Short label for a `resolve` policy, drawn inside the resolution diamond. */
export function policyAbbrev(policy: string | undefined): string {
  switch ((policy ?? "").toLowerCase()) {
    case "last_writer_wins":
      return "LWW";
    case "evidence_weighted":
      return "EVW";
    case "await_confirmation":
      return "WAIT";
    case "keep_both":
      return "BOTH";
    default:
      return policy ? policy.slice(0, 4).toUpperCase() : "?";
  }
}

export interface MemoryEdgeStyle {
  color: string;
  dash?: string;
  width: number;
  /** Membership edges render as a soft band with no label or direction. */
  membership?: boolean;
  /** Draw as a closed interval: perpendicular ticks at both ends. */
  interval?: boolean;
  /** Animated dash flow (directional "becomes"). */
  flow?: boolean;
  /** Arrowhead at the target. */
  arrow?: boolean;
  /** Skip the midpoint pill. */
  noLabel?: boolean;
}

/** Relationship → style for the memory-only edge kinds. */
export const MEMORY_EDGE_STYLES: Record<string, MemoryEdgeStyle> = {
  twin: { color: "#9ca3af", dash: "1.5 3", width: 1.2, noLabel: true },
  cites: { color: "#a855f7", dash: "4 3", width: 1 },
  derived_from: { color: "#f97316", dash: "4 3", width: 1.5 },
  resolves: { color: "#10b981", width: 2, arrow: true },
  superseded_by: { color: "#f43f5e", dash: "5 3", width: 1.2, interval: true },
  in_space: { color: "#FFDD00", width: 6, membership: true, noLabel: true },
  worker: { color: "#7dd3fc", dash: "2 5", width: 0.9, noLabel: true },
  requester: { color: "#c4b5fd", dash: "2 5", width: 0.9, noLabel: true },
  adopted_as: { color: "#FFDD00", dash: "6 3", width: 2, flow: true, arrow: true },
};

/** Relationship kinds rendered by the existing GraphLinkEdge (unchanged styles). */
export const LEGACY_LINK_RELATIONSHIPS: ReadonlySet<string> = new Set([
  "related_to",
  "part_of",
  "supersedes",
  "contradicts",
]);

/** Legend glyph rows for the MEMORY section. */
export const MEMORY_GLYPHS: ReadonlyArray<{
  kind: MemoryGraphNodeKind;
  label: string;
  description: string;
}> = [
  { kind: "record", label: "record", description: "durable twin — hexagon docked beside its note" },
  {
    kind: "job",
    label: "job",
    description: "assistance job — ring colored by state, H/A/S marker",
  },
  { kind: "proposal", label: "proposal", description: "answered result — dashed until adopted" },
  {
    kind: "resolution",
    label: "resolution",
    description: "resolve policy — diamond, closes losers",
  },
  { kind: "space", label: "space", description: "institutional space — soft hull (e.g. guide)" },
  {
    kind: "helper",
    label: "helper",
    description: "curator agent — L librarian, R reflector, E evaluator",
  },
];
