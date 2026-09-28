// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import {
  discover,
  pastAttempts,
  promotedSignals,
  promotionMargin,
} from "../src/arena/discovery/loop";
import { applySignal, signalKey, validateSignal } from "../src/arena/discovery/signals";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("signal language", () => {
  it("accepts the menu and refuses anything else", () => {
    expect(validateSignal({ centre: "ewma:0.3", spread: "rms:26" })).toBeUndefined();
    expect(validateSignal({ centre: "nowcast-shrink:0.5", spread: "scale:0.8" })).toBeUndefined();
    expect(validateSignal({ centre: "eval(process.exit())", spread: "arena" })).toContain(
      "unknown centre",
    );
    expect(validateSignal({ centre: "mean:40", spread: "arena" })).toContain("window");
    expect(validateSignal({ centre: "last", spread: "scale:9" })).toContain("scale");
    expect(signalKey({ centre: "last", spread: "arena", tracker: "civiqs" })).toBe(
      "civiqs|last|arena",
    );
  });

  it("computes centres and spreads from the frozen history only", async () => {
    const history = weekly([10, 12, 14, 16, 18, 20, 22, 24]);
    const round = {
      round_id: "x-2026-w10",
      tracker: "demo",
      question: "?",
      target_type: "continuous_normal",
      lock_at: "2026-03-01T14:00:00Z",
      release_at: new Date(Date.parse(history.at(-1)!.date) + 7 * 86_400_000).toISOString(),
    } as ArenaRound;
    const lock = { round_id: round.round_id, answer_history: history };
    const data = new ArenaData(
      "https://example.test",
      async () => new Response("", { status: 404 }),
    );
    expect((await applySignal({ centre: "last", spread: "arena" }, round, lock, data)).mean).toBe(
      24,
    );
    expect((await applySignal({ centre: "mean:2", spread: "arena" }, round, lock, data)).mean).toBe(
      23,
    );
    expect(
      (await applySignal({ centre: "trend:4", spread: "arena" }, round, lock, data)).mean,
    ).toBe(26);
    expect((await applySignal({ centre: "last", spread: "arena" }, round, lock, data)).sd).toBe(
      1.5,
    );
    expect((await applySignal({ centre: "last", spread: "rms:6" }, round, lock, data)).sd).toBe(2);
  });
});

describe("nowcast centres", () => {
  // Weekly history ends Friday 2026-09-25 at -26; the snapshot fetched before the
  // Wednesday lock has daily readings up to Monday, the last one -22.
  const history = weekly([-25, -26, -25, -26], "2026-09-04");
  const round = {
    round_id: "civiqs-2026-w40-approval",
    tracker: "civiqs",
    series: "civiqs_net_approval",
    question: "?",
    target_type: "continuous_normal",
    lock_at: "2026-09-30T14:00:00Z",
    release_at: "2026-10-02T14:00:00Z",
  } as ArenaRound;
  const lock = { round_id: round.round_id, answer_history: history };
  const snap = (fetchedAt: string, days: Array<[string, number]>) => ({
    choices: ["Approve", "Disapprove", "Neither approve nor disapprove"],
    fetched_at: fetchedAt,
    points: days.map(([d, net]) => [d, 40, 40 - net, 20]),
  });
  const files: Record<string, unknown> = {
    "civiqs/approve_president_trump_2025/2026-09-29.json": snap("2026-09-29T16:00:00Z", [
      ["2026-09-24", -27],
      ["2026-09-25", -26],
      ["2026-09-26", -25],
      ["2026-09-27", -24],
      ["2026-09-28", -22],
    ]),
    // Fetched after the lock: never read.
    "civiqs/approve_president_trump_2025/2026-09-30.json": snap("2026-09-30T16:00:00Z", [
      ["2026-09-29", -10],
    ]),
  };
  const data = new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
  const centre = async (c: string) =>
    (await applySignal({ centre: c, spread: "baseline" }, round, lock, data)).mean;

  it("validates the nowcast-mean window", () => {
    expect(validateSignal({ centre: "nowcast-mean:3", spread: "baseline" })).toBeUndefined();
    expect(validateSignal({ centre: "nowcast-mean:1", spread: "baseline" })).toContain("2–7");
    expect(validateSignal({ centre: "nowcast-mean:8", spread: "baseline" })).toContain("2–7");
  });

  it("reads only the snapshot fetched before the lock", async () => {
    expect(await centre("nowcast")).toBe(-22);
    // shrink: last weekly value + w × (nowcast − it)
    expect(await centre("nowcast-shrink:0.75")).toBe(-23);
    // mean of the snapshot's last k daily readings (revised values, newest last)
    expect(await centre("nowcast-mean:3")).toBeCloseTo(-23.667, 3);
    expect(await centre("nowcast-mean:7")).toBe(-24.8);
  });

  it("falls back to the last weekly value when no fresher reading exists", async () => {
    const empty = new ArenaData(
      "https://example.test",
      async () => new Response("", { status: 404 }),
    );
    const f = await applySignal({ centre: "nowcast-mean:3", spread: "arena" }, round, lock, empty);
    expect(f.mean).toBe(-26);
  });
});

