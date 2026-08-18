// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  parseAssignee,
  parseScore,
  type Score,
  ScoreError,
  serializeScore,
  terminalStepId,
  topoLayers,
  validateScore,
} from "../src/coordination/score";

function score(steps: Score["steps"]): Score {
  return { id: "sc1", goal: "g", author: "alice", steps };
}

describe("Score grammar — parseAssignee", () => {
  it("classifies the four assignee kinds", () => {
    expect(parseAssignee("bob")).toEqual({ kind: "entity", value: "bob" });
    expect(parseAssignee("role:scholar")).toEqual({ kind: "role", value: "scholar" });
    expect(parseAssignee("model:openai/gpt-4o")).toEqual({
      kind: "model",
      value: "openai/gpt-4o",
    });
    expect(parseAssignee("conduct")).toEqual({ kind: "conduct", value: "" });
  });
});

describe("Score grammar — parseScore", () => {
  it("parses JSON and fills defaults", () => {
    const s = parseScore(
      JSON.stringify({ goal: "solve", steps: [{ instruction: "do it", assignee: "bob" }] }),
      { author: "alice" },
    );
    expect(s.goal).toBe("solve");
    expect(s.author).toBe("alice");
    expect(s.steps[0]!.id).toBe("s1"); // generated
    expect(s.steps[0]!.access).toEqual([]); // defaulted
  });

  it("throws on malformed JSON", () => {
    expect(() => parseScore("{not json")).toThrow(ScoreError);
  });

  it("throws when steps is missing", () => {
    expect(() => parseScore(JSON.stringify({ goal: "x" }))).toThrow(/steps/);
  });

  it("round-trips through serialize", () => {
    const s = parseScore(
      JSON.stringify({ steps: [{ id: "a", instruction: "i", assignee: "bob", access: [] }] }),
    );
    const again = parseScore(serializeScore(s));
    expect(again.steps).toEqual(s.steps);
  });
});

describe("Score grammar — validateScore", () => {
  it("accepts a valid chain", () => {
    const s = score([
      { id: "a", instruction: "plan", assignee: "bob", access: [] },
      { id: "b", instruction: "build", assignee: "carol", access: ["a"] },
    ]);
    expect(validateScore(s)).toBeNull();
  });

  it("rejects empty, duplicate ids, missing fields, bad refs, self-ref", () => {
    expect(validateScore(score([]))).toMatch(/no steps/);
    expect(
      validateScore(
        score([
          { id: "a", instruction: "x", assignee: "bob", access: [] },
          { id: "a", instruction: "y", assignee: "bob", access: [] },
        ]),
      ),
    ).toMatch(/Duplicate/);
    expect(
      validateScore(score([{ id: "a", instruction: "", assignee: "bob", access: [] }])),
    ).toMatch(/no instruction/);
    expect(validateScore(score([{ id: "a", instruction: "x", assignee: "", access: [] }]))).toMatch(
      /no assignee/,
    );
    expect(
      validateScore(score([{ id: "a", instruction: "x", assignee: "bob", access: ["ghost"] }])),
    ).toMatch(/unknown step/);
    expect(
      validateScore(score([{ id: "a", instruction: "x", assignee: "bob", access: ["a"] }])),
    ).toMatch(/own output/);
  });

  it("rejects a dependency cycle", () => {
    const s = score([
      { id: "a", instruction: "x", assignee: "bob", access: ["b"] },
      { id: "b", instruction: "y", assignee: "carol", access: ["a"] },
    ]);
    expect(validateScore(s)).toMatch(/cycle/);
  });
});

describe("Score grammar — topoLayers", () => {
  it("layers a sequential chain one per layer", () => {
    const s = score([
      { id: "a", instruction: "x", assignee: "bob", access: [] },
      { id: "b", instruction: "y", assignee: "carol", access: ["a"] },
      { id: "c", instruction: "z", assignee: "dave", access: ["b"] },
    ]);
    const layers = topoLayers(s).map((l) => l.map((st) => st.id));
    expect(layers).toEqual([["a"], ["b"], ["c"]]);
  });

  it("puts independent steps in the same layer (parallel), then the sink", () => {
    const s = score([
      { id: "a", instruction: "x", assignee: "bob", access: [] },
      { id: "b", instruction: "y", assignee: "carol", access: [] },
      { id: "merge", instruction: "combine", assignee: "dave", access: ["a", "b"] },
    ]);
    const layers = topoLayers(s).map((l) => l.map((st) => st.id).sort());
    expect(layers).toEqual([["a", "b"], ["merge"]]);
  });

  it("throws on a cycle", () => {
    const s = score([
      { id: "a", instruction: "x", assignee: "bob", access: ["b"] },
      { id: "b", instruction: "y", assignee: "carol", access: ["a"] },
    ]);
    expect(() => topoLayers(s)).toThrow(ScoreError);
  });

  it("terminalStepId is the last authored step", () => {
    const s = score([
      { id: "a", instruction: "x", assignee: "bob", access: [] },
      { id: "final", instruction: "y", assignee: "carol", access: ["a"] },
    ]);
    expect(terminalStepId(s)).toBe("final");
  });
});
