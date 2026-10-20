// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shadow challengers (src/forecast/shadow.ts): sampling and caps, the
 * `eval_mode` filing with its tags, settlement with the live answer on the one
 * outcome path, pairing in card evidence, leak isolation at a past cutoff,
 * and that the live answer never changes. Also the read-only route view
 * (src/forecast/route-view.ts) and FutureX's earned live default.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type BatchRun, describeEarned, runBatch, type Variant } from "../benchmarks/futurex/run";
import { saveAnswer, saveTypedAnswer } from "../src/engine/commands/forecast";
import { currentEvidenceCutoff, withEvidenceCutoff } from "../src/engine/evidence-fence";
import type { AnswerSpec } from "../src/forecast/answer-types";
import {
  type CardEvidence,
  evidenceFromOutcomes,
  forecastCarded,
} from "../src/forecast/card-routing";
import { forecastFormed } from "../src/forecast/formations";
import { recipeCard } from "../src/forecast/method-cards";
import {
  arenaRouteRows,
  forecastRouteRows,
  loadRouteView,
  renderRouteView,
} from "../src/forecast/route-view";
import { routeSettingsFromEnv } from "../src/forecast/routing";
import { outcomeRefs, SHADOW_OWNER, shadowExternalId } from "../src/forecast/routing-refs";
import {
  drainForecastShadows,
  pickShadowCard,
  planForecastShadow,
  shadowGate,
  shadowIsolation,
  shadowSettingsFromEnv,
  shadowUsage,
  startForecastShadow,
} from "../src/forecast/shadow";
import { plainFromTyped } from "../src/forecast/surface";
import type { ModelPart, TypedForecastDeps, TypedForecastRequest } from "../src/forecast/typed";
import { resolveForecast } from "../src/outcomes/forecast";
import { MarinaDB } from "../src/persistence/database";

const yesNo: AnswerSpec = {
  type: "choice",
  options: [{ id: "Yes" }, { id: "No" }],
  probabilities: true,
};
const NOW = new Date("2026-10-05T00:00:00Z");

const part = (name: string, reply: (system: string) => string): ModelPart => ({
  name,
  complete: async (s) => reply(s),
});
const planner = part("planner", (system) => {
  if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q"]}';
  if (system.startsWith("You review a research dossier")) return '{"done":true}';
  return '{"verdict":"keep"}';
});
const analyst = (name: string, p: number) =>
  part(name, () =>
    JSON.stringify({
      answer: p >= 0.5 ? "Yes" : "No",
      probabilities: { Yes: p, No: 1 - p },
      reason: `${name} reason`,
    }),
  );
let briefs: Array<{ until?: string }> = [];
const retriever = async (brief: { until?: string }) => {
  briefs.push(brief);
  return {
    report: "- 2026-09-20 — a fact ([src](https://example.org/1))",
    sources: [{ url: "https://example.org/1" }],
    costUsd: 0,
    searches: 1,
    retriever: "fake",
  };
};
const deps = (): TypedForecastDeps => ({
  retriever: retriever as TypedForecastDeps["retriever"],
  analysts: [analyst("m1", 0.7), analyst("m2", 0.6)],
  planner,
  critic: planner,
  now: () => NOW,
  options: { runs: 2, researchRounds: 1 },
});
const ON = { MARINA_FORECAST_SHADOW: "1" } as NodeJS.ProcessEnv;
/** The plain pipeline's yes/no (`plainForecastFor`): lower-case ids. */
const plainYesNo: AnswerSpec = {
  type: "choice",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  probabilities: true,
};
const yesNoAnalyst = (name: string, p: number) =>
  part(name, () =>
    JSON.stringify({
      answer: p >= 0.5 ? "yes" : "no",
      probabilities: { yes: p, no: 1 - p },
      reason: "r",
    }),
  );

/** A live typed answer through card routing (no evidence: the default card answers). */
async function liveAnswer(req: TypedForecastRequest) {
  const answer = await forecastCarded(req, deps(), "ensemble", routeSettingsFromEnv({}), {
    env: {},
    featureProviders: [],
  });
  answer.costUsd = 0.05;
  return answer;
}

