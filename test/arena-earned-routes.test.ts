// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import {
  arenaRouteMinN,
  arenaRoutingModeFromEnv,
  chooseArenaRoute,
  loadRouteEvidence,
  parseShadowChallengers,
  type RouteEvidence,
} from "../src/arena/earned-routes";
import { isPinned, parseRoutes } from "../src/arena/routing";
import { forecasterFor } from "../src/arena/service";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";
import type { ArenaShadowRow, ArenaSubmissionRow } from "../src/persistence/db-arena";

const DELPHI = "formation:delphi:openrouter/vendor/model-a,openrouter/vendor/model-b";
const NOW = Date.parse("2026-10-14T00:00:00Z");

/** `n` rounds where `spec` scores `skill` (and the default `base`). */
function evidence(
  family: string,
  rows: Array<{ spec: string; source: "filed" | "shadow"; skills: number[] }>,
  visibleAt = NOW - 86_400_000,
): RouteEvidence[] {
  return rows.flatMap(({ spec, source, skills }) =>
    skills.map((skill, i) => ({
      roundId: `${family}-r${i}`,
      family,
      source,
      spec,
      skill,
      visibleAt,
    })),
  );
}

const base = { family: "civiqs", now: NOW, mode: "on" as const, minN: 8 };

describe("earned arena routes", () => {
  it("pins with `!` (and `skip`), and every other route is a default", () => {
    const routes = parseRoutes("route:civiqs=!nowcast;aaii=baseline;yougov=skip;*=nowcast");
    expect(routes.byFamily.get("civiqs")).toBe("nowcast");
    expect(isPinned(routes, "civiqs")).toBe(true);
    expect(isPinned(routes, "aaii")).toBe(false);
    expect(isPinned(routes, "yougov")).toBe(true);
    expect(isPinned(routes, "trends")).toBe(false);
    expect(isPinned(parseRoutes("route:*=!baseline"), "trends")).toBe(true);
    expect(arenaRoutingModeFromEnv({})).toBe("on");
    expect(arenaRoutingModeFromEnv({ MARINA_ARENA_ROUTING: "observe" })).toBe("observe");
    expect(arenaRouteMinN({})).toBe(8);
    expect(arenaRouteMinN({ MARINA_ARENA_ROUTE_MIN_N: "3" })).toBe(8);
    expect(arenaRouteMinN({ MARINA_ARENA_ROUTE_MIN_N: "12" })).toBe(12);
  });

  it("keeps the default without paired evidence", () => {
    const d = chooseArenaRoute({ ...base, defaultSpec: DELPHI, evidence: [] });
    expect(d.chosen).toBe(DELPHI);
    expect(d.reason).toContain("no challenger on record");
    const few = evidence("civiqs", [
      { spec: DELPHI, source: "filed", skills: [0.1, 0.1, 0.1] },
      { spec: "nowcast", source: "shadow", skills: [0.9, 0.9, 0.9] },
    ]);
    const f = chooseArenaRoute({ ...base, defaultSpec: DELPHI, evidence: few });
    expect(f.chosen).toBe(DELPHI);
    expect(f.challengers[0]).toMatchObject({ id: "nowcast", n: 3, verdict: "too few paired" });
  });

  it("promotes a challenger only on a clear paired held-out gain", () => {
    const n = 12;
    const wins = evidence("civiqs", [
      // A model upgrade keeps the incumbent's record: filings match by kind.
      {
        spec: "formation:delphi:openrouter/vendor/old-model",
        source: "filed",
        skills: Array.from({ length: n }, (_, i) => 0.1 + (i % 3) * 0.01),
      },
      { spec: "nowcast", source: "shadow", skills: Array.from({ length: n }, () => 0.5) },
    ]);
    const on = chooseArenaRoute({ ...base, defaultSpec: DELPHI, evidence: wins });
    expect(on.incumbentN).toBe(n);
    expect(on.chosen).toBe("nowcast");
    expect(on.reason).toContain("nowcast beat the default");
    const observe = chooseArenaRoute({
      ...base,
      mode: "observe",
      defaultSpec: DELPHI,
      evidence: wins,
    });
    expect(observe.picked).toBe("nowcast");
    expect(observe.chosen).toBe(DELPHI);
    // Pinned: never replaced.
    const pinned = chooseArenaRoute({ ...base, defaultSpec: DELPHI, evidence: wins, pinned: true });
    expect(pinned.chosen).toBe(DELPHI);
    expect(pinned.pinned).toBe(true);
    // Outcomes not yet public at the decision are invisible.
    const future = wins.map((e) => ({ ...e, visibleAt: NOW + 1 }));
    expect(chooseArenaRoute({ ...base, defaultSpec: DELPHI, evidence: future }).chosen).toBe(
      DELPHI,
    );
    // Another family's evidence never counts.
    const elsewhere = wins.map((e) => ({ ...e, family: "aaii" }));
    expect(chooseArenaRoute({ ...base, defaultSpec: DELPHI, evidence: elsewhere }).chosen).toBe(
      DELPHI,
    );
  });

  it("refuses a challenger that is not better, and ignores unrunnable specs", () => {
    const mixed = evidence("civiqs", [
      { spec: DELPHI, source: "shadow", skills: Array.from({ length: 10 }, (_, i) => i / 10) },
      {
        spec: "baseline",
        source: "shadow",
        skills: Array.from({ length: 10 }, (_, i) => (i % 2 ? 0.95 : -0.05)),
      },
      { spec: "civiqs-sd:x0.7", source: "shadow", skills: Array.from({ length: 10 }, () => 2) },
    ]);
    const d = chooseArenaRoute({ ...base, defaultSpec: DELPHI, evidence: mixed });
    expect(d.chosen).toBe(DELPHI);
    expect(d.challengers.map((c) => c.id)).toEqual(["baseline"]);
    expect(d.challengers[0]!.verdict).toBe("not better");
  });

  it("parses operator-listed shadow challengers and refuses junk", () => {
    const m = parseShadowChallengers({
      MARINA_ARENA_SHADOW_CHALLENGERS: `civiqs=nowcast|${DELPHI};aaii=baseline`,
    });
    expect(m.get("civiqs")).toEqual(["nowcast", DELPHI]);
    expect(m.get("aaii")).toEqual(["baseline"]);
    expect(parseShadowChallengers({}).size).toBe(0);
    expect(() => parseShadowChallengers({ MARINA_ARENA_SHADOW_CHALLENGERS: "civiqs=gpt" })).toThrow(
      "not a forecaster spec",
    );
    expect(() =>
      parseShadowChallengers({ MARINA_ARENA_SHADOW_CHALLENGERS: "civiqs=routed" }),
    ).toThrow("not a forecaster spec");
  });
});

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("earned routes in the routed forecaster and the evidence reader", () => {
  const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 2)));
  const round: ArenaRound = {
    round_id: "aaii-live",
    tracker: "aaii",
    question: "?",
    target_type: "continuous_normal",
    lock_at: "2099-07-20T14:00:00Z",
    release_at: "2099-07-24T14:00:00Z",
  };
  const lock = { round_id: round.round_id, answer_history: history };
  const env = { MARINA_ARENA_CIVIQS_LIVE: "off" };
  const winning = evidence("aaii", [
    { spec: "nowcast", source: "filed", skills: Array.from({ length: 12 }, () => 0.05) },
    { spec: "baseline", source: "shadow", skills: Array.from({ length: 12 }, () => 0.6) },
  ]);

  it("answers with the earned challenger, records the decision, and falls open", async () => {
    const earned = await forecasterFor("route:aaii=nowcast;*=nowcast", {
      env,
      routeEvidence: async () => winning,
    });
    const f = await earned.forecaster(round, lock);
    expect(f.note).toContain("route aaii → baseline");
    expect(f.routing).toMatchObject({ default: "nowcast", chosen: "baseline", mode: "on" });

    const observe = await forecasterFor("route:aaii=nowcast;*=nowcast", {
      env: { ...env, MARINA_ARENA_ROUTING: "observe" },
      routeEvidence: async () => winning,
    });
    const o = await observe.forecaster(round, lock);
    expect(o.note).toContain("route aaii → nowcast");
    expect(o.routing).toMatchObject({ picked: "baseline", chosen: "nowcast" });

    const pinned = await forecasterFor("route:aaii=!nowcast;*=nowcast", {
      env,
      routeEvidence: async () => winning,
    });
    expect((await pinned.forecaster(round, lock)).note).toContain("route aaii → nowcast");

    const broken = await forecasterFor("route:aaii=nowcast;*=nowcast", {
      env,
      routeEvidence: async () => {
        throw new Error("db gone");
      },
    });
    const b = await broken.forecaster(round, lock);
    expect(b.note).toContain("route aaii → nowcast");
    expect(b.routing?.reason).toContain("evidence unreadable (db gone)");

    const off = await forecasterFor("route:aaii=nowcast;*=nowcast", {
      env: { ...env, MARINA_ARENA_ROUTING: "off" },
      routeEvidence: async () => winning,
    });
    const x = await off.forecaster(round, lock);
    expect(x.note).toContain("route aaii → nowcast");
    expect(x.routing).toBeUndefined();
  });

  it("reads the scored filing per round and runnable shadows, never leaked rounds", async () => {
    const mk = (id: string, tracker: string, lockAt: string): ArenaRound => ({
      round_id: id,
      tracker,
      question: "?",
      target_type: "continuous_normal",
      lock_at: lockAt,
      release_at: lockAt.replace("14:00", "18:00"),
    });
    const ok = mk("aaii-r1", "aaii", "2026-07-20T14:00:00Z");
    const leaked = mk("civiqs-r1", "civiqs", "2026-07-20T14:00:00Z");
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [ok, leaked] },
      "resolutions/resolved.json": {
        "aaii-r1": { value: 41.5, resolved_at: "2026-07-24T20:00:00Z" },
        // Observed two days before its lock: public before the lock.
        "civiqs-r1": { value: 41.5, observed_date: "2026-07-17" },
      },
      "locks/aaii-r1.json": { round_id: "aaii-r1", answer_history: history },
      "locks/civiqs-r1.json": { round_id: "civiqs-r1", answer_history: history },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const before = Date.parse("2026-07-19T00:00:00Z");
    const sub = (id: number, roundId: string, mean: number, notes: string, status = "accepted") =>
      ({
        id,
        round_id: roundId,
        status,
        created_at: before + id,
        body: JSON.stringify({ round_id: roundId, topline: { mean, sd: 1 }, notes }),
      }) as unknown as ArenaSubmissionRow;
    const shadow = (id: number, roundId: string, forecaster: string) =>
      ({
        id,
        round_id: roundId,
        forecaster,
        forecast: JSON.stringify({ topline: { mean: 41.5, sd: 0.5 } }),
        detail: "{}",
        cost_usd: 0,
        created_at: before,
      }) as ArenaShadowRow;
    const store = {
      // Newest first, as the store returns them: the newest accepted is the scored one.
      listArenaSubmissions: () => [
        sub(3, "aaii-r1", 41.4, `route aaii → ${DELPHI}; delphi`),
        sub(2, "aaii-r1", 30, "route aaii → nowcast; old"),
        sub(1, "civiqs-r1", 41, "route civiqs → nowcast; x"),
      ],
      listArenaShadow: () => [
        shadow(10, "aaii-r1", "baseline#0123456789abcdef"),
        shadow(11, "aaii-r1", "civiqs-sd:x0.7"),
        shadow(12, "civiqs-r1", "baseline#0123456789abcdef"),
      ],
    };
    const ev = await loadRouteEvidence(store, data, "h2oai-marina");
    expect(ev.map((e) => [e.roundId, e.source, e.spec]).sort()).toEqual(
      [
        ["aaii-r1", "filed", DELPHI],
        ["aaii-r1", "shadow", "baseline"],
      ].sort(),
    );
    expect(ev[0]!.visibleAt).toBe(Date.parse("2026-07-24T20:00:00Z"));
    expect(ev.every((e) => Number.isFinite(e.skill))).toBe(true);
  });
});
