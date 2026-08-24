// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_evidence_chain.db";

afterEach(() => cleanupDb(TEST_DB));

describe("evidence receipt chain", () => {
  test("hashes canonical payloads into a sequential, verifiable chain", () => {
    const db = new MarinaDB(TEST_DB);
    const first = db.appendEvidenceReceipt({
      eventType: "decision",
      ref: "trace:t1",
      payload: { b: 2, a: 1 },
      createdAt: 100,
    });
    const second = db.appendEvidenceReceipt({
      eventType: "promotion",
      ref: "variant:v2",
      payload: { accepted: true },
      createdAt: 101,
    });

    expect(first.sequence).toBe(1);
    expect(second.previous_hash).toBe(first.entry_hash);
    expect(db.verifyEvidenceChain()).toEqual({
      valid: true,
      entries: 2,
      headHash: second.entry_hash,
      firstInvalidSequence: null,
    });
    db.close();
  });

  test("detects local history modification without claiming external trust", () => {
    const db = new MarinaDB(TEST_DB);
    db.appendEvidenceReceipt({ eventType: "decision", ref: "trace:t1", payload: { ok: true } });
    (db as unknown as { db: Database }).db.run(
      "UPDATE evidence_receipts SET ref = ? WHERE sequence = 1",
      ["trace:altered"],
    );
    expect(db.verifyEvidenceChain()).toMatchObject({ valid: false, firstInvalidSequence: 1 });
    db.close();
  });

  test("automatically receipts attributed trace judgments", () => {
    const db = new MarinaDB(TEST_DB);
    const judgment = db.addTraceJudgment({
      traceId: "trace-1",
      evaluatorEntity: "Reviewer",
      verdict: "passed",
      criterion: "Outcome met",
      rationale: "Artifact and checks agree.",
      evidenceSpanIds: ["span-1"],
    });
    expect(db.listEvidenceReceipts()).toEqual([
      expect.objectContaining({
        event_type: "trace_judgment",
        ref: `trace:trace-1/judgment:${judgment.id}`,
      }),
    ]);
    db.close();
  });
});