describe("settings, sampling and caps", () => {
  it("off by default; a fraction turns it on, with per-day count and spend caps", () => {
    expect(shadowSettingsFromEnv({})).toBeUndefined();
    expect(shadowSettingsFromEnv({ MARINA_FORECAST_SHADOW: "off" })).toBeUndefined();
    expect(shadowSettingsFromEnv({ MARINA_FORECAST_SHADOW: "junk" })).toBeUndefined();
    expect(shadowSettingsFromEnv({ MARINA_FORECAST_SHADOW: "0" })).toBeUndefined();
    expect(shadowSettingsFromEnv({ MARINA_FORECAST_SHADOW: "0.2" })).toEqual({
      rate: 0.2,
      maxPerDay: 10,
      capUsd: 2,
    });
    expect(
      shadowSettingsFromEnv({
        MARINA_FORECAST_SHADOW: "3",
        MARINA_FORECAST_SHADOW_MAX_PER_DAY: "4",
        MARINA_FORECAST_SHADOW_CAP_USD: "0.5",
      }),
    ).toEqual({ rate: 1, maxPerDay: 4, capUsd: 0.5 });
  });

  it("the gate: sampled first, then the day's count and spend (filed + in flight), then the world cap", () => {
    const settings = { rate: 0.25, maxPerDay: 3, capUsd: 1 };
    const base = {
      settings,
      used: { count: 0, spentUsd: 0 },
      pending: { count: 0, reserveUsd: 0 },
      estimateUsd: 0.1,
    };
    expect(shadowGate({ ...base, draw: 0.3 })).toEqual({ run: false, reason: "not sampled" });
    expect(shadowGate({ ...base, draw: 0.1 })).toEqual({ run: true });
    expect(
      shadowGate({
        ...base,
        draw: 0.1,
        used: { count: 2, spentUsd: 0 },
        pending: { count: 1, reserveUsd: 0 },
      }),
    ).toMatchObject({ run: false, reason: expect.stringContaining("count") });
    expect(
      shadowGate({
        ...base,
        draw: 0.1,
        used: { count: 0, spentUsd: 0.8 },
        pending: { count: 0, reserveUsd: 0.15 },
      }),
    ).toMatchObject({ run: false, reason: expect.stringContaining("spend cap") });
    expect(shadowGate({ ...base, draw: 0.1, worldCap: "daily spend cap reached" })).toEqual({
      run: false,
      reason: "daily spend cap reached",
    });
  });

  it("the card: the first explore challenger short of minN; the default when routing answered with another", async () => {
    const live = await liveAnswer({ question: "Will it?", answer: yesNo });
    expect(live.routing.explore[0]).toBe("formation:delphi");
    expect(pickShadowCard(live.routing, 30)?.id).toBe("formation:delphi");
    const full = {
      ...live.routing,
      challengers: [{ id: "formation:delphi", n: 30, verdict: "not better" as const }],
    };
    expect(pickShadowCard(full, 30)?.id).toBe("formation:tournament");
    const routed = { ...live.routing, method: "formation:delphi", picked: "formation:delphi" };
    expect(pickShadowCard(routed, 30)?.id).toBe("formation:ensemble");
    expect(pickShadowCard({ ...live.routing, mode: "off" }, 30)).toBeUndefined();
  });
});

