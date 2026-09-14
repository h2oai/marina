// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * memory-map-layout -- Deterministic placement for the MEMORY layer on top of
 * the GRAPH layer's force-directed note cloud.
 *
 * Grammar:
 *   - records (durable twins) are PINNED beside their legacy note (`twin` edge)
 *   - jobs CLUSTER around their requester's notes (centroid), falling back to
 *     the cited notes, the job's space, then the cloud center
 *   - institutional spaces are GRAVITY WELLS on the periphery; ratified records
 *     with no twin sit inside the hull in a ring
 *   - helpers ORBIT the space they serve (via the jobs they work), otherwise
 *     the cloud rim
 *   - proposals dock beside their job; resolutions sit between winner and losers
 *
 * Every angle is derived from an FNV hash of the node id (plus its index within
 * a sorted sibling set), so reloads look identical and new nodes never reshuffle
 * existing ones.
 */

import { collisionRepulse } from "./layout-utils";
import {
  edgesTouching,
  indexMemoryGraph,
  type MemoryGraphIndex,
  neighborsVia,
  otherEnd,
} from "./memory-map-reducer";
import type { MemoryGraph, MemoryGraphNode } from "./memory-map-types";

export interface Point {
  x: number;
  y: number;
}

export interface MemoryLayoutOptions {
  /** Center of the GRAPH note cloud (UnifiedCanvas uses {0, 3200}). */
  center?: Point;
  /** Radius used when no notes are positioned yet. */
  baseRadius?: number;
}

export interface MemoryLayout {
  /** Position per memory node id (`record:1`, `job:7`, …). Notes reuse the GRAPH layer's. */
  positions: Map<string, Point>;
  /** Hull radius per space id — drawn by the space node, used by helper orbits. */
  hullRadius: Map<string, number>;
  /** Which anchor a job clustered around (for tests + debugging). */
  jobAnchors: Map<string, { anchor: string; point: Point }>;
}

export const TWIN_OFFSET = 34;
export const JOB_RING_BASE = 90;
export const JOB_RING_PER_DEPTH = 28;
export const SPACE_MARGIN = 420;
export const HELPER_ORBIT_MARGIN = 56;
export const PROPOSAL_OFFSET = 46;

/** 32-bit FNV-1a — cheap, deterministic, well distributed for short ids. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic angle in [0, 2π) from an id. */
export function hashAngle(id: string): number {
  return (fnv1a(id) / 0xffffffff) * Math.PI * 2;
}

