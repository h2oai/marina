// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { Score } from "../src/coordination/score";
import { characterizeScore, shapeSummary } from "../src/coordination/score-shape";

function score(steps: Score["steps"]): Score {
  return { id: "sc1", goal: "g", author: "alice", steps };
}

describe("characterizeScore — topology classification", () => {
  it("single step", () => {
    const shape = characterizeScore(
      score([{ id: "a", instruction: "x", assignee: "bob", access: [] }]),
    );
    expect(shape.topology).toBe("single");
    expect(shape.stepCount).toBe(1);
    expect(shape.maxWidth).toBe(1);
  });

  it("sequential chain", () => {
    const shape = characterizeScore(
      score([
        { id: "a", instruction: "x", assignee: "bob", access: [] },
        { id: "b", instruction: "y", assignee: "carol", access: ["a"] },
        { id: "c", instruction: "z", assignee: "dave", access: ["b"] },
      ]),
    );
    expect(shape.topology).toBe("chain");
    expect(shape.layerCount).toBe(3);
    expect(shape.maxWidth).toBe(1);
  });

  it("best-of-n: N independent steps feeding one sink", () => {
    const shape = characterizeScore(
      score([
        { id: "a", instruction: "attempt", assignee: "x", access: [] },
        { id: "b", instruction: "attempt", assignee: "y", access: [] },
        { id: "c", instruction: "attempt", assignee: "z", access: [] },
        { id: "pick", instruction: "choose best", assignee: "judge", access: ["a", "b", "c"] },
      ]),
    );
    expect(shape.topology).toBe("best-of-n");
    expect(shape.maxWidth).toBe(3);
  });

  it("parallel: two independent branches, no single merge", () => {
    const shape = characterizeScore(
      score([
        { id: "a", instruction: "x", assignee: "x", access: [] },
        { id: "b", instruction: "y", assignee: "y", access: [] },
      ]),
    );
    expect(shape.topology).toBe("parallel");
  });

  it("tree: branching across more than two layers", () => {
    const shape = characterizeScore(
      score([
        { id: "a", instruction: "x", assignee: "x", access: [] },
        { id: "b", instruction: "y", assignee: "y", access: ["a"] },
        { id: "c", instruction: "z", assignee: "z", access: ["a"] },
        { id: "d", instruction: "merge", assignee: "w", access: ["b", "c"] },
      ]),
    );
    expect(shape.topology).toBe("tree");
    expect(shape.layerCount).toBe(3);
  });

  it("collects distinct workers and flags recursion", () => {
    const shape = characterizeScore(
      score([
        { id: "a", instruction: "x", assignee: "role:scholar", access: [] },
        { id: "b", instruction: "y", assignee: "conduct", access: ["a"] },
        { id: "c", instruction: "z", assignee: "role:scholar", access: ["b"] },
      ]),
    );
    expect(shape.workers.sort()).toEqual(["conduct", "scholar"]);
    expect(shape.recursive).toBe(true);
  });

  it("shapeSummary is a compact one-liner", () => {
    const shape = characterizeScore(
      score([{ id: "a", instruction: "x", assignee: "bob", access: [] }]),
    );
    expect(shapeSummary(shape)).toBe("single/1 steps/1 workers");
  });
});