describe("filing and settling on the one outcome path", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    briefs = [];
  });
  afterEach(async () => {
    await drainForecastShadows();
    db.close();
  });

  it("files the challenger eval_mode live with its tags, never changing the live answer; settles with it", async () => {
    const req = { question: "Will it?", answer: yesNo };
    const live = await liveAnswer(req);
    const before = JSON.stringify(live);
    planForecastShadow(live, {
      req,
      deps: deps(),
      routing: live.routing,
      costUsd: () => 0,
      env: ON,
      minN: 30,
    });
    const liveId = saveTypedAnswer(db, "Ada", live)!;
    const stored = db.getForecastAnswer(liveId)!.answer_json;
    const start = startForecastShadow(db, liveId, live, { draw: 0 });
    expect(start).toMatchObject({ started: true, card: "formation:delphi" });
    if (!start.started) throw new Error("not started");
    const done = await start.done;
    expect(done).toMatchObject({ status: "filed", card: "formation:delphi", isolation: "live" });
    // The live answer, in memory and on disk, is untouched.
    expect(JSON.stringify(live)).toBe(before);
    expect(db.getForecastAnswer(liveId)!.answer_json).toBe(stored);
    // A plan runs once.
    expect(startForecastShadow(db, liveId, live, { draw: 0 })).toEqual({
      started: false,
      reason: "no plan",
    });

    const shadow = db.getForecastAnswerByExternalId(SHADOW_OWNER, shadowExternalId(liveId))!;
    expect(shadow).toMatchObject({ source: "shadow", eval_mode: "live", kind: "choice" });
    // Shadows settle with their live answer, never on a judge's call of their own.
    expect(db.openUnlinkedForecasts(10).map((r) => r.id)).toEqual([liveId]);

    const t = Date.parse("2026-10-20T00:00:00Z");
    resolveForecast(db, liveId, { option: "Yes" }, t);
    expect(db.getForecastAnswer(shadow.id)!.resolved_at).toBe(t);
    const rows = db.listOutcomes({ kind: "forecast" });
    expect(rows).toHaveLength(2);
    const sh = rows.find((o) => o.subject === `forecast:${shadow.id}`)!;
    expect(sh.eval_mode).toBe("live");
    expect(sh.owner).toBe(SHADOW_OWNER);
    expect(outcomeRefs(sh.refs_json)).toEqual(
      expect.arrayContaining([
        "shadow",
        "method:formation:delphi",
        "card:formation:delphi",
        "model:m1",
        "family:group:binary:no|yes",
        `pair:forecast:${liveId}`,
      ]),
    );
    // Lessons and history are delivered from it like any other outcome.
    expect(db.pendingOutcomes("lessons", 10).map((o) => o.id)).toContain(sh.id);
    expect(db.pendingOutcomes("history", 10).map((o) => o.id)).toContain(sh.id);
    // The two methods pair on the live answer's subject.
    const ev = evidenceFromOutcomes(rows).filter((e) => e.family === "group:binary:no|yes");
    expect(ev.map((e) => [e.method, e.question]).sort()).toEqual(
      [
        ["formation:delphi", `forecast:${liveId}`],
        ["formation:ensemble", `forecast:${liveId}`],
      ].sort(),
    );
  });

  it("pairs on the asker's question id when there is one", async () => {
    const req = { question: "Will it?", answer: yesNo, id: "q-7" };
    const live = await liveAnswer(req);
    planForecastShadow(live, {
      req,
      deps: deps(),
      routing: live.routing,
      costUsd: () => 0,
      env: ON,
      minN: 30,
    });
    const liveId = saveTypedAnswer(db, "Ada", live)!;
    const start = startForecastShadow(db, liveId, live, { draw: 0 });
    if (!start.started) throw new Error(start.reason);
    await start.done;
    resolveForecast(db, liveId, { option: "No" }, Date.parse("2026-10-20T00:00:00Z"));
    const ev = evidenceFromOutcomes(db.listOutcomes({ kind: "forecast" }));
    expect(new Set(ev.map((e) => e.question))).toEqual(new Set(["q:q-7"]));
  });

  it("a plain probability stays plain, so both are scored on one metric", async () => {
    const req = { question: "Will it?", answer: plainYesNo };
    const plainDeps = () => ({
      ...deps(),
      analysts: [yesNoAnalyst("m1", 0.7), yesNoAnalyst("m2", 0.6)],
    });
    const typed = await forecastCarded(req, plainDeps(), "ensemble", routeSettingsFromEnv({}), {
      env: {},
      featureProviders: [],
    });
    const plain = plainFromTyped("probability", typed);
    planForecastShadow(typed, {
      req,
      deps: plainDeps(),
      routing: typed.routing,
      costUsd: () => 0,
      env: ON,
      minN: 30,
    });
    const liveId = saveAnswer(db, "Ada", plain)!;
    const start = startForecastShadow(db, liveId, plain, { draw: 0 });
    if (!start.started) throw new Error(start.reason);
    await start.done;
    const shadow = db.getForecastAnswerByExternalId(SHADOW_OWNER, shadowExternalId(liveId))!;
    expect(shadow.kind).toBe("probability");
    expect(shadow.probability).toBeGreaterThan(0);
    resolveForecast(db, liveId, { outcome: "yes" }, Date.parse("2026-10-20T00:00:00Z"));
    const metrics = db.listOutcomes({ kind: "forecast" }).map((o) => o.metric);
    expect(metrics).toEqual(["brier", "brier"]);
  });

  it("no shadow when not sampled, off, over the day's count, or for a measurement filing", async () => {
    const req = { question: "Will it?", answer: yesNo };
    const plan = async (env = ON) => {
      const live = await liveAnswer(req);
      planForecastShadow(live, {
        req,
        deps: deps(),
        routing: live.routing,
        costUsd: () => 0,
        env,
        minN: 30,
      });
      return live;
    };
    const a = await plan({ MARINA_FORECAST_SHADOW: "0.5" });
    expect(startForecastShadow(db, saveTypedAnswer(db, "Ada", a), a, { draw: 0.6 })).toEqual({
      started: false,
      reason: "not sampled",
    });
    const off = await plan({});
    expect(startForecastShadow(db, saveTypedAnswer(db, "Ada", off), off, { draw: 0 })).toEqual({
      started: false,
      reason: "no plan",
    });
    const m = await plan();
    const measured = saveTypedAnswer(db, "Ada", m, undefined, {
      source: "futurex",
      evalMode: "measure",
    });
    expect(startForecastShadow(db, measured, m, { draw: 0 })).toEqual({
      started: false,
      reason: "measurement run",
    });
    // One allowed a day: the second is refused once the first is filed.
    const capped = { ...ON, MARINA_FORECAST_SHADOW_MAX_PER_DAY: "1" };
    const first = await plan(capped);
    const s1 = startForecastShadow(db, saveTypedAnswer(db, "Ada", first), first, { draw: 0 });
    if (!s1.started) throw new Error(s1.reason);
    await s1.done;
    expect(shadowUsage(db, Date.now()).count).toBe(1);
    const second = await plan(capped);
    expect(
      startForecastShadow(db, saveTypedAnswer(db, "Ada", second), second, { draw: 0 }),
    ).toMatchObject({
      started: false,
      reason: expect.stringContaining("count"),
    });
  });

  it("a past cutoff gets backtest isolation: research behind the strict pre-cutoff filter", async () => {
    const card = recipeCard("delphi")!;
    const past = { at: "2026-09-01T00:00:00.000Z", basis: "asOf" as const, pastCutoff: true };
    const now = { ...past, pastCutoff: false };
    expect(await shadowIsolation(now, card, {})).toBe("live");
    expect(await shadowIsolation(past, card, { MARINA_FORECAST_RETRIEVER: "asof" })).toBe(
      "date-filtered",
    );
    expect(await shadowIsolation(past, card, { MARINA_FORECAST_RETRIEVER: "search" })).toBe(
      "post-filtered",
    );
    expect(await shadowIsolation(past, recipeCard("ensemble+closed-book")!, {})).toBe(
      "closed-book",
    );

    const req = { question: "Will it?", answer: yesNo, asOf: "2026-09-01T00:00:00Z" };
    const live = await liveAnswer(req);
    expect(live.cutoff.pastCutoff).toBe(true);
    planForecastShadow(live, {
      req,
      deps: deps(),
      routing: live.routing,
      costUsd: () => 0,
      env: { ...ON, MARINA_FORECAST_RETRIEVER: "search" },
      minN: 30,
    });
    const liveId = saveTypedAnswer(db, "Ada", live)!;
    briefs = [];
    const start = startForecastShadow(db, liveId, live, { draw: 0 });
    if (!start.started) throw new Error(start.reason);
    expect(await start.done).toMatchObject({ status: "filed", isolation: "post-filtered" });
    // Every shadow research brief is bounded by the live cutoff.
    expect(briefs.length).toBeGreaterThan(0);
    expect(briefs.every((b) => b.until?.startsWith("2026-09-01"))).toBe(true);
  });
});

