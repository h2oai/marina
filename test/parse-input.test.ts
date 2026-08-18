// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  extractFlags,
  extractModifiers,
  int,
  normalizeIdToken,
  resolveMultiWordName,
} from "../src/engine/parse-input";

// ── normalizeIdToken ─────────────────────────────────────────────────────────

describe("normalizeIdToken", () => {
  it("lowercases", () => {
    expect(normalizeIdToken("MMLU")).toBe("mmlu");
  });

  it("collapses spaces to single hyphen", () => {
    expect(normalizeIdToken("simple  qa")).toBe("simple-qa");
    expect(normalizeIdToken(" leading trailing ")).toBe("-leading-trailing-");
  });

  it("collapses underscores to hyphens", () => {
    expect(normalizeIdToken("simple_qa")).toBe("simple-qa");
    expect(normalizeIdToken("tick__rate")).toBe("tick-rate");
  });

  it("collapses runs of hyphens to single", () => {
    expect(normalizeIdToken("simple--qa")).toBe("simple-qa");
  });

  it("mixed whitespace, underscore, and hyphen all normalize identically", () => {
    const variants = ["simple qa", "simple_qa", "simple-qa", "Simple Qa", "SIMPLE_QA"];
    const normalized = variants.map(normalizeIdToken);
    for (const n of normalized) expect(n).toBe("simple-qa");
  });
});

// ── resolveMultiWordName ─────────────────────────────────────────────────────

const BENCHES = new Set([
  "mmlu-pro",
  "simple-qa",
  "arc-challenge",
  "aime-2025",
  "gsm8k",
  "ifeval",
  "humaneval",
  "truthfulqa",
]);

describe("resolveMultiWordName", () => {
  it("matches a single token exactly", () => {
    const r = resolveMultiWordName(["ifeval", "--limit", "10"], 0, BENCHES);
    expect(r).toEqual({ name: "ifeval", consumed: 1 });
  });

  it("matches two tokens joined with hyphen", () => {
    const r = resolveMultiWordName(["simple", "qa", "--limit", "10"], 0, BENCHES);
    expect(r).toEqual({ name: "simple-qa", consumed: 2 });
  });

  it("matches 'mmlu pro' → mmlu-pro", () => {
    const r = resolveMultiWordName(["mmlu", "pro"], 0, BENCHES);
    expect(r).toEqual({ name: "mmlu-pro", consumed: 2 });
  });

  it("matches 'aime 2025' → aime-2025", () => {
    const r = resolveMultiWordName(["aime", "2025"], 0, BENCHES);
    expect(r).toEqual({ name: "aime-2025", consumed: 2 });
  });

  it("matches underscored form 'simple_qa' → simple-qa", () => {
    const r = resolveMultiWordName(["simple_qa"], 0, BENCHES);
    expect(r).toEqual({ name: "simple-qa", consumed: 1 });
  });

  it("matches already-hyphenated 'mmlu-pro'", () => {
    const r = resolveMultiWordName(["mmlu-pro"], 0, BENCHES);
    expect(r).toEqual({ name: "mmlu-pro", consumed: 1 });
  });

  it("case-insensitive: 'MMLU Pro' → mmlu-pro", () => {
    const r = resolveMultiWordName(["MMLU", "Pro"], 0, BENCHES);
    expect(r).toEqual({ name: "mmlu-pro", consumed: 2 });
  });

  it("stops at the first flag token", () => {
    const r = resolveMultiWordName(["mmlu", "pro", "--limit", "5"], 0, BENCHES);
    expect(r).toEqual({ name: "mmlu-pro", consumed: 2 });
  });

  it("prefers longest match — 'simple qa' beats 'simple' alone", () => {
    const reg = new Set(["simple", "simple-qa"]);
    const r = resolveMultiWordName(["simple", "qa"], 0, reg);
    expect(r).toEqual({ name: "simple-qa", consumed: 2 });
  });

  it("falls back to shorter match when longer doesn't exist", () => {
    const r = resolveMultiWordName(["ifeval", "foo", "bar"], 0, BENCHES);
    expect(r).toEqual({ name: "ifeval", consumed: 1 });
  });

  it("returns null when nothing matches", () => {
    const r = resolveMultiWordName(["nope", "never"], 0, BENCHES);
    expect(r).toBeNull();
  });

  it("returns null when start index is out of bounds", () => {
    expect(resolveMultiWordName(["mmlu-pro"], 1, BENCHES)).toBeNull();
    expect(resolveMultiWordName([], 0, BENCHES)).toBeNull();
  });

  it("supports squashed variant — 'gsm 8k' → gsm8k", () => {
    const r = resolveMultiWordName(["gsm", "8k"], 0, BENCHES);
    expect(r).toEqual({ name: "gsm8k", consumed: 2 });
  });

  it("respects maxWords cap", () => {
    const reg = new Set(["a-b-c-d-e"]);
    const r = resolveMultiWordName(["a", "b", "c", "d", "e"], 0, reg, 3);
    expect(r).toBeNull();
  });

  it("accepts readonly array registry too (not just Set)", () => {
    const r = resolveMultiWordName(["mmlu", "pro"], 0, ["mmlu-pro", "gsm8k"] as readonly string[]);
    expect(r).toEqual({ name: "mmlu-pro", consumed: 2 });
  });
});

// ── Sanity: existing helpers still work ─────────────────────────────────────

describe("parse-input existing helpers", () => {
  it("int parses valid numbers", () => {
    expect(int("42")).toBe(42);
    expect(int("0")).toBe(0);
    expect(int(undefined)).toBeNull();
    expect(int("not-a-number")).toBeNull();
  });

  it("int respects min/max", () => {
    expect(int("5", { min: 10 })).toBeNull();
    expect(int("50", { max: 10 })).toBeNull();
    expect(int("7", { min: 1, max: 10 })).toBe(7);
  });

  it("extractModifiers pulls trailing key-value pairs", () => {
    const { text, modifiers } = extractModifiers("some text importance 7 type fact", [
      "importance",
      "type",
    ]);
    expect(text).toBe("some text");
    expect(modifiers.importance).toBe("7");
    expect(modifiers.type).toBe("fact");
  });

  it("extractFlags pulls trailing boolean flags", () => {
    const { text, flags } = extractFlags("query text recent", ["recent", "important"]);
    expect(text).toBe("query text");
    expect(flags.has("recent")).toBe(true);
    expect(flags.has("important")).toBe(false);
  });
});
