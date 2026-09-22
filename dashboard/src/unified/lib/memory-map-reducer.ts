// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * memory-map-reducer -- Pure state transitions for the MEMORY layer.
 *
 * Two responsibilities, both side-effect free so they unit-test directly:
 *   1. `parseMemoryLiveMessage` — recognise a raw dashboard-WebSocket frame as a
 *      memory event. Accepts both the top-level shape from the contract
 *      (`{ type: "memory_job", job, timestamp }`) and the dashboard's usual
 *      envelope (`{ type: "event", data: { type: "memory_job", ... } }`).
 *   2. `applyMemoryJobEvent` — fold a `memory_job` event into a `MemoryGraph`
 *      in place: update the job node's state/meta (or insert a new job node),
 *      and synthesise `worker` / `requester` / `adopted_as` edges when the
 *      event names endpoints the graph already knows about.
 */

import type {
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryJobEvent,
  MemoryLiveEvent,
  MemoryServiceEvent,
} from "./memory-map-types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Cheap pre-filter so we don't JSON.parse every streaming frame. */
export function looksLikeMemoryFrame(raw: unknown): raw is string {
  return typeof raw === "string" && raw.includes('"memory_');
}

/**
 * Recognise a parsed WebSocket payload as a memory live event. Handles the
 * top-level contract shape and the `{type:"event", data}` envelope. Returns
 * null for anything else.
 */
export function parseMemoryLiveMessage(msg: unknown): MemoryLiveEvent | null {
  if (!isRecord(msg)) return null;
  let body: Record<string, unknown> = msg;
  if (msg.type === "event" && isRecord(msg.data)) body = msg.data;
  const ts = typeof body.timestamp === "number" ? body.timestamp : Date.now();
  if (body.type === "memory_job" && isRecord(body.job) && typeof body.job.id === "string") {
    return {
      type: "memory_job",
      job: body.job as MemoryJobEvent["job"],
      timestamp: ts,
    };
  }
  if (body.type === "memory_service_event" && typeof body.kind === "string") {
    const { type: _t, timestamp: _ts, ...rest } = body;
    return {
      ...(rest as Omit<MemoryServiceEvent, "type" | "timestamp">),
      type: "memory_service_event",
      kind: body.kind,
      timestamp: ts,
    };
  }
  return null;
}

export interface ApplyJobResult {
  graph: MemoryGraph;
  /** True when the job's `state` changed (drives the pulse). */
  transitioned: boolean;
  /** Set when this event is the first to report the job as adopted. */
  adopted?: { jobId: string; recordId?: string };
  /** Node id of the job (`job:<id>`). */
  nodeId: string;
}

/** Job node id for a raw job id — tolerates an already-prefixed id. */
export function jobNodeId(rawId: string): string {
  return rawId.startsWith("job:") ? rawId : `job:${rawId}`;
}

function helperNodeId(name: string): string {
  return `helper:${name}`;
}

function recordNodeId(rawId: string): string {
  return rawId.startsWith("record:") ? rawId : `record:${rawId}`;
}

function edgeId(rel: string, source: string, target: string): string {
  return `${rel}|${source}|${target}`;
}

function hasEdge(graph: MemoryGraph, rel: string, source: string, target: string): boolean {
  return graph.edges.some(
    (e) => e.relationship === rel && e.source === source && e.target === target,
  );
}

/**
 * Fold a `memory_job` event into the graph. Returns a new graph object (nodes
 * and edges arrays are copied on write) so React memoisation sees the change.
 */