describe("discovery loop", () => {
  const DB = `test_arena_discovery_${process.pid}.db`;
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  // Ten weekly rounds of a series that trends up by 1 a week: `trend` beats persistence.
  const rounds: ArenaRound[] = [];
  const files: Record<string, unknown> = {};
  const resolved: Record<string, { value: number }> = {};
  for (let w = 0; w < 10; w++) {
    const history = weekly(Array.from({ length: 20 + w }, (_, i) => i));
    const id = `demo-2026-w${10 + w}`;
    const r = {
      round_id: id,
      tracker: "demo",
      question: "?",
      target_type: "continuous_normal",
      lock_at: new Date(Date.parse("2026-06-01T14:00:00Z") + w * 7 * 86_400_000).toISOString(),
      release_at: new Date(Date.parse(history.at(-1)!.date) + 7 * 86_400_000).toISOString(),
    } as ArenaRound;
    rounds.push(r);
    files[`locks/${id}.json`] = { round_id: id, answer_history: history };
    resolved[id] = { value: history.at(-1)!.value + 1 };
  }
  files["questions/season0.json"] = { rounds };
  files["resolutions/resolved.json"] = resolved;
  const data = new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });

  it("promotes a signal that wins on the holdout, never shows the proposer a holdout score, and remembers every attempt", async () => {
    let prompt = "";
    const out = await discover({
      data,
      notes: db,
      tracker: "demo",
      propose: async (p) => {
        prompt = p;
        return JSON.stringify({
          signals: [
            { centre: "trend:6", spread: "scale:0.5", rationale: "it trends" },
            { centre: "trend:6", spread: "scale:0.5", rationale: "again" },
            { centre: "rm -rf", spread: "arena" },
            { centre: "ewma:0.1", spread: "baseline", rationale: "smooth" },
          ],
        });
      },
    });
    const verdicts = out.records.map((r) => r.verdict);
    expect(verdicts).toEqual(["promoted", "duplicate", "invalid", "rejected"]);
    expect(prompt).not.toMatch(/holdout (skill|score)/i);
    expect(prompt).toContain("older part");
    // Only scored attempts are kept, and the next prompt lists them.
    expect(pastAttempts(db, "demo").map((a) => a.verdict)).toEqual(["promoted", "rejected"]);
    expect(promotedSignals(db).get("demo")?.spec.centre).toBe("trend:6");
    let second = "";
    await discover({
      data,
      notes: db,
      tracker: "demo",
      propose: async (p) => {
        second = p;
        return '{"signals": []}';
      },
    });
    expect(second).toContain("centre trend:6, spread scale:0.5");
  });

  it("raises the bar as more signals are tried", () => {
    expect(promotionMargin(0)).toBeCloseTo(0.02, 6);
    expect(promotionMargin(7)).toBeCloseTo(0.05, 6);
  });

  it("refuses to split a family with too few clean rounds", async () => {
    const tiny = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      if (path === "questions/season0.json") return Response.json({ rounds: rounds.slice(0, 3) });
      if (path === "resolutions/resolved.json") return Response.json(resolved);
      return new Response("", { status: 404 });
    });
    const out = await discover({
      data: tiny,
      notes: db,
      tracker: "demo",
      propose: async () => "{}",
    });
    expect(out.records).toHaveLength(0);
    expect(out.note).toContain("too few");
  });
});