function polar(origin: Point, angle: number, radius: number): Point {
  return { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
}

function centroid(points: Point[]): Point | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function noteNumericId(nodeId: string): number | null {
  if (!nodeId.startsWith("note:")) return null;
  const n = Number(nodeId.slice(5));
  return Number.isFinite(n) ? n : null;
}

function byIdAsc(a: MemoryGraphNode, b: MemoryGraphNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Radius of a space hull for `members` ratified records. */
export function spaceHullRadius(members: number): number {
  return 70 + 22 * Math.sqrt(Math.max(0, members));
}

/**
 * Compute positions for every non-note node in `graph`.
 *
 * @param graph          memory graph from `/api/memory/graph`
 * @param notePositions  GRAPH layer positions keyed by numeric note id
 */
export function computeMemoryLayout(
  graph: MemoryGraph,
  notePositions: ReadonlyMap<number, Point>,
  opts?: MemoryLayoutOptions,
): MemoryLayout {
  const center = opts?.center ?? { x: 0, y: 3200 };
  const baseRadius = opts?.baseRadius ?? 400;
  const index = indexMemoryGraph(graph);
  const positions = new Map<string, Point>();
  const hullRadius = new Map<string, number>();
  const jobAnchors = new Map<string, { anchor: string; point: Point }>();

  // ── Note cloud extent ────────────────────────────────────────────────────
  let cloudR = baseRadius;
  for (const p of notePositions.values()) {
    const d = Math.hypot(p.x - center.x, p.y - center.y);
    if (d > cloudR) cloudR = d;
  }

  /** Position of a legacy note node if the GRAPH layer knows it, else a deterministic spiral slot. */
  const notePoint = (nodeId: string): Point | null => {
    const n = noteNumericId(nodeId);
    if (n === null) return null;
    const known = notePositions.get(n);
    if (known) return known;
    // Unpositioned note (GRAPH layer hidden or note not in its snapshot):
    // place on a deterministic ring so twins still have somewhere to dock.
    return polar(center, hashAngle(nodeId), baseRadius * 0.6 + (fnv1a(nodeId) % 200));
  };
  for (const n of graph.nodes) {
    if (n.kind === "note") {
      const p = notePoint(n.id);
      if (p) positions.set(n.id, p);
    }
  }

  const sorted = [...graph.nodes].sort(byIdAsc);
  const spaces = sorted.filter((n) => n.kind === "space");
  const records = sorted.filter((n) => n.kind === "record");
  const jobs = sorted.filter((n) => n.kind === "job");
  const proposals = sorted.filter((n) => n.kind === "proposal");
  const resolutions = sorted.filter((n) => n.kind === "resolution");
  const helpers = sorted.filter((n) => n.kind === "helper");

  // ── Spaces: gravity wells on the periphery ───────────────────────────────
  const spaceMembers = new Map<string, string[]>();
  for (const s of spaces) {
    const members = neighborsVia(index, s.id, "in_space", "in").sort();
    spaceMembers.set(s.id, members);
    hullRadius.set(s.id, spaceHullRadius(members.length));
  }
  const spaceAngleBase = spaces.length > 0 ? hashAngle(spaces.map((s) => s.id).join("|")) : 0;
  spaces.forEach((s, i) => {
    const angle = spaceAngleBase + (Math.PI * 2 * i) / Math.max(1, spaces.length);
    const r = cloudR + SPACE_MARGIN + (hullRadius.get(s.id) ?? 0);
    positions.set(s.id, polar(center, angle, r));
  });

  // ── Records: twins pinned beside notes; orphans ring the cloud; ratified live in hulls ──
  const twinSlots = [-0.6, 0.6, 2.5, 3.8]; // radians — upper-right, lower-right, upper-left, lower-left
  const orphanRecords: MemoryGraphNode[] = [];
  for (const rec of records) {
    const twinNotes = neighborsVia(index, rec.id, "twin").filter((id) => id.startsWith("note:"));
    const notePos = twinNotes.length > 0 ? positions.get(twinNotes[0]!) : undefined;
    if (notePos) {
      const slot = twinSlots[fnv1a(rec.id) % twinSlots.length]!;
      positions.set(rec.id, polar(notePos, slot, TWIN_OFFSET));
      continue;
    }
    orphanRecords.push(rec);
  }
  // Records inside a space hull (ratified, no twin on the map)
  const placedInHull = new Set<string>();
  for (const s of spaces) {
    const sp = positions.get(s.id)!;
    const members = (spaceMembers.get(s.id) ?? []).filter(
      (m) => !positions.has(m) && index.byId.get(m)?.kind === "record",
    );
    const ringR = Math.max(0, (hullRadius.get(s.id) ?? 70) - 26);
    members.forEach((m, i) => {
      const angle = hashAngle(s.id) + (Math.PI * 2 * i) / Math.max(1, members.length);
      positions.set(m, members.length === 1 ? { ...sp } : polar(sp, angle, ringR));
      placedInHull.add(m);
    });
  }
  const freeOrphans = orphanRecords.filter((r) => !placedInHull.has(r.id));
  freeOrphans.forEach((rec) => {
    positions.set(rec.id, polar(center, hashAngle(rec.id), cloudR + 120));
  });

  // ── Jobs: cluster around requester's notes ───────────────────────────────
  const notesByEntity = new Map<string, Point[]>();
  for (const n of graph.nodes) {
    if (n.kind !== "note" || !n.entityName) continue;
    const p = positions.get(n.id);
    if (!p) continue;
    if (!notesByEntity.has(n.entityName)) notesByEntity.set(n.entityName, []);
    notesByEntity.get(n.entityName)!.push(p);
  }
  const anchorCounts = new Map<string, number>();
  for (const job of jobs) {
    const requester =
      (job.meta?.requesterName as string | undefined) ??
      job.entityName ??
      neighborsVia(index, job.id, "requester", "out")
        .map((h) => index.byId.get(h)?.label ?? h.replace(/^helper:/, ""))
        .find(Boolean);
    let anchor = "center";
    let point: Point | null = null;
    if (requester && notesByEntity.has(requester)) {
      anchor = `entity:${requester}`;
      point = centroid(notesByEntity.get(requester)!);
    }
    if (!point) {
      const cited = neighborsVia(index, job.id, "cites", "out")
        .map((id) => positions.get(id))
        .filter((p): p is Point => !!p);
      if (cited.length > 0) {
        anchor = "cites";
        point = centroid(cited);
      }
    }
    if (!point && job.spaceId) {
      const sp = positions.get(`space:${job.spaceId}`) ?? positions.get(job.spaceId);
      if (sp) {
        anchor = `space:${job.spaceId}`;
        point = sp;
      }
    }
    if (!point) point = center;
    const k = anchorCounts.get(anchor) ?? 0;
    anchorCounts.set(anchor, k + 1);
    const depth = typeof job.meta?.depth === "number" ? (job.meta.depth as number) : 0;
    const ringR =
      (anchor.startsWith("space:") ? (hullRadius.get(anchor) ?? 70) + 40 : JOB_RING_BASE) +
      depth * JOB_RING_PER_DEPTH;
    const angle = hashAngle(job.id) + k * 0.9;
    positions.set(job.id, polar(point, angle, ringR));
    jobAnchors.set(job.id, { anchor, point });
  }

  // ── Proposals: dock beside their job (any edge), else beside the same-id record ──
  for (const prop of proposals) {
    const jobNeighbor = edgesTouching(index, prop.id)
      .map((e) => otherEnd(e, prop.id))
      .find((id) => id.startsWith("job:"));
    const jobPos = jobNeighbor ? positions.get(jobNeighbor) : undefined;
    if (jobPos) {
      positions.set(prop.id, polar(jobPos, hashAngle(prop.id), PROPOSAL_OFFSET));
      continue;
    }
    const recPos = positions.get(`record:${prop.id.slice("proposal:".length)}`);
    if (recPos) {
      positions.set(prop.id, polar(recPos, 0.6, TWIN_OFFSET));
      continue;
    }
    positions.set(prop.id, polar(center, hashAngle(prop.id), cloudR + 160));
  }

  // ── Resolutions: between winner and losers ───────────────────────────────
  for (const res of resolutions) {
    const winners = neighborsVia(index, res.id, "resolves", "out");
    const losers = neighborsVia(index, res.id, "superseded_by", "in");
    const pts = [...winners, ...losers]
      .map((id) => positions.get(id))
      .filter((p): p is Point => !!p);
    const c = centroid(pts);
    positions.set(
      res.id,
      c ? polar(c, hashAngle(res.id), 40) : polar(center, hashAngle(res.id), cloudR + 200),
    );
  }

  // ── Helpers: orbit the space they serve, else the cloud rim ──────────────
  for (const h of helpers) {
    const servedSpace = neighborsVia(index, h.id, "worker", "out")
      .map((jobId) => index.byId.get(jobId)?.spaceId)
      .filter((s): s is string => !!s)
      .map((s) => (positions.has(`space:${s}`) ? `space:${s}` : positions.has(s) ? s : null))
      .find((s): s is string => !!s);
    if (servedSpace) {
      const sp = positions.get(servedSpace)!;
      const r = (hullRadius.get(servedSpace) ?? 70) + HELPER_ORBIT_MARGIN;
      positions.set(h.id, polar(sp, hashAngle(h.id), r));
    } else {
      positions.set(h.id, polar(center, hashAngle(h.id), cloudR + 260));
    }
  }

  // ── Collision pass over the FREE set only (pinned twins/spaces/notes stay put) ──
  const free: string[] = [
    ...jobs.map((n) => n.id),
    ...resolutions.map((n) => n.id),
    ...helpers.map((n) => n.id),
    ...freeOrphans.map((n) => n.id),
  ];
  const arr = free.map((id) => ({ ...positions.get(id)! }));
  collisionRepulse(arr, 4, 42);
  for (let i = 0; i < free.length; i++) positions.set(free[i]!, arr[i]!);

  return { positions, hullRadius, jobAnchors };
}

export { indexMemoryGraph, type MemoryGraphIndex };
