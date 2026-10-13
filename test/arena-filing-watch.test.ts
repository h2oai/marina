// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  filingFindings,
  recordFilingWatch,
  resetFilingWatchForTests,
} from "../src/arena/filing-watch";
import type { ArenaRound } from "../src/arena/types";
import { arenaFilingCheck } from "../src/engine/readiness";
import { MarinaDB } from "../src/persistence/database";

const H = 3_600_000;
const ENTRANT = "marina-test";

function round(id: string, lockAt: number): ArenaRound {
  return {
    round_id: id,
    tracker: "civiqs",
    series: "civiqs_net_approval",
    target_type: "continuous_normal",
    question: "Net approval?",
    lock_at: new Date(lockAt).toISOString(),
    release_at: new Date(lockAt + 48 * H).toISOString(),
  };
}

describe("arena filing watch", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    resetFilingWatchForTests();
  });
  afterEach(() => db.close());

  const accept = (roundId: string) => {
    const id = db.insertArenaSubmission({
      entrant: ENTRANT,
      roundId,
      requestId: crypto.randomUUID(),
      url: "https://arena.test/forecasts",
      meta: "{}",
      body: "{}",
    });
    db.updateArenaSubmission(id, { status: "accepted", httpStatus: 200 });
  };
  const attempt = (
    roundId: string,
    status: string,
    at: number,
    phase: "started" | "finished" = "finished",
  ) =>
    db.recordArenaAttempt({
      attempt_id: crypto.randomUUID(),
      entrant: ENTRANT,
      round_id: roundId,
      phase,
      status,
      detail: JSON.stringify(status === "error" ? { reason: "build failed" } : {}),
      created_at: at,
    });

  it("flags an unfiled round, critical close to its lock; ignores rounds outside 24 h", () => {
    const now = Date.now();
    const found = filingFindings(
      [
        round("soon", now + 3 * H),
        round("later", now + 20 * H),
        round("far", now + 30 * H),
        round("past", now - H),
      ],
      db,
      ENTRANT,
      now,
    );
    expect(found.map((f) => [f.roundId, f.problem, f.severity])).toEqual([
      ["soon", "unfiled", "critical"],
      ["later", "unfiled", "warning"],
    ]);
  });

  it("flags a refresh that failed after the standing filing, and a stuck one", () => {
    accept("failing");
    accept("stuck");
    accept("fine");
    const now = Date.now() + 2 * H;
    attempt("failing", "error", now - 10 * 60_000);
    attempt("stuck", "running", now - 45 * 60_000, "started");
    attempt("fine", "accepted", now - 10 * 60_000);
    const found = filingFindings(
      [round("failing", now + 5 * H), round("stuck", now + 5 * H), round("fine", now + 5 * H)],
      db,
      ENTRANT,
      now,
    );
    expect(found.map((f) => [f.roundId, f.problem])).toEqual([
      ["failing", "failed-refresh"],
      ["stuck", "stuck-refresh"],
    ]);
    expect(found[0]!.detail).toContain("build failed");
  });

  it("flags a missing near-lock refresh — the 10-11 outage shape", () => {
    accept("outage");
    // The standing filing is from long ago, and nothing has run since.
    const now = Date.now() + 40 * H;
    const found = filingFindings([round("outage", now + 30 * 60_000)], db, ENTRANT, now);
    expect(found.map((f) => f.problem)).toEqual(["no-near-lock-refresh"]);
    // A refresh 20 minutes ago is the near-lock pass: fine.
    attempt("outage", "accepted", now - 20 * 60_000);
    expect(filingFindings([round("outage", now + 30 * 60_000)], db, ENTRANT, now)).toEqual([]);
  });

  it("reports the last pass in readiness", () => {
    expect(arenaFilingCheck().detail).toContain("not checked yet");
    const now = Date.now();
    recordFilingWatch({ checkedAt: now, watched: 3, findings: [] });
    expect(arenaFilingCheck(now)).toMatchObject({ id: "arena-filing", status: "ok" });
    recordFilingWatch({
      checkedAt: now,
      watched: 3,
      findings: [
        {
          roundId: "r1",
          lockAt: "x",
          severity: "critical",
          problem: "unfiled",
          detail: "no accepted filing",
        },
      ],
    });
    expect(arenaFilingCheck(now)).toMatchObject({ status: "degraded" });
    expect(arenaFilingCheck(now).detail).toContain("r1: unfiled");
    recordFilingWatch({ checkedAt: now, watched: 0, findings: [], error: "fetch failed" });
    expect(arenaFilingCheck(now).detail).toContain("could not read the open rounds");
  });
});
