// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { roundHealth } from "../src/arena/health";
import type { SubmitDeps } from "../src/arena/submit";
import { submitRound } from "../src/arena/submit";
import type { ArenaRound } from "../src/arena/types";
import { MarinaDB } from "../src/persistence/database";

const round: ArenaRound = {
  round_id: "q",
  tracker: "civiqs",
  series: "civiqs_net_approval",
  target_type: "continuous_normal",
  question: "Approval?",
  lock_at: "2099-01-06T22:00:00Z",
  release_at: "2099-01-08T00:00:00Z",
};

test("failed refreshes remain visible without replacing the accepted forecast", async () => {
  const db = new MarinaDB(":memory:");
  try {
    const id = db.insertArenaSubmission({
      entrant: "test",
      roundId: "q",
      requestId: "accepted",
      url: "https://example.org",
      body: "{}",
      meta: "{}",
    });
    db.updateArenaSubmission(id, { status: "accepted" });
    const deps = {
      store: db,
      config: { entrant: "test", forecaster: "test" },
      data: { round: async () => round, lock: async () => ({ round_id: "q" }) },
      now: () => Date.parse("2099-01-06T10:00:00Z"),
      forecaster: async () => {
        throw new Error("daily spend cap reached");
      },
    } as unknown as SubmitDeps;
    expect((await submitRound(deps, "q", { replace: true })).kind).toBe("skipped");
    expect(db.acceptedArenaSubmission("test", "q")?.id).toBe(id);
    const health = roundHealth(round, db, "test", deps.now!());
    expect(health.lastAttempt?.reason).toContain("spend cap");
    expect(health.lastAttempt?.unfinished).toBe(false);
    expect(health.accepted?.id).toBe(id);
    expect(db.listArenaAttempts({ entrant: "test" })).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("rejected replacement does not erase an earlier accepted submission", async () => {
  const db = new MarinaDB(":memory:");
  try {
    const create = (requestId: string) =>
      db.insertArenaSubmission({
        entrant: "test",
        roundId: "q",
        requestId,
        url: "https://example.org",
        body: "{}",
        meta: "{}",
      });
    const good = create("first");
    db.updateArenaSubmission(good, { status: "accepted" });
    db.updateArenaSubmission(create("second"), { status: "rejected" });
    const result = await submitRound(
      {
        store: db,
        config: { entrant: "test" },
        data: { round: async () => round },
        now: () => Date.parse("2099-01-06T10:00:00Z"),
      } as unknown as SubmitDeps,
      "q",
    );
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.row.id).toBe(good);
    expect(roundHealth(round, db, "test").accepted?.id).toBe(good);
  } finally {
    db.close();
  }
});
