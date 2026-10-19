// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  anchorGuardModeFromEnv,
  anchorReferenceFromSite,
  checkAnchor,
  filedAnchorCheck,
  reanchorForecast,
  roundingTolerance,
  sameReading,
} from "../src/arena/anchor";
import { arenaConfigFromEnv } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import type { Forecaster } from "../src/arena/evaluate";
import { filingFindings } from "../src/arena/filing-watch";
import { loadPrivateKey } from "../src/arena/protocol";
import { dueRounds, submitRound } from "../src/arena/submit";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const scalar = (id: string, series: string, lockAt = "2026-10-11T14:00:00Z"): ArenaRound => ({
  round_id: id,
  tracker: "economist_yougov",
  series,
  question: "Approve?",
  target_type: "continuous_normal",
  lock_at: lockAt,
  release_at: "2026-10-13T14:00:00Z",
});

const profileRound: ArenaRound = {
  round_id: "civiqs-profile-2026-w42",
  tracker: "civiqs",
  series: "civiqs_net_approval",
  question: "Profile?",
  target_type: "profile_energy",
  cells: ["cell_a", "cell_b"],
  lock_at: "2026-10-11T22:00:00Z",
  release_at: "2026-10-13T22:00:00Z",
};

describe("anchor comparison", () => {
  it("tolerates the arena's rounding: integers within 0.5, one decimal within 0.05", () => {
    expect(roundingTolerance(38)).toBeCloseTo(0.5);
    expect(roundingTolerance(-26.7)).toBeCloseTo(0.05);
    expect(sameReading(37.6, 38)).toBe(true);
    expect(sameReading(38.5, 38)).toBe(true);
    expect(sameReading(37.4, 38)).toBe(false);
    expect(sameReading(-26.74, -26.7)).toBe(true);
    expect(sameReading(-26.8, -26.7)).toBe(false);
  });

  it("an older release with a different value is stale; a newer Marina reading is not", () => {
    const round = scalar("r", "yougov_rv_approval");
    const ref = { yougov_rv_approval: { value: 38, date: "2026-10-03" } };
    const stale = checkAnchor(
      round,
      { yougov_rv_approval: { value: 36, date: "2026-09-26" } },
      ref,
    );
    expect(stale.stale).toBe(true);
    expect(stale.items[0]!.verdict).toBe("stale");
    // Same value, rounded or not, whatever the dates: fresh.
    for (const value of [38, 37.6]) {
      expect(
        checkAnchor(round, { yougov_rv_approval: { value, date: "2026-09-26" } }, ref).stale,
      ).toBe(false);
    }
    // A daily source ahead of the arena's refresh (or the same day, read elsewhere): not stale.
    const newer = checkAnchor(
      round,
      { yougov_rv_approval: { value: 39, date: "2026-10-05" } },
      ref,
    );
    expect(newer.stale).toBe(false);
    expect(newer.items[0]!.verdict).toBe("newer");
    // No reference: unchecked, never stale.
    expect(checkAnchor(round, { yougov_rv_approval: { value: 36 } }, undefined)).toMatchObject({
      stale: false,
      unchecked: ["yougov_rv_approval"],
    });
  });

  it("compares profile rounds per cell and re-anchors only the stale cells", () => {
    const ref = {
      cell_a: { value: -95.9, date: "2026-10-09" },
      cell_b: { value: 63.5, date: "2026-10-09" },
    };
    const check = checkAnchor(
      profileRound,
      {
        cell_a: { value: -95.92, date: "2026-10-02" },
        cell_b: { value: 61.5, date: "2026-10-02" },
      },
      ref,
    );
    expect(check.stale).toBe(true);
    expect(check.items.map((i) => [i.id, i.verdict])).toEqual([
      ["cell_a", "fresh"],
      ["cell_b", "stale"],
    ]);
    const { forecast, reanchored } = reanchorForecast(
      {
        profile: { cell_a: { mean: -95, sd: 2 }, cell_b: { mean: 62, sd: 3 } },
        rules: {},
        note: "fixture",
      },
      profileRound,
      check,
    );
    expect(forecast.profile).toEqual({ cell_a: { mean: -95, sd: 2 }, cell_b: { mean: 64, sd: 3 } });
    expect(Object.keys(reanchored)).toEqual(["cell_b"]);
  });

  it("skips ranking rounds: no comparable value", () => {
    const ranking: ArenaRound = {
      ...scalar("wiki", "wiki_top10_en"),
      target_type: "ranking_list",
    };
    expect(checkAnchor(ranking, {}, { wiki_top10_en: { value: 1 } })).toEqual({
      stale: false,
      items: [],
      unchecked: [],
    });
    expect(anchorReferenceFromSite({ rounds: [{ round_id: "wiki" }] }, ranking)).toBeUndefined();
  });

  it("reads the arena's persistence values and dates them only from a matching series tail", () => {
    const site = {
      rounds: [
        { round_id: "r", baselines: { persistence: { mean: 38 } } },
        {
          round_id: profileRound.round_id,
          baselines: null,
          profile: {
            baselines: { persistence: { cell_a: { mean: -95.9 }, cell_b: { mean: 63.5 } } },
          },
        },
      ],
      series_tail: {
        yougov_rv_approval: [
          { date: "2026-09-26", value: 36 },
          { date: "2026-10-03", value: 38 },
        ],
        cell_a: [{ date: "2026-10-09", value: -95.9 }],
        cell_b: [{ date: "2026-10-09", value: 60 }],
      },
    };
    expect(anchorReferenceFromSite(site, scalar("r", "yougov_rv_approval"))).toEqual({
      yougov_rv_approval: { value: 38, date: "2026-10-03" },
    });
    expect(anchorReferenceFromSite(site, profileRound)).toEqual({
      cell_a: { value: -95.9, date: "2026-10-09" },
      cell_b: { value: 63.5 },
    });
  });

  it("parses MARINA_ARENA_ANCHOR_GUARD (default on)", () => {
    expect(anchorGuardModeFromEnv({})).toBe("on");
    expect(anchorGuardModeFromEnv({ MARINA_ARENA_ANCHOR_GUARD: "observe" })).toBe("observe");
    expect(anchorGuardModeFromEnv({ MARINA_ARENA_ANCHOR_GUARD: " OFF " })).toBe("off");
    expect(anchorGuardModeFromEnv({ MARINA_ARENA_ANCHOR_GUARD: "junk" })).toBe("on");
  });

  it("dates a legacy filing (no stored inputs) against the arena's latest release", () => {
    const round = scalar("r", "yougov_rv_approval");
    const ref = { yougov_rv_approval: { value: 38, date: "2026-10-03" } };
    const filing = (mean: number, at: string) => ({
      body: JSON.stringify({ topline: { mean, sd: 1.5 } }),
      detail: "{}",
      created_at: Date.parse(at),
    });
    expect(filedAnchorCheck(round, filing(36, "2026-09-30T15:30:22Z"), ref)?.stale).toBe(true);
    expect(filedAnchorCheck(round, filing(38, "2026-09-30T15:30:22Z"), ref)?.stale).toBe(false);
    expect(filedAnchorCheck(round, filing(36, "2026-10-05T12:00:00Z"), ref)?.stale).toBe(false);
  });
});

