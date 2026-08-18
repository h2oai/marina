// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseTaskNodeType, TASK_NODE_TYPE_MEANING } from "../src/coordination/task-node-type";

describe("parseTaskNodeType", () => {
  it("returns 'leaf' for unmarked titles", () => {
    expect(parseTaskNodeType("Migrate call sites")).toBe("leaf");
    expect(parseTaskNodeType("")).toBe("leaf");
  });

  it("recognizes [bundle] prefix", () => {
    expect(parseTaskNodeType("[bundle] Audit auth usage")).toBe("bundle");
  });

  it("recognizes [action] prefix", () => {
    expect(parseTaskNodeType("[action] Run benchmark sweep")).toBe("action");
  });

  it("recognizes [decide] prefix", () => {
    expect(parseTaskNodeType("[decide] Classify severity")).toBe("decide");
  });

  it("recognizes [gate] prefix", () => {
    expect(parseTaskNodeType("[gate] Approve before merge")).toBe("gate");
  });

  it("recognizes [agent] prefix", () => {
    expect(parseTaskNodeType("[agent] Investigate the regression")).toBe("agent");
  });

  it("is case-insensitive (voice-friendly)", () => {
    expect(parseTaskNodeType("[BUNDLE] X")).toBe("bundle");
    expect(parseTaskNodeType("[Action] X")).toBe("action");
    expect(parseTaskNodeType("[Gate] X")).toBe("gate");
  });

  it("tolerates leading whitespace", () => {
    expect(parseTaskNodeType("  [decide] Pick a model")).toBe("decide");
  });

  it("ignores markers that are not a known type", () => {
    expect(parseTaskNodeType("[needs-replan] something")).toBe("leaf");
    expect(parseTaskNodeType("[scope-conflict] something")).toBe("leaf");
  });

  it("only matches at the start of the title", () => {
    expect(parseTaskNodeType("Audit then [bundle] something")).toBe("leaf");
  });

  it("exposes a meaning for every non-leaf type", () => {
    for (const t of ["bundle", "action", "decide", "gate", "agent"] as const) {
      expect(TASK_NODE_TYPE_MEANING[t]).toBeTruthy();
    }
  });
});
