// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import {
  beginSubmission,
  getSubmission,
  listPendingSubmissions,
  settleSubmission,
} from "../src/persistence/db-submissions";
import { cleanupDb } from "./helpers";

const path = `/tmp/marina-submissions-${crypto.randomUUID()}.db`;

describe("exactly-once submission ledger", () => {
  let db: MarinaDB;
  let raw: Database;

  beforeEach(() => {
    db = new MarinaDB(path);
    raw = new Database(path);
  });

  afterEach(() => {
    raw.close();
    db.close();
    cleanupDb(path);
  });

  it("claims a request id only once", () => {
    expect(beginSubmission(raw, "job-42", "command", 1)).toEqual({ started: true });
    expect(beginSubmission(raw, "job-42", "command", 2)).toEqual({ started: false });
  });

  it("settles a pending submission with its result", () => {
    beginSubmission(raw, "job-42", "command", 1);
    expect(settleSubmission(raw, "job-42", '{"ok":true}', 2)).toBe(true);

    const submission = getSubmission(raw, "job-42");
    expect(submission?.status).toBe("resolved");
    expect(submission?.resultJson).toBe('{"ok":true}');
    expect(submission?.settledAt).toBe(2);
  });

  it("never overwrites a settled result (idempotent settlement)", () => {
    beginSubmission(raw, "job-42", "command", 1);
    settleSubmission(raw, "job-42", '{"ok":true}', 2);
    expect(settleSubmission(raw, "job-42", '{"ok":false}', 3)).toBe(false);
    expect(getSubmission(raw, "job-42")?.resultJson).toBe('{"ok":true}');
  });

  it("lists crash-orphaned pending submissions for a resume pass", () => {
    beginSubmission(raw, "pending-1", "command", 1);
    beginSubmission(raw, "pending-2", "memory", 2);
    beginSubmission(raw, "resolved-1", "command", 3);
    settleSubmission(raw, "resolved-1", '"done"', 4);

    const pending = listPendingSubmissions(raw);
    expect(pending.map((p) => p.requestId).sort()).toEqual(["pending-1", "pending-2"]);
    expect(listPendingSubmissions(raw, "memory").map((p) => p.requestId)).toEqual(["pending-2"]);
  });

  it("returns undefined for unknown ids", () => {
    expect(getSubmission(raw, "nope")).toBeUndefined();
  });
});
