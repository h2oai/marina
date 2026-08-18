// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type EvalItem, score } from "../scripts/eval-prompt";

describe("eval-prompt score()", () => {
  it("contains: case-insensitive substring", () => {
    expect(score({ type: "contains", value: "Paris" }, "The capital is paris.")).toBe(true);
    expect(score({ type: "contains", value: "Paris" }, "The capital is London.")).toBe(false);
  });

  it("numeric: matches the target anywhere, tolerating prose and commas", () => {
    expect(score({ type: "numeric", value: 391 }, "17 * 23 = 391.")).toBe(true);
    expect(score({ type: "numeric", value: 1000 }, "the answer is 1,000")).toBe(true);
    expect(score({ type: "numeric", value: 5 }, "The ball costs 10 cents")).toBe(false);
  });

  it("regex: case-insensitive pattern", () => {
    expect(score({ type: "regex", value: "break|shatter" }, "It will SHATTER.")).toBe(true);
    expect(score({ type: "regex", value: "\\bAu\\b" }, "The symbol is Au.")).toBe(true);
    expect(score({ type: "regex", value: "\\bAu\\b" }, "Auburn")).toBe(false);
  });

  it("exact: trimmed strict equality (format fidelity)", () => {
    expect(score({ type: "exact", value: "B" }, " B ")).toBe(true);
    expect(score({ type: "exact", value: "B" }, "The answer is B.")).toBe(false);
  });

  it("not_contains: passes when the value is absent", () => {
    expect(score({ type: "not_contains", value: "arthritis" }, "It is harmless.")).toBe(true);
    expect(score({ type: "not_contains", value: "arthritis" }, "It causes arthritis.")).toBe(false);
  });
});

describe("smoke-eval.json fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "benchmarks", "smoke-eval.json"), "utf8"),
  ) as { items: EvalItem[] };

  it("is a well-formed, non-trivial frozen set", () => {
    expect(fixture.items.length).toBeGreaterThanOrEqual(12);
    const ids = fixture.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids
    for (const item of fixture.items) {
      expect(item.prompt.length).toBeGreaterThan(0);
      expect(["contains", "not_contains", "regex", "exact", "numeric"]).toContain(item.check.type);
    }
  });
});