describe("the route view", () => {
  const paired = (n: number, family: string, gain: number): CardEvidence[] =>
    Array.from({ length: n }, (_, i) => [
      {
        family,
        method: "formation:ensemble",
        question: `q${i}`,
        score: 0.5,
        resolvedAt: i,
        measure: false,
      },
      {
        family,
        method: "formation:delphi",
        question: `q${i}`,
        score: 0.5 + gain + (i % 3) * 0.001,
        resolvedAt: i,
        measure: false,
      },
    ]).flat();

  it("forecast: paired n, win rate and the earned verdict per family and card", () => {
    const rows = forecastRouteRows({
      evidence: [...paired(30, "group:binary:no|yes", 0.1), ...paired(5, "category:x", 0.1)],
      defaultCard: "formation:ensemble",
      candidates: ["formation:ensemble", "formation:delphi"],
      minN: 30,
    });
    const big = rows.find((r) => r.family === "group:binary:no|yes")!;
    expect(big).toMatchObject({
      method: "formation:delphi",
      n: 30,
      winRate: 1,
      earned: true,
      defaultN: 30,
    });
    const small = rows.find((r) => r.family === "category:x")!;
    expect(small).toMatchObject({ n: 5, verdict: "too few paired", earned: false });
    const text = renderRouteView(rows);
    expect(text).toContain("forecast group:binary:no|yes");
    expect(text).toContain("EARNED");
  });

  it("arena: the same table from route evidence; a method routing would not consider is never earned", () => {
    const ev = Array.from({ length: 8 }, (_, i) => [
      {
        roundId: `r${i}`,
        family: "aaii",
        source: "filed" as const,
        spec: "nowcast",
        skill: 0.1,
        visibleAt: 1,
      },
      {
        roundId: `r${i}`,
        family: "aaii",
        source: "outcome" as const,
        spec: "baseline",
        skill: 0.3,
        visibleAt: 1,
      },
    ]).flat();
    const rows = arenaRouteRows({ evidence: ev, defaultFor: () => "nowcast", minN: 8, now: 10 });
    expect(rows).toEqual([
      expect.objectContaining({
        evidence: "arena",
        family: "aaii",
        method: "baseline",
        n: 8,
        winRate: 1,
        earned: true,
      }),
    ]);
  });

  it("loadRouteView reads both sources, read-only, and says when the arena is absent", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const view = await loadRouteView(db, {
        env: {},
        arena: async () => ({
          evidence: [
            {
              roundId: "r1",
              family: "aaii",
              source: "filed",
              spec: "nowcast",
              skill: 0.1,
              visibleAt: 1,
            },
          ],
          defaultFor: () => "nowcast",
        }),
      });
      expect(view.rows).toEqual([]);
      expect(view.notes.join("\n")).toContain("arena: routing on");
      const none = await loadRouteView(db, { env: {}, arena: async () => undefined });
      expect(none.notes.join("\n")).toContain("no entrant configured");
    } finally {
      db.close();
    }
  });
});