export function applyMemoryJobEvent(graph: MemoryGraph, event: MemoryJobEvent): ApplyJobResult {
  const job = event.job;
  const id = jobNodeId(job.id);
  const idx = graph.nodes.findIndex((n) => n.id === id);
  const prev = idx >= 0 ? graph.nodes[idx]! : undefined;
  const prevMeta = prev?.meta ?? {};

  // Remember the first remaining-ops figure so the arc has a denominator.
  const initialOperations =
    typeof prevMeta.initialOperations === "number"
      ? prevMeta.initialOperations
      : typeof job.remainingOperations === "number"
        ? job.remainingOperations
        : null;

  const meta: Record<string, string | number | boolean | null> = {
    ...prevMeta,
    workOpen: job.workOpen ?? (prevMeta.workOpen as boolean | undefined) ?? null,
    workerName: job.workerName ?? (prevMeta.workerName as string | undefined) ?? null,
    requesterName: job.requesterName ?? (prevMeta.requesterName as string | undefined) ?? null,
    rootId: job.rootId ?? (prevMeta.rootId as string | undefined) ?? null,
    parentId: job.parentId ?? (prevMeta.parentId as string | undefined) ?? null,
    depth: job.depth ?? (prevMeta.depth as number | undefined) ?? null,
    remainingOperations:
      job.remainingOperations ?? (prevMeta.remainingOperations as number | undefined) ?? null,
    initialOperations,
    deadline: job.deadline ?? (prevMeta.deadline as number | undefined) ?? null,
    marker: job.marker ?? (prevMeta.marker as string | undefined) ?? null,
    adopted: !!job.adopted || prevMeta.adopted === true,
    adoptedRecordId:
      job.adopted?.recordId ?? (prevMeta.adoptedRecordId as string | undefined) ?? null,
    updatedAt: event.timestamp,
  };

  const node: MemoryGraphNode = {
    id,
    kind: "job",
    label: prev?.label ?? `${job.role ?? "job"} ${job.id}`,
    entityName: job.requesterName ?? prev?.entityName,
    spaceId: job.spaceId ?? prev?.spaceId,
    state: job.state,
    role: job.role ?? prev?.role,
    at: prev?.at ?? job.createdAt ?? event.timestamp,
    meta,
  };

  const nodes = [...graph.nodes];
  if (idx >= 0) nodes[idx] = node;
  else nodes.push(node);

  const edges: MemoryGraphEdge[] = [...graph.edges];
  const known = new Set(nodes.map((n) => n.id));

  if (job.workerName) {
    const h = helperNodeId(job.workerName);
    if (known.has(h) && !hasEdge(graph, "worker", h, id)) {
      edges.push({ id: edgeId("worker", h, id), source: h, target: id, relationship: "worker" });
    }
  }
  if (job.requesterName) {
    const h = helperNodeId(job.requesterName);
    if (known.has(h) && !hasEdge(graph, "requester", id, h)) {
      edges.push({
        id: edgeId("requester", id, h),
        source: id,
        target: h,
        relationship: "requester",
      });
    }
  }

  let adopted: ApplyJobResult["adopted"];
  const wasAdopted = prevMeta.adopted === true;
  const adoptedRecordId = job.adopted?.recordId;
  if (job.adopted && !wasAdopted) {
    adopted = { jobId: id, recordId: adoptedRecordId };
    if (adoptedRecordId) {
      const r = recordNodeId(adoptedRecordId);
      if (known.has(r) && !hasEdge(graph, "adopted_as", id, r)) {
        edges.push({
          id: edgeId("adopted_as", id, r),
          source: id,
          target: r,
          relationship: "adopted_as",
        });
      }
    }
  }

  return {
    graph: { nodes, edges, truncated: graph.truncated },
    transitioned: prev === undefined || prev.state !== job.state,
    adopted,
    nodeId: id,
  };
}

/** Index helpers shared by layout, nodes and the context panel. */
export interface MemoryGraphIndex {
  byId: Map<string, MemoryGraphNode>;
  /** Outgoing edges per node id. */
  out: Map<string, MemoryGraphEdge[]>;
  /** Incoming edges per node id. */
  in: Map<string, MemoryGraphEdge[]>;
}

export function indexMemoryGraph(graph: MemoryGraph): MemoryGraphIndex {
  const byId = new Map<string, MemoryGraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  const out = new Map<string, MemoryGraphEdge[]>();
  const inn = new Map<string, MemoryGraphEdge[]>();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e);
    if (!inn.has(e.target)) inn.set(e.target, []);
    inn.get(e.target)!.push(e);
  }
  return { byId, out, in: inn };
}

/** All edges touching `id`, regardless of direction. */
export function edgesTouching(index: MemoryGraphIndex, id: string): MemoryGraphEdge[] {
  return [...(index.out.get(id) ?? []), ...(index.in.get(id) ?? [])];
}

/** The node on the other end of `edge` from `id`. */
export function otherEnd(edge: MemoryGraphEdge, id: string): string {
  return edge.source === id ? edge.target : edge.source;
}

/** Neighbour ids across a given relationship (either direction). */
export function neighborsVia(
  index: MemoryGraphIndex,
  id: string,
  relationship: string,
  direction: "out" | "in" | "both" = "both",
): string[] {
  const result: string[] = [];
  if (direction !== "in") {
    for (const e of index.out.get(id) ?? [])
      if (e.relationship === relationship) result.push(e.target);
  }
  if (direction !== "out") {
    for (const e of index.in.get(id) ?? [])
      if (e.relationship === relationship) result.push(e.source);
  }
  return result;
}
