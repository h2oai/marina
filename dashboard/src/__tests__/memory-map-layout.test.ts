// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  computeMemoryLayout,
  fnv1a,
  HELPER_ORBIT_MARGIN,
  JOB_RING_BASE,
  SPACE_MARGIN,
  TWIN_OFFSET,
} from "../unified/lib/memory-map-layout";
import type { MemoryGraph } from "../unified/lib/memory-map-types";

const CENTER = { x: 0, y: 3200 };

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function fixture(): MemoryGraph {
  return {
    nodes: [
      { id: "note:1", kind: "note", label: "n1", entityName: "alice" },
      { id: "note:2", kind: "note", label: "n2", entityName: "alice" },
      { id: "note:3", kind: "note", label: "n3", entityName: "bob" },
      { id: "record:1", kind: "record", label: "r1", tier: "evidence" },
      { id: "record:2", kind: "record", label: "r2", tier: "trusted" },
      { id: "record:9", kind: "record", label: "r9 (ratified, no twin)", tier: "trusted" },
      {
        id: "job:7",
        kind: "job",
        label: "reflector 7",
        state: "running",
        entityName: "alice",
        spaceId: "guide",
      },
      { id: "job:8", kind: "job", label: "evaluator 8", state: "pending", entityName: "alice" },
      {
        id: "job:9",
        kind: "job",
        label: "librarian 9",
        state: "pending",
        entityName: "nobody",
        spaceId: "guide",
      },
      { id: "space:guide", kind: "space", label: "guide", institutional: true },
      { id: "helper:reflector-1", kind: "helper", label: "reflector-1", role: "memory-reflector" },
      { id: "helper:loner", kind: "helper", label: "loner", role: "memory-librarian" },
      { id: "proposal:9", kind: "proposal", label: "p9", state: "adopted" },
      { id: "resolution:1", kind: "resolution", label: "res 1", policy: "evidence_weighted" },
    ],
    edges: [
      { id: "t1", source: "record:1", target: "note:1", relationship: "twin" },
      { id: "t2", source: "note:2", target: "record:2", relationship: "twin" },
      { id: "s1", source: "record:9", target: "space:guide", relationship: "in_space" },
      { id: "w1", source: "helper:reflector-1", target: "job:7", relationship: "worker" },
      { id: "a1", source: "job:7", target: "record:9", relationship: "adopted_as" },
      { id: "d1", source: "proposal:9", target: "job:7", relationship: "derived_from" },
      { id: "rv", source: "resolution:1", target: "record:1", relationship: "resolves" },
      { id: "rl", source: "record:2", target: "resolution:1", relationship: "superseded_by" },
    ],
    truncated: false,
  };
}

const NOTE_POS = new Map([
  [1, { x: 100, y: 3300 }],
  [2, { x: -180, y: 3100 }],
  [3, { x: 300, y: 2900 }],
]);

describe("computeMemoryLayout", () => {
  it("pins twin records beside their legacy notes", () => {
    const { positions } = computeMemoryLayout(fixture(), NOTE_POS, { center: CENTER });
    expect(dist(positions.get("record:1")!, NOTE_POS.get(1)!)).toBeCloseTo(TWIN_OFFSET, 5);
    expect(dist(positions.get("record:2")!, NOTE_POS.get(2)!)).toBeCloseTo(TWIN_OFFSET, 5);
  });

  it("clusters jobs around their requester's notes", () => {
    const { positions, jobAnchors } = computeMemoryLayout(fixture(), NOTE_POS, { center: CENTER });
    const aliceCentroid = { x: (100 + -180) / 2, y: (3300 + 3100) / 2 };
    for (const id of ["job:7", "job:8"]) {
      expect(jobAnchors.get(id)?.anchor).toBe("entity:alice");
      // Placed on the ring (before collision nudges) — allow the repulsion pass some slack.
      expect(dist(positions.get(id)!, aliceCentroid)).toBeLessThan(JOB_RING_BASE + 60);
      expect(dist(positions.get(id)!, aliceCentroid)).toBeGreaterThan(JOB_RING_BASE - 60);
    }
    // A job whose requester has no notes falls back to its space
    expect(jobAnchors.get("job:9")?.anchor).toBe("space:guide");
  });

  it("puts institutional spaces on the periphery and ratified records inside the hull", () => {
    const { positions, hullRadius } = computeMemoryLayout(fixture(), NOTE_POS, { center: CENTER });
    let cloudR = 400;
    for (const p of NOTE_POS.values()) cloudR = Math.max(cloudR, dist(p, CENTER));
    const space = positions.get("space:guide")!;
    expect(dist(space, CENTER)).toBeGreaterThanOrEqual(cloudR + SPACE_MARGIN);
    // Twin-less ratified record lives inside the hull
    const r9 = positions.get("record:9")!;
    expect(dist(r9, space)).toBeLessThanOrEqual(hullRadius.get("space:guide")!);
    // Twinned records stay with their notes, not in the hull
    expect(dist(positions.get("record:1")!, space)).toBeGreaterThan(hullRadius.get("space:guide")!);
  });

  it("orbits helpers around the space they serve, others around the cloud rim", () => {
    const { positions, hullRadius } = computeMemoryLayout(fixture(), NOTE_POS, { center: CENTER });
    const space = positions.get("space:guide")!;
    const orbit = hullRadius.get("space:guide")! + HELPER_ORBIT_MARGIN;
    expect(dist(positions.get("helper:reflector-1")!, space)).toBeLessThan(orbit + 50);
    expect(dist(positions.get("helper:reflector-1")!, space)).toBeGreaterThan(orbit - 50);
    expect(dist(positions.get("helper:loner")!, CENTER)).toBeGreaterThan(400);
  });

  it("docks proposals beside their job and resolutions between winner and losers", () => {
    const { positions } = computeMemoryLayout(fixture(), NOTE_POS, { center: CENTER });
    expect(dist(positions.get("proposal:9")!, positions.get("job:7")!)).toBeLessThan(120);
    const res = positions.get("resolution:1")!;
    const mid = {
      x: (positions.get("record:1")!.x + positions.get("record:2")!.x) / 2,
      y: (positions.get("record:1")!.y + positions.get("record:2")!.y) / 2,
    };
    expect(dist(res, mid)).toBeLessThan(120);
  });

  it("is deterministic across reloads and independent of node order", () => {
    const a = computeMemoryLayout(fixture(), NOTE_POS, { center: CENTER });
    const b = computeMemoryLayout(fixture(), NOTE_POS, { center: CENTER });
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);

    const shuffled = fixture();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    const c = computeMemoryLayout(shuffled, NOTE_POS, { center: CENTER });
    for (const [id, p] of a.positions) {
      expect(c.positions.get(id)).toEqual(p);
    }
  });

  it("still places twins when the GRAPH layer has no position for the note", () => {
    const { positions } = computeMemoryLayout(fixture(), new Map(), { center: CENTER });
    expect(positions.has("record:1")).toBe(true);
    expect(positions.has("note:1")).toBe(true);
    expect(dist(positions.get("record:1")!, positions.get("note:1")!)).toBeCloseTo(TWIN_OFFSET, 5);
  });

  it("hashes stably", () => {
    expect(fnv1a("job:7")).toBe(fnv1a("job:7"));
    expect(fnv1a("job:7")).not.toBe(fnv1a("job:8"));
  });
});