describe("FutureX live: the earned default, with fixed variants as the override", () => {
  const row = {
    id: "r1",
    prompt:
      'The event to be predicted: "Will it? (resolved around 2026-10-03T08:00:00+08:00 (GMT+8))."\nA. Yes\nB. No\nIMPORTANT: End with \\boxed{YOUR_PREDICTION}.',
    end_time: "2026-10-30T20:00:00+08:00",
    level: 1,
  };
  const fixed = () => ({ deps: deps(), costUsd: () => 0.01 });
  const now = () => NOW;

  it("the earned variant answers through the surface forecaster, never the fixed deps", async () => {
    const asked: TypedForecastRequest[] = [];
    const earned: Variant = { label: "earned", model: "marina", analysts: [], earned: true };
    const run: BatchRun = await runBatch(
      [row],
      earned,
      () => {
        throw new Error("fixed deps used");
      },
      {
        now,
        forecastRow: async (req) => {
          asked.push(req);
          const answer = await forecastFormed(req, deps(), "ensemble");
          answer.costUsd = 0.02;
          return { answer, costUsd: 0.02 };
        },
      },
    );
    expect(asked.map((r) => r.id)).toEqual(["r1"]);
    expect(run.results[0]).toMatchObject({ id: "r1", costUsd: 0.02, fallback: false });
    // Without a surface forecaster an earned variant refuses rather than guessing.
    await expect(runBatch([row], earned, fixed, { now })).rejects.toThrow("row forecaster");
  });

  it("a fixed variant (the override) still runs its own configuration", async () => {
    const cheap: Variant = { label: "cheap", model: "x", analysts: ["x"] };
    let used = 0;
    const run = await runBatch(
      [row],
      cheap,
      () => {
        used++;
        return fixed();
      },
      { now, forecastRow: async () => Promise.reject(new Error("surface used")) },
    );
    expect(used).toBe(1);
    expect(run.results[0]?.costUsd).toBe(0.01);
  });

  it("the earned configuration resolves from the board's slot (forecast-config:futurex)", () => {
    const slot = {
      getBenchmarkDefault: (key: string) =>
        key === "forecast-config:futurex"
          ? {
              slot: key,
              value_json: JSON.stringify({
                configuration: { analysts: ["openrouter/x/y"], formation: "delphi" },
              }),
              incumbent_run_id: "bench_1",
              holdout_fraction: 0.5,
              updated_at: 0,
              updated_by: null,
            }
          : undefined,
    };
    const text = describeEarned({ db: slot, env: {} });
    expect(text).toContain("futurex:live:formation ← slot forecast-config:futurex");
    expect(describeEarned({ env: {} })).toContain("builtin");
  });
});