/**
 * Regression: yougov-2026-w42-rv-approval / -strong-approval were filed on
 * 2026-09-30 at 36 / 18, never refiled, and locked against the arena's
 * persistence of 38 / 21 (skill −2.66 / −1.11).
 */
describe("w42 stale anchor regression", () => {
  const DB = `test_arena_anchor_${process.pid}.db`;
  const ENTRANT = "marina-test";
  const key = loadPrivateKey(Buffer.alloc(32, 7));
  const config = arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: ENTRANT })!; // 24 h window
  // Two days before the lock: outside the 24 h filing window.
  const now = Date.parse("2026-10-09T12:00:00Z");
  const rv = scalar("yougov-2026-w42-rv-approval", "yougov_rv_approval");
  const strong = scalar("yougov-2026-w42-strong-approval", "yougov_rv_strong_approval");
  const weeks = (values: number[], start: string): ArenaPoint[] =>
    values.map((value, i) => ({
      date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
      value,
    }));
  const OLD = { rv: weeks([35, 36], "2026-09-19"), strong: weeks([19, 18], "2026-09-19") };
  const NEW = { rv: weeks([35, 36, 38], "2026-09-19"), strong: weeks([19, 18, 21], "2026-09-19") };
  const lockOf = (round: ArenaRound, history: ArenaPoint[]): ArenaLock => ({
    round_id: round.round_id,
    series: round.series,
    answer_history: history,
  });
  const site = {
    rounds: [
      { round_id: rv.round_id, baselines: { persistence: { mean: 38, sd: 1.5 } } },
      { round_id: strong.round_id, baselines: { persistence: { mean: 21, sd: 1.5 } } },
    ],
    series_tail: { yougov_rv_approval: NEW.rv, yougov_rv_strong_approval: NEW.strong },
  };
  /** Persistence: the last value Marina's inputs saw, sd 1.5. */
  const persistence: Forecaster = async (_round, lock) => {
    const last = lock.answer_history!.at(-1)!;
    return { topline: { mean: last.value, sd: 1.5 }, rules: {}, note: "persistence fixture" };
  };

  let db: MarinaDB;
  let posts: Array<{ body: string }>;
  let files: Record<string, unknown>;
  /** The lock files served once `refresh()` drops the cache (the arena's fresher copy). */
  let afterRefresh: Record<string, unknown> | undefined;
  let reads: number;
  let data: ArenaData;

  const deps = (extra: Record<string, unknown> = {}) => ({
    config,
    data,
    store: db,
    key,
    now: () => now,
    forecaster: persistence,
    anchorGuard: "on" as const,
    post: async (_url: string, init: RequestInit) => {
      posts.push({ body: String(init.body) });
      return Response.json({ status: "accepted" }, { status: 201 });
    },
    ...extra,
  });
  const fileAccepted = (round: ArenaRound, history: ArenaPoint[]) => {
    const id = db.insertArenaSubmission({
      entrant: ENTRANT,
      roundId: round.round_id,
      requestId: crypto.randomUUID(),
      url: config.origin,
      meta: "{}",
      body: JSON.stringify({
        round_id: round.round_id,
        entrant: ENTRANT,
        topline: { mean: history.at(-1)!.value, sd: 1.5 },
        notes: "persistence fixture",
      }),
      detail: JSON.stringify({ round, lock: lockOf(round, history), forecast: { rules: {} } }),
    });
    db.updateArenaSubmission(id, { status: "accepted", httpStatus: 201 });
  };
  const references = async () =>
    new Map(
      await Promise.all(
        [rv, strong].map(async (r) => [r.round_id, (await data.anchorReference(r))!] as const),
      ),
    );
  const lastAttempt = (roundId: string) =>
    db.listArenaAttempts({ entrant: ENTRANT, roundId, limit: 1 })[0]!;

  beforeEach(() => {
    db = new MarinaDB(DB);
    posts = [];
    reads = 0;
    afterRefresh = undefined;
    files = {
      "questions/season0.json": { rounds: [rv, strong] },
      "site/data.json": site,
      [`locks/${rv.round_id}.json`]: lockOf(rv, OLD.rv),
      [`locks/${strong.round_id}.json`]: lockOf(strong, OLD.strong),
    };
    data = new ArenaData(
      "https://example.test/arena",
      async (url) => {
        const path = url.replace("https://example.test/arena/", "");
        reads++;
        return path in files ? Response.json(files[path]) : new Response("nope", { status: 404 });
      },
      () => now,
    );
    const refresh = data.refresh.bind(data);
    data.refresh = () => {
      if (afterRefresh) files = { ...files, ...afterRefresh };
      refresh();
    };
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("finds the stale filings outside the window, alerts, and refiles them on the arena's 38 / 21", async () => {
    fileAccepted(rv, OLD.rv);
    fileAccepted(strong, OLD.strong);

    // The watch flags both long before the lock (the old watch only looked inside 24 h).
    const findings = filingFindings([rv, strong], db, ENTRANT, now, await references());
    expect(findings.map((f) => [f.roundId, f.problem, f.severity])).toEqual([
      [rv.round_id, "stale-anchor", "warning"],
      [strong.round_id, "stale-anchor", "warning"],
    ]);
    expect(findings[0]!.detail).toContain("anchored on 36");

    // Plain `due` is unchanged (window only); `due --replace` adds the stale filings.
    expect(await dueRounds(deps())).toEqual([]);
    expect((await dueRounds(deps(), { includeAccepted: true })).map((r) => r.round_id)).toEqual([
      rv.round_id,
      strong.round_id,
    ]);

    // Inputs still stale after one re-read: re-anchored on the arena's value, never filed at 36 / 18.
    for (const [round, mean] of [
      [rv, 38],
      [strong, 21],
    ] as const) {
      const before = reads;
      const out = await submitRound(deps(), round.round_id, { replace: true });
      expect(out.kind).toBe("accepted");
      expect(out.anchor?.status).toBe("reanchored");
      expect(reads).toBeGreaterThan(before); // the inputs were fetched again
      expect(JSON.parse(posts.at(-1)!.body).topline.mean).toBe(mean);
      expect(lastAttempt(round.round_id)).toMatchObject({ status: "stale_anchor" });
      expect(JSON.parse(lastAttempt(round.round_id).detail).reason).toContain("re-anchored");
    }
    expect(posts).toHaveLength(2);

    // The refiled filings carry the arena's anchor: no longer stale, not due again.
    const after = filingFindings([rv, strong], db, ENTRANT, now, await references());
    expect(after.filter((f) => f.problem === "stale-anchor")).toEqual([]);
    expect(await dueRounds(deps(), { includeAccepted: true })).toEqual([]);
    // Inside the last 24 h the stale_anchor attempt still raises the alert (inputs are behind).
    const late = Date.parse(rv.lock_at) - 3 * 3_600_000;
    expect(
      filingFindings([rv], db, ENTRANT, late, await references()).map((f) => f.problem),
    ).toContain("stale-anchor");
  });

  it("uses the fresh inputs when one re-read finds them", async () => {
    fileAccepted(rv, OLD.rv);
    afterRefresh = { [`locks/${rv.round_id}.json`]: lockOf(rv, NEW.rv) };
    const out = await submitRound(deps(), rv.round_id, { replace: true });
    expect(out).toMatchObject({ kind: "accepted", anchor: { status: "refetched" } });
    expect(JSON.parse(posts[0]!.body).topline.mean).toBe(38);
    expect(lastAttempt(rv.round_id).status).toBe("accepted");
  });

  it("leaves a fresh filing untouched", async () => {
    files[`locks/${rv.round_id}.json`] = lockOf(rv, NEW.rv);
    fileAccepted(rv, NEW.rv);
    expect(filingFindings([rv], db, ENTRANT, now, await references())).toEqual([]);
    expect(await dueRounds(deps(), { includeAccepted: true })).toEqual([]);
    // Inside the window the refresh runs, finds the same forecast, and sends nothing.
    const inWindow = Date.parse(rv.lock_at) - 3 * 3_600_000;
    const out = await submitRound({ ...deps(), now: () => inWindow }, rv.round_id, {
      replace: true,
    });
    expect(out).toMatchObject({ kind: "accepted", already: true, anchor: { status: "fresh" } });
    expect(posts).toHaveLength(0);
    expect(lastAttempt(rv.round_id).status).toBe("unchanged");
  });

  it("observe records a stale anchor without changing the filing; off skips the check", async () => {
    const observed = await submitRound(deps({ anchorGuard: "observe" }), rv.round_id, {
      early: true,
    });
    expect(observed).toMatchObject({ kind: "accepted", anchor: { status: "stale" } });
    expect(JSON.parse(posts[0]!.body).topline.mean).toBe(36);
    expect(lastAttempt(rv.round_id).status).toBe("stale_anchor");

    const off = await submitRound(deps({ anchorGuard: "off" }), strong.round_id, { early: true });
    expect(off.kind).toBe("accepted");
    expect(off.anchor).toBeUndefined();
    expect(await dueRounds(deps({ anchorGuard: "off" }), { includeAccepted: true })).toEqual([]);
  });

  it("an unreadable arena reference never blocks a filing", async () => {
    delete files["site/data.json"];
    const out = await submitRound(deps(), rv.round_id, { early: true });
    expect(out).toMatchObject({ kind: "accepted", anchor: { status: "unchecked" } });
    expect(JSON.parse(posts[0]!.body).topline.mean).toBe(36);
  });
});
