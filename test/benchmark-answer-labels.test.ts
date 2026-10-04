// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Per-item answer identity and outcome labels in the benchmark ledger
// (migration 157): a keyed answer hash (never the answer), `budget_forced`,
// and verification states that keep "never ran" apart from "failed".
// Every fixture is synthetic.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ledgerFileBody } from "../benchmarks/ledger-file";
import { replyLabels, verificationFromLabel } from "../benchmarks/modes/passthrough";
import { ledgerResult, verificationState } from "../benchmarks/swebench/adapter";
import type { BenchmarkResult } from "../benchmarks/types";
import {
  answerDigest,
  formatVerificationCounts,
  type HarnessResultFile,
  ledgerFromHarnessResult,
  normalizeAnswerForHash,
  verificationCounts,
} from "../src/engine/benchmark-ledger";
import { MarinaDB } from "../src/persistence/database";
import { ANSWER_HASH_KEY_SETTING } from "../src/persistence/db-benchmarks";
import { cleanupDb } from "./helpers";

describe("answer digest", () => {
  it("normalises before hashing: case, TeX, whitespace, punctuation, numbers", () => {
    expect(normalizeAnswerForHash("  \\boxed{Paris}. ")).toBe("paris");
    expect(normalizeAnswerForHash("$42$")).toBe("42");
    expect(normalizeAnswerForHash("1,234.50")).toBe("1234.5");
    expect(normalizeAnswerForHash("−5")).toBe("-5");
    expect(normalizeAnswerForHash("A ,  C")).toBe("a,c");
    expect(answerDigest("Paris")).toBe(answerDigest("  paris. "));
    expect(answerDigest("Paris")).not.toBe(answerDigest("Lyon"));
  });

  it("has no digest for an empty answer or an error marker", () => {
    expect(answerDigest("")).toBeUndefined();
    expect(answerDigest("  ...  ")).toBeUndefined();
    expect(answerDigest("ERROR: timeout")).toBeUndefined();
    expect(answerDigest(undefined)).toBeUndefined();
  });
});

describe("verification states", () => {
  it("maps the verification formation's label: a checker that never ran is not a failure", () => {
    expect(verificationFromLabel("approved")).toBe("passed");
    expect(verificationFromLabel("revised")).toBe("failed");
    expect(verificationFromLabel("held-write")).toBe("failed");
    expect(verificationFromLabel("checker-unavailable")).toBe("not_run");
    expect(verificationFromLabel(null)).toBeUndefined();
    expect(replyLabels({ content: "", usage: {}, verification: "not_run" })).toEqual({
      verification: "not_run",
    });
  });

  it("classifies a Code Mode verification artifact", () => {
    expect(verificationState("complete", { commands: [["bun", "test"]] })).toBe("passed");
    expect(verificationState("failed", { commands: [["pytest"]], exitCode: 1 })).toBe("failed");
    // Dependency preparation failed: no check executed.
    expect(verificationState("failed", { commands: [], preparation: { status: "failed" } })).toBe(
      "not_run",
    );
    expect(verificationState("failed", {})).toBe("not_run");
    // An explicit state wins, in either spelling.
    expect(verificationState("failed", { state: "infra/not-run", commands: [["x"]] })).toBe(
      "not_run",
    );
    expect(verificationState("failed", { state: "ran/passed" })).toBe("passed");
    // Code Mode's outcome field and statuses (#277): an infrastructure error ran no check.
    expect(verificationState("not_run", { outcome: "not_run" })).toBe("not_run");
    expect(verificationState("error", { outcome: "error", commands: [["x"]] })).toBe("not_run");
    expect(verificationState("error", {})).toBe("not_run");
    expect(verificationState("failed", { outcome: "failed", commands: [] })).toBe("failed");
    expect(verificationState("complete", { outcome: "passed" })).toBe("passed");
  });

  it("counts states apart and reports them in the SWE ledger result", () => {
    const counts = verificationCounts([
      { verification: "passed" },
      { verification: "failed" },
      { verification: "not_run" },
      { verification: "not_run" },
      {},
    ]);
    expect(counts).toEqual({ passed: 1, failed: 1, notRun: 2, unreported: 1 });
    expect(formatVerificationCounts(counts)).toContain("2 not run");
    expect(formatVerificationCounts(verificationCounts([{}]))).toBeUndefined();

    const attempt = (id: string, lastVerification?: "passed" | "failed" | "not_run") => ({
      instance_id: id,
      arm: "a",
      replicate: 1,
      exitCode: 0,
      patchBytes: 10,
      costUsd: 0.1,
      durationMs: 1000,
      trajectory: "",
      ...(lastVerification ? { lastVerification } : {}),
    });
    const result = ledgerResult(
      { resolved_ids: ["i1"] },
      [attempt("i1", "passed"), attempt("i2", "not_run"), attempt("i3")],
      { arm: { name: "a", model: "m" }, replicate: 1, subsetSeed: 1 },
    );
    expect(result.metadata.itemVerification).toEqual({
      passed: 1,
      failed: 0,
      not_run: 1,
      never_requested: 1,
    });
    expect(result.items.find((i) => i.id === "i2")?.verification).toBe("not_run");
  });
});

