// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { RecallTrace } from "../lib/types";
import {
  buildRecallPathEdges,
  hasLiveRecallTrace,
  RECALL_PATH_LIFETIME_MS,
} from "../unified/lib/recall-paths";

function trace(partial: Partial<RecallTrace> & { timestamp: number }): RecallTrace {
  return {
    entity: "alice",
    query: "what did we decide?",
    seedNoteIds: [],
    activatedNoteIds: [],
    ...partial,
  };
}

describe("buildRecallPathEdges", () => {
  const now = 1_000_000;

  it("emits one edge per activated note, sharing a single labeled pill", () => {
    const edges = buildRecallPathEdges(
      [
        trace({
          timestamp: now - 1000,
          seedNoteIds: [10],
          activatedNoteIds: [10, 20, 30],
        }),
      ],
      { alice: "zone/hall" },
      new Set(["zone/hall"]),
      new Map([
        [10, { x: 0, y: 0 }],
        [20, { x: 0, y: 0 }],
        [30, { x: 0, y: 0 }],
      ]),
      now,
    );

    expect(edges.length).toBe(3);
    // First edge carries the query pill
    const firstData = edges[0]!.data as { showLabel: boolean; seed: boolean };
    expect(firstData.showLabel).toBe(true);
    expect(firstData.seed).toBe(true); // 10 is in seedNoteIds

    const otherShowLabels = edges.slice(1).map((e) => (e.data as { showLabel: boolean }).showLabel);
    expect(otherShowLabels).toEqual([false, false]);

    // Non-seed activations carry seed: false
    const secondData = edges[1]!.data as { seed: boolean };
    expect(secondData.seed).toBe(false);
  });

  it("skips traces older than the lifetime", () => {
    const edges = buildRecallPathEdges(
      [trace({ timestamp: now - RECALL_PATH_LIFETIME_MS - 100, activatedNoteIds: [1] })],
      { alice: "zone/hall" },
      new Set(["zone/hall"]),
      new Map([[1, { x: 0, y: 0 }]]),
      now,
    );
    expect(edges).toEqual([]);
  });

  it("skips traces whose entity has no known room", () => {
    const edges = buildRecallPathEdges(
      [trace({ timestamp: now - 1000, activatedNoteIds: [1] })],
      {}, // alice not in any room
      new Set(["zone/hall"]),
      new Map([[1, { x: 0, y: 0 }]]),
      now,
    );
    expect(edges).toEqual([]);
  });

  it("skips traces whose room node id isn't in the live room set", () => {
    const edges = buildRecallPathEdges(
      [trace({ timestamp: now - 1000, activatedNoteIds: [1] })],
      { alice: "zone/ghost" },
      new Set(["zone/hall"]),
      new Map([[1, { x: 0, y: 0 }]]),
      now,
    );
    expect(edges).toEqual([]);
  });

  it("skips activated notes that have no layout position", () => {
    const edges = buildRecallPathEdges(
      [trace({ timestamp: now - 1000, activatedNoteIds: [1, 2, 3] })],
      { alice: "zone/hall" },
      new Set(["zone/hall"]),
      new Map([
        [1, { x: 0, y: 0 }],
        [3, { x: 0, y: 0 }],
      ]), // 2 missing
      now,
    );
    expect(edges.length).toBe(2);
    expect(edges.map((e) => e.target)).toEqual(["note-1", "note-3"]);
    // Still only one pill
    expect(edges.filter((e) => (e.data as { showLabel: boolean }).showLabel).length).toBe(1);
  });

  it("emits nothing when the activated set is empty", () => {
    const edges = buildRecallPathEdges(
      [trace({ timestamp: now - 1000, activatedNoteIds: [] })],
      { alice: "zone/hall" },
      new Set(["zone/hall"]),
      new Map(),
      now,
    );
    expect(edges).toEqual([]);
  });

  it("uses the recallPath edge type", () => {
    const edges = buildRecallPathEdges(
      [trace({ timestamp: now - 1000, activatedNoteIds: [1] })],
      { alice: "zone/hall" },
      new Set(["zone/hall"]),
      new Map([[1, { x: 0, y: 0 }]]),
      now,
    );
    expect(edges[0]?.type).toBe("recallPath");
    expect(edges[0]?.source).toBe("zone/hall");
    expect(edges[0]?.target).toBe("note-1");
  });
});

describe("hasLiveRecallTrace", () => {
  const now = 1_000_000;

  it("returns true when any trace is within the window", () => {
    expect(
      hasLiveRecallTrace(
        [
          trace({ timestamp: now - 10_000 }), // expired
          trace({ timestamp: now - 2_000 }), // live
        ],
        now,
      ),
    ).toBe(true);
  });

  it("returns false when every trace is expired", () => {
    expect(
      hasLiveRecallTrace(
        [
          trace({ timestamp: now - 10_000 }),
          trace({ timestamp: now - RECALL_PATH_LIFETIME_MS - 1 }),
        ],
        now,
      ),
    ).toBe(false);
  });

  it("returns false on an empty list", () => {
    expect(hasLiveRecallTrace([], now)).toBe(false);
  });
});