describe("shadows never add a correlated history record", () => {
  it("the shadow's outcome skips history (its live answer records the question) but still teaches", async () => {
    const { deliverOutcomes } = await import("../src/outcomes/deliver");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const db = new MarinaDB(":memory:");
    try {
      const req = { question: "Will it?", answer: yesNo };
      const live = await liveAnswer(req);
      planForecastShadow(live, {
        req,
        deps: deps(),
        routing: live.routing,
        costUsd: () => 0,
        env: ON,
        minN: 30,
      });
      const liveId = saveTypedAnswer(db, "Ada", live)!;
      const start = startForecastShadow(db, liveId, live, { draw: 0 });
      if (!start.started) throw new Error(start.reason);
      const filed = await start.done;
      if (filed.status !== "filed") throw new Error(filed.reason);
      resolveForecast(db, liveId, { option: "Yes" }, Date.parse("2026-10-20T00:00:00Z"));
      const history = join(mkdtempSync(join(tmpdir(), "shadow-hist-")), "history.jsonl");
      await deliverOutcomes(db, {
        env: { MARINA_FORECAST_HISTORY: history, MARINA_LESSONS: "on" },
      });
      const outcomes = db.listOutcomes({ kind: "forecast" });
      const of = (subject: string) =>
        db.outcomeDeliveries(outcomes.find((o) => o.subject === subject)!.id);
      const shadowHistory = of(`forecast:${filed.answerId}`).find((d) => d.consumer === "history");
      expect(shadowHistory).toMatchObject({ state: "skipped", reason: "shadow challenger" });
      expect(of(`forecast:${liveId}`).find((d) => d.consumer === "history")?.state).toBe("done");
      // Lessons are not skipped for it: they wait for (or reach) the learner like the live one.
      expect(
        of(`forecast:${filed.answerId}`).find((d) => d.consumer === "lessons")?.state,
      ).not.toBe("skipped");
    } finally {
      await drainForecastShadows();
      db.close();
    }
  });
});

describe("FutureX shadows: filed on adoption, settled at learn time", () => {
  const prompt =
    'The event to be predicted: "Will it? (resolved around 2026-10-03T08:00:00+08:00 (GMT+8))."\nA. Yes\nB. No\nIMPORTANT: End with \\boxed{YOUR_PREDICTION}.';
  const row = { id: "r1", prompt, end_time: "2026-10-30T20:00:00+08:00", level: 1 };
  const earned: Variant = { label: "earned", model: "marina", analysts: [], earned: true };
  /** The surface forecaster, as `earnedForecaster` would be with shadows on: routed, planned. */
  const forecastRow = async (req: TypedForecastRequest) => {
    const answer = await forecastCarded(req, deps(), "ensemble", routeSettingsFromEnv({}), {
      env: {},
      featureProviders: [],
    });
    answer.costUsd = 0.02;
    planForecastShadow(answer, {
      req,
      deps: deps(),
      routing: answer.routing,
      costUsd: () => 0,
      env: { MARINA_FORECAST_SHADOW: "0.5" },
      minN: 30,
    });
    return { answer, costUsd: 0.02 };
  };

  it("runs under the same gate, never touches the submitted answer, pairs on the row id, supersedes on revision", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileTypedAnswer, resolveFiled } = await import("../src/outcomes/filing");
    const { loadShadowMap, settleRowShadow, startAdoptedShadows } = await import(
      "../benchmarks/futurex/shadow"
    );
    const db = new MarinaDB(":memory:");
    const out = mkdtempSync(join(tmpdir(), "futurex-shadow-"));
    try {
      const fixed = () => {
        throw new Error("fixed deps used");
      };
      const run = await runBatch([row], earned, fixed, { now: () => NOW, forecastRow });
      const submitted = JSON.stringify(run.results[0]);
      // Not sampled: nothing filed, nothing recorded.
      expect(
        await startAdoptedShadows(db, out, "earned", run.results, { draw: () => 0.99 }),
      ).toEqual({ started: 0, filed: 0 });
      expect(loadShadowMap(out)).toEqual({});

      const first = await runBatch([row], earned, fixed, { now: () => NOW, forecastRow });
      expect(
        await startAdoptedShadows(db, out, "earned", first.results, { draw: () => 0 }),
      ).toEqual({ started: 1, filed: 1 });
      const firstShadow = loadShadowMap(out).r1!;
      expect(db.getForecastAnswer(firstShadow)).toMatchObject({
        entity_name: SHADOW_OWNER,
        source: "shadow",
        eval_mode: "live",
      });
      // A revised standing answer supersedes the old shadow (it no longer pairs).
      const revised = await runBatch([row], earned, fixed, { now: () => NOW, forecastRow });
      await startAdoptedShadows(db, out, "earned", revised.results, { draw: () => 0 });
      const current = loadShadowMap(out).r1!;
      expect(current).not.toBe(firstShadow);
      expect(db.getForecastAnswer(firstShadow)!.outcome_json).toContain("superseded");
      // The submitted answer was never touched.
      expect(JSON.stringify(run.results[0])).toBe(submitted);

      // Learn time: the live answer is filed and resolved; its shadow settles on the same value.
      const r = revised.results[0]!;
      const filing = {
        owner: "marina:futurex/earned",
        source: "futurex",
        externalId: "futurex:r1",
        evalMode: "live" as const,
      };
      const before = JSON.stringify(r.answer);
      fileTypedAnswer(db, r.answer, filing);
      const at = Date.parse("2026-10-31T00:00:00Z");
      resolveFiled(db, filing.owner, filing.externalId, { option: "A" }, at);
      expect(settleRowShadow(db, out, "r1", { value: { option: "A" }, resolvedAt: at })).toBe(true);
      expect(JSON.stringify(r.answer)).toBe(before);
      const rows = db.listOutcomes({ kind: "forecast" });
      expect(rows).toHaveLength(2);
      const ev = evidenceFromOutcomes(rows);
      expect(new Set(ev.map((e) => e.question))).toEqual(new Set(["q:r1"]));
      expect(new Set(ev.map((e) => e.method)).size).toBe(2);
      // Superseded shadows never record an outcome.
      expect(rows.some((o) => o.subject === `forecast:${firstShadow}`)).toBe(false);
    } finally {
      await drainForecastShadows();
      db.close();
    }
  });
});