describe("filing: digests and labels, never text", () => {
  it("sends a digest of the answer and the labels, not the answer", () => {
    const result = {
      config: { name: "s", dataset: "s", model: "m", endpoint: "http://x", apiKey: "k" },
      timestamp: 1,
      duration_ms: 1,
      scores: { overall: 0.5, breakdown: {} },
      metadata: { total: 2, answered: 2, timeouts: 0, errors: 0, avgLatencyMs: 1 },
      items: [
        {
          id: "q1",
          question: "secret question",
          expected: "secret gold",
          actual: "Secret Answer",
          correct: true,
          latencyMs: 5,
          budgetForced: true,
          verification: "not_run",
        },
        {
          id: "q2",
          question: "q",
          expected: "e",
          actual: "ERROR: boom",
          correct: false,
          latencyMs: 5,
        },
      ],
    } as unknown as BenchmarkResult;
    const body = ledgerFileBody(result, { fileTo: "http://x", targetKind: "model", target: "m" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("Secret Answer");
    expect(text).not.toContain("secret gold");
    const [first, second] = body.result.items;
    expect(first).toMatchObject({
      answerDigest: answerDigest("Secret Answer"),
      budgetForced: true,
      verification: "not_run",
    });
    expect(second).toMatchObject({ fallback: true });
    expect(second).not.toHaveProperty("answerDigest");
  });
});

describe("ledger storage (migration 157)", () => {
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-answer-labels-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function file(answers: Array<string | undefined>, extra: Record<string, unknown> = {}) {
    return {
      config: { name: "s", dataset: "synthetic-set", model: "m" },
      timestamp: 1_000,
      duration_ms: 10,
      items: answers.map((a, i) => ({
        id: `item-${i}`,
        correct: i === 0,
        latencyMs: 1,
        ...(a === undefined ? {} : { actual: a }),
        ...extra,
      })),
    } as HarnessResultFile;
  }

  function record(id: string, f: HarnessResultFile) {
    const raw = JSON.stringify({ ...f, tag: id });
    const built = ledgerFromHarnessResult(JSON.parse(raw), {
      targetKind: "model",
      target: "m",
      raw,
      id,
      now: 2_000,
    });
    db.recordBenchmarkLedgerRun(built.run, built.items);
    return db.getBenchmarkItems(id);
  }

  it("stores a keyed hash: equal answers match across runs, the digest itself is never stored", () => {
    const a = record("r1", file(["Paris", "A", undefined]));
    const b = record("r2", file(["  paris.", "B", "ERROR: x"]));
    expect(a[0]!.answer_hash).toBeTruthy();
    expect(a[0]!.answer_hash).toBe(b[0]!.answer_hash);
    expect(a[1]!.answer_hash).not.toBe(b[1]!.answer_hash);
    expect(a[2]!.answer_hash).toBeNull();
    expect(b[2]!.answer_hash).toBeNull();
    // Not the unkeyed digest: a guessed answer cannot be hashed and matched.
    expect(a[0]!.answer_hash).not.toBe(answerDigest("Paris"));
    expect(a[0]!.answer_hash).not.toContain(answerDigest("Paris")!.slice(0, 32));
    // The same answer on another item hashes differently (bound to the item).
    const c = record("r3", file(["x", "x"]));
    expect(c[0]!.answer_hash).not.toBe(c[1]!.answer_hash);
    const key = (
      db as unknown as { db: { query: (s: string) => { get: (k: string) => unknown } } }
    ).db
      .query("SELECT value FROM app_settings WHERE key = ?")
      .get(ANSWER_HASH_KEY_SETTING) as { value: string };
    expect(key.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps budget_forced and verification, null when unreported", () => {
    const labelled = record("r4", file(["x"], { budgetForced: true, verification: "not_run" }));
    expect(labelled[0]).toMatchObject({ budget_forced: 1, verification: "not_run" });
    const bare = record("r5", file(["x"]));
    expect(bare[0]).toMatchObject({ budget_forced: null, verification: null });
    const junk = record("r6", file(["x"], { verification: "maybe", budgetForced: "yes" }));
    expect(junk[0]).toMatchObject({ budget_forced: null, verification: null });
  });

  it("prefers an explicit digest over deriving one from the response text", () => {
    const digest = answerDigest("Paris")!;
    const explicit = record("r7", {
      ...file([undefined]),
      items: [{ id: "item-0", correct: true, answerDigest: digest }],
    });
    const derived = record("r8", file(["Paris"]));
    expect(explicit[0]!.answer_hash).toBe(derived[0]!.answer_hash);
  });
});
