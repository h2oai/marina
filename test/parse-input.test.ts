// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseDuration, parseSince } from "../src/engine/commands/format-duration";
import { parseDurationMs } from "../src/engine/commands/market";
import {
  canonicalSub,
  extractFlags,
  extractModifiers,
  int,
  normalizeIdToken,
  parseModifiers,
  resolveMultiWordName,
  splitOnTerminator,
  unknownSubcommand,
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

// ── parseModifiers — one grammar, four spellings ─────────────────────────────

describe("parseModifiers", () => {
  const SPEC = {
    kind: { type: "string" as const },
    since: { type: "duration" as const },
    limit: { type: "int" as const, aliases: ["n"] },
    persist: { type: "bool" as const },
    confidence: { type: "number" as const },
  };

  it("accepts key:value, key=value, --key value and --key=value identically", () => {
    const forms = [
      ["kind:market", "since:2h", "limit:10"],
      ["kind=market", "since=2h", "limit=10"],
      ["--kind", "market", "--since", "2h", "--limit", "10"],
      ["--kind=market", "--since=2h", "--limit=10"],
    ];
    for (const tokens of forms) {
      const r = parseModifiers(tokens, SPEC);
      expect(r.errors).toEqual([]);
      expect(r.values).toEqual({ kind: "market", since: 7_200_000, limit: 10 });
      expect(r.raw.since).toBe("2h");
      expect(r.rest).toEqual([]);
    }
  });

  it("removes modifiers from rest and keeps positionals in order", () => {
    const r = parseModifiers(["alpha", "--kind", "x", "beta", "limit:3", "gamma"], SPEC);
    expect(r.rest).toEqual(["alpha", "beta", "gamma"]);
    expect(r.values.kind).toBe("x");
    expect(r.values.limit).toBe(3);
  });

  it("never consumes undeclared keys (positional ids and URLs survive)", () => {
    const r = parseModifiers(["project:marina", "https://example.test/a:b", "--other", "v"], SPEC);
    expect(r.rest).toEqual(["project:marina", "https://example.test/a:b", "--other", "v"]);
    expect(r.values).toEqual({});
  });

  it("splits key:value on the FIRST separator so URL values keep their colons", () => {
    const r = parseModifiers(["kind:https://x.test/p?q=1"], SPEC);
    expect(r.values.kind).toBe("https://x.test/p?q=1");
  });

  it("honours aliases and matches keys case-insensitively", () => {
    expect(parseModifiers(["N:4"], SPEC).values.limit).toBe(4);
    expect(parseModifiers(["--Kind", "z"], SPEC).values.kind).toBe("z");
  });

  it("bool: bare --flag is true; explicit values parse; flag:false works", () => {
    expect(parseModifiers(["--persist"], SPEC).values.persist).toBe(true);
    expect(parseModifiers(["persist:false"], SPEC).values.persist).toBe(false);
    expect(parseModifiers(["--persist", "no"], SPEC).values.persist).toBe(false);
    // A following positional is not eaten by a bare bool flag.
    const r = parseModifiers(["--persist", "goal"], SPEC);
    expect(r.values.persist).toBe(true);
    expect(r.rest).toEqual(["goal"]);
  });

  it("types: number accepts decimals, int rejects them, duration rejects garbage", () => {
    expect(parseModifiers(["confidence:0.9"], SPEC).values.confidence).toBe(0.9);
    const badInt = parseModifiers(["limit:1.5"], SPEC);
    expect(badInt.values.limit).toBeUndefined();
    expect(badInt.errors[0]).toContain("limit");
    const badDur = parseModifiers(["since:soon"], SPEC);
    expect(badDur.errors[0]).toContain("since");
    expect(badDur.errors[0]).toContain("1mo");
    const missing = parseModifiers(["--kind"], SPEC);
    expect(missing.errors[0]).toContain("missing value");
  });

  it("a literal -- ends modifier parsing; everything after is positional", () => {
    const r = parseModifiers(["a", "kind:x", "--", "kind:y", "--limit", "5"], SPEC);
    expect(r.values).toEqual({ kind: "x" });
    expect(r.after).toEqual(["kind:y", "--limit", "5"]);
    expect(r.rest).toEqual(["a", "kind:y", "--limit", "5"]);
  });

  it("leading: stops at the first positional so free text is never scanned", () => {
    const r = parseModifiers(["since:1h", "hello", "kind:inside", "text"], SPEC, {
      leading: true,
    });
    expect(r.values).toEqual({ since: 3_600_000 });
    expect(r.rest).toEqual(["hello", "kind:inside", "text"]);
  });
});

describe("splitOnTerminator", () => {
  it("splits on a standalone -- only, not on --key", () => {
    expect(splitOnTerminator("alpha bob --formation pipeline -- ship it  now")).toEqual([
      "alpha bob --formation pipeline",
      "ship it  now",
    ]);
    expect(splitOnTerminator("alpha bob --formation pipeline")).toEqual([
      "alpha bob --formation pipeline",
      undefined,
    ]);
  });
});

// ── canonicalSub / unknownSubcommand ─────────────────────────────────────────

describe("canonicalSub", () => {
  it("maps ls→list, view/info→show, remove/rm→delete when the canonical verb exists", () => {
    const allowed = ["list", "show", "delete", "add"];
    expect(canonicalSub("ls", allowed)).toBe("list");
    expect(canonicalSub("view", allowed)).toBe("show");
    expect(canonicalSub("INFO", allowed)).toBe("show");
    expect(canonicalSub("remove", allowed)).toBe("delete");
    expect(canonicalSub("rm", allowed)).toBe("delete");
    expect(canonicalSub("add", allowed)).toBe("add");
  });

  it("maps show/view onto info for a command whose detail verb is info", () => {
    expect(canonicalSub("show", ["info", "create"])).toBe("info");
    expect(canonicalSub("view", ["info", "create"])).toBe("info");
  });

  it("leaves a command that distinguishes info from show alone", () => {
    expect(canonicalSub("info", ["info", "show"])).toBe("info");
    expect(canonicalSub("show", ["info", "show"])).toBe("show");
  });

  it("returns the lower-cased original when nothing matches, and undefined for undefined", () => {
    expect(canonicalSub("Frobnicate", ["list"])).toBe("frobnicate");
    expect(canonicalSub("rm", ["list"])).toBe("rm");
    expect(canonicalSub(undefined, ["list"])).toBeUndefined();
  });
});

describe("unknownSubcommand", () => {
  it("renders the shared shape", () => {
    expect(unknownSubcommand("task", "frob", "Usage: task list")).toBe(
      'Unknown task subcommand "frob". Usage: task list',
    );
  });
});

// ── parseDuration — one duration grammar ─────────────────────────────────────

describe("parseDuration", () => {
  it("m is minutes, mo is months, long spellings collapse onto the same units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("5min")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("2hours")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1w")).toBe(604_800_000);
    expect(parseDuration("1mo")).toBe(30 * 86_400_000);
    expect(parseDuration("2months")).toBe(60 * 86_400_000);
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });

  it("parseSince is the same grammar (now including mo)", () => {
    expect(parseSince("30m")).toBe(1_800_000);
    expect(parseSince("1mo")).toBe(30 * 86_400_000);
  });

  it("minUnit refuses finer units — market keeps rejecting a bare 1m", () => {
    expect(parseDuration("1m", { minUnit: "h" })).toBeUndefined();
    expect(parseDuration("1h", { minUnit: "h" })).toBe(3_600_000);
    expect(parseDurationMs("1m")).toBe(0);
    expect(parseDurationMs("7d")).toBe(7 * 86_400_000);
    expect(parseDurationMs("1mo")).toBe(30 * 86_400_000);
    expect(parseDurationMs("2weeks")).toBe(14 * 86_400_000);
  });
});