describe("a shadow under the as-of fence", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(async () => {
    await drainForecastShadows();
    db.close();
  });

  const CUT = "2026-06-01T00:00:00.000Z";
  /** Analysts that record the fence each call ran under. */
  const spying = (seen: Array<string | undefined>) => ({
    ...deps(),
    analysts: [
      part("s1", () => {
        seen.push(currentEvidenceCutoff());
        return JSON.stringify({ answer: "Yes", probabilities: { Yes: 0.7, No: 0.3 } });
      }),
      part("s2", () => {
        seen.push(currentEvidenceCutoff());
        return JSON.stringify({ answer: "No", probabilities: { Yes: 0.4, No: 0.6 } });
      }),
    ],
  });

  it("a shadow planned inside a fenced context stays fenced, even when started outside it", async () => {
    const req = { question: "Will it?", answer: yesNo };
    const live = await liveAnswer(req);
    const seen: Array<string | undefined> = [];
    withEvidenceCutoff(CUT, () =>
      planForecastShadow(live, {
        req,
        deps: spying(seen),
        routing: live.routing,
        costUsd: () => 0,
        env: ON,
        minN: 30,
      }),
    );
    const liveId = saveTypedAnswer(db, "Ada", live)!;
    const start = startForecastShadow(db, liveId, live, { draw: 0 });
    if (!start.started) throw new Error(`not started: ${start.reason}`);
    await start.done;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c === CUT)).toBe(true);
  });

  it("a shadow started inside a fenced context stays fenced in the background", async () => {
    const req = { question: "Will it?", answer: yesNo };
    const live = await liveAnswer(req);
    const seen: Array<string | undefined> = [];
    planForecastShadow(live, {
      req,
      deps: spying(seen),
      routing: live.routing,
      costUsd: () => 0,
      env: ON,
      minN: 30,
    });
    const liveId = saveTypedAnswer(db, "Ada", live)!;
    const start = withEvidenceCutoff(CUT, () => startForecastShadow(db, liveId, live, { draw: 0 }));
    if (!start.started) throw new Error(`not started: ${start.reason}`);
    expect(currentEvidenceCutoff()).toBeUndefined();
    await start.done;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c === CUT)).toBe(true);
  });
});
