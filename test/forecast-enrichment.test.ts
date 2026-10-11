// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { trendsChallenger, wikipediaChallenger } from "../src/arena/attention";
import type { RoundForecast } from "../src/arena/forecast";
import { revisionInventory } from "../src/arena/revision-inventory";
import { buildTable, distributionsFrom } from "../src/arena/tabh2o-forecaster";
import type { ArenaLock, ArenaRound } from "../src/arena/types";
import { covariatesAt, localLevel } from "../src/forecast/numeric";
import { populationScenario } from "../src/forecast/population";
import { indexEvidence } from "../src/research/evidence-index";
import { decideEvidenceRefresh } from "../src/research/refresh";
import { releasesDue, type SurveyWave, surveySource } from "../src/research/survey";

test("training covariates never borrow a later release or revision", () => {
  const rows = [
    { name: "gas", value: 3, observedAt: "2026-01-01", availableAt: "2026-01-02T10:00:00Z" },
    { name: "gas", value: 9, observedAt: "2026-01-01", availableAt: "2026-01-10T10:00:00Z" },
  ];
  expect(covariatesAt(rows, "2026-01-01")).toEqual({ cov_gas: null });
  expect(covariatesAt(rows, "2026-01-06")).toEqual({ cov_gas: 3 });
  expect(covariatesAt(rows, "2026-01-11")).toEqual({ cov_gas: 9 });
  expect(() => covariatesAt([...rows, { ...rows[0]!, value: 7 }], "2026-01-06")).toThrow(
    "conflicting",
  );
  const points = Array.from({ length: 15 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    value: i,
  }));
  const built = buildTable(
    [{ key: "test", points, steps: 1, covariates: rows, asOf: "2026-01-15T12:00:00Z" }],
    "regression",
  )!;
  for (const row of built.request.training) expect(row.cov_gas).toBe(Number(row.level) < 9 ? 3 : 9);
  const late = buildTable(
    [
      {
        key: "test",
        points,
        steps: 1,
        covariates: [
          ...rows,
          {
            name: "gas",
            observedAt: "2026-01-15",
            availableAt: "2026-01-15T18:00:00Z",
            value: 1000,
          },
        ],
        asOf: "2026-01-15T12:00:00Z",
      },
    ],
    "regression",
  )!;
  expect(late.request.predict_on[0]!.cov_gas).toBe(9);
  expect(() =>
    buildTable([{ key: "test", points, steps: 1, covariates: rows }], "regression"),
  ).toThrow("cutoff");
});

test("undocumented interval width does not become fabricated 90-percent uncertainty", () => {
  const table = {
    request: { task: "regression" as const, training: [], predict_on: [], target_column: "y" },
    series: [{ key: "x", origin: 10, residualSd: 2, testRows: 1 }],
  };
  const result = {
    ok: true as const,
    response: {
      task: "regression" as const,
      predictions: [{ prediction: 1, confidence_interval: [0, 2] as [number, number] }],
    },
  };
  expect(distributionsFrom(table, result, "regression")?.[0]).toMatchObject({
    dist: { mean: 11, sd: 2 },
    sdSource: "residual",
  });
  expect(
    distributionsFrom(
      table,
      {
        ...result,
        response: {
          ...result.response,
          predictions: [{ ...result.response.predictions[0]!, confidence_level: 0.95 }],
        },
      },
      "regression",
    )?.[0],
  ).toMatchObject({ sdSource: "ci" });
});

test("local level uses horizon errors and refuses broken history", () => {
  const points = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    value: i % 2 ? 12 : 10,
  }));
  const result = localLevel(points, 2, 1.5);
  expect(result.mean).toBeGreaterThan(10);
  expect(result.mean).toBeLessThan(12);
  expect(result.detail.residuals).toBe(15);
  expect(() => localLevel([...points, points[0]!], 1, 1.5)).toThrow("history");
});

const trends: ArenaRound = {
  round_id: "basket",
  tracker: "google_trends",
  target_type: "profile_energy",
  question: "Shares",
  cells: ["a", "b"],
  lock_at: "2099-10-06T22:00:00Z",
  release_at: "2099-10-10T00:00:00Z",
};
const basket: ArenaLock = {
  round_id: "basket",
  answer_history_by_cell: {
    a: [
      { date: "2098-10-09", value: 20 },
      { date: "2099-10-02", value: 50 },
      { date: "2099-10-09", value: 60 },
    ],
    b: [
      { date: "2098-10-09", value: 80 },
      { date: "2099-10-02", value: 50 },
      { date: "2099-10-09", value: 40 },
    ],
  },
};
const start: RoundForecast = {
  rules: {},
  note: "base",
  profile: { a: { mean: 50, sd: 1.5 }, b: { mean: 50, sd: 1.5 } },
};
test("Trends closes one basket and separates partial, completed and aligned seasonal weeks", () => {
  const seasonal = trendsChallenger(trends, basket, start, {
    asOf: "2099-10-06T12:00:00Z",
    seasonalWeight: 0.5,
    partialWeight: 0.3,
    availableAt: "2099-10-06T10:00:00Z",
  });
  expect(seasonal.profile.a!.mean).toBeCloseTo(38, 6);
  expect(seasonal.profile.a!.mean + seasonal.profile.b!.mean).toBeCloseTo(100, 8);
  expect(seasonal.profile.a!.sd).toBe(1.5);
  const bad = structuredClone(basket);
  bad.answer_history_by_cell!.b![0]!.date = "2098-10-08";
  expect(() =>
    trendsChallenger(trends, bad, start, { asOf: "2099-10-06T12:00:00Z", seasonalWeight: 0.5 }),
  ).toThrow("mismatched");
});

test("future event announcements never enter an attention scenario", () => {
  const opts = { asOf: "2099-10-06T12:00:00Z", seasonalWeight: 0.5 };
  const baseline = trendsChallenger(trends, basket, start, opts);
  const event = trendsChallenger(trends, basket, start, {
    ...opts,
    events: [
      {
        item: "a",
        multiplier: 4,
        knownAt: "2099-10-07",
        startsAt: "2099-10-09",
        endsAt: "2099-10-12",
        source: "https://example.org/calendar",
      },
    ],
  });
  expect(event.profile).toEqual(baseline.profile);
});

test("Wikipedia applies publication lag and preserves exact title identity", () => {
  const round = {
    ...trends,
    tracker: "wikipedia",
    target_type: "ranking_list" as const,
    ranking: { length: 2 },
  };
  const result = wikipediaChallenger(
    round,
    {
      round_id: "basket",
      answer_obs: [
        { date: "2099-10-02", items: ["A", "B"], views: { A: 50, B: 100 } },
        { date: "2099-10-03", items: ["A", "B"], views: { A: 150, B: 100 } },
        { date: "2099-10-06", items: ["Future"], views: { Future: 1000000 } },
      ],
    },
    { note: "base", rules: {}, ranking: ["B", "A"] },
    { asOf: "2099-10-06T12:00:00Z" },
  );
  expect(result.ranking).toEqual(["A", "B"]);
});

test("population scenarios retain shared error and refuse mixed partitions", () => {
  const stratum = {
    population: "adults",
    partition: "party",
    share: 40,
    effectiveSample: 100,
    observedAt: "2026-01-01",
    availableAt: "2026-01-02",
    source: "survey",
  };
  const rows = [
    { ...stratum, id: "a", weight: 0.5 },
    { ...stratum, id: "b", weight: 0.5, share: 60 },
  ];
  const scenario = {
    id: "shock",
    changes: { a: 10 },
    knownAt: "2026-01-02",
    rationale: "hypothetical exposure",
  };
  const opts = { asOf: "2026-01-03", priorShare: 50, priorStrength: 0, commonSd: 2 };
  const out = populationScenario(rows, scenario, opts);
  expect(out.topline.mean).toBe(55);
  expect(out.topline.sd).toBeGreaterThan(2);
  expect(out.kind).toBe("simulation");
  expect(out.qualified).toBe(false);
  expect(() =>
    populationScenario([rows[0]!, { ...rows[1]!, partition: "age" }], scenario, opts),
  ).toThrow("overlapping");
  expect(() => populationScenario(rows, { ...scenario, changes: { invented: 10 } }, opts)).toThrow(
    "effect",
  );
});

test("evidence reuse honors scope, final lock, expiry and incomplete research", () => {
  const evidence = indexEvidence(
    { roundId: "q", request: "test", since: "2026-01-01" },
    "",
    [],
    "2026-01-03",
  );
  const input = {
    previous: {
      key: "owner/q/config",
      forecastAt: "2026-01-03T10:00:00Z",
      evidence,
      complete: true,
    },
    key: "owner/q/config",
    evidence,
    now: "2026-01-03T12:00:00Z",
    deadline: "2026-01-03T20:00:00Z",
    researchComplete: true,
  };
  expect(decideEvidenceRefresh(input).run).toBe(false);
  expect(decideEvidenceRefresh({ ...input, key: "another-owner/q/config" }).run).toBe(true);
  expect(decideEvidenceRefresh({ ...input, now: "2026-01-03T18:30:00Z" })).toMatchObject({
    run: true,
    reason: "mandatory final refresh",
  });
  expect(decideEvidenceRefresh({ ...input, researchComplete: false }).reason).toContain(
    "incomplete",
  );
});

test("survey waves retain exact bases and dates, while schedules only trigger a check", () => {
  const wave: SurveyWave = {
    schema: "marina.survey-wave.v1",
    source: "survey",
    measure: "approval",
    question: "Approve?",
    unit: "percent",
    url: "https://example.org/archive",
    observedFrom: "2026-01-01",
    availableAt: "2026-01-03T12:00:00Z",
    documentHash: "a".repeat(64),
    cells: [
      {
        population: "registered voters",
        subgroup: "all",
        response: "total approval",
        value: 38,
        weightedBase: 1000,
      },
    ],
  };
  const source = surveySource(wave, "2026-01-04");
  expect(source.measurements?.[0]).toMatchObject({
    value: 38,
    population: "registered voters",
    response: "total approval",
    observedFrom: "2026-01-01",
  });
  expect(() => surveySource(wave, "2026-01-02")).toThrow("unavailable");
  const event = {
    source: "survey",
    target: "approval",
    scheduledAt: "2026-01-03T12:00:00Z",
    announcedAt: "2026-01-01T12:00:00Z",
    url: wave.url,
    status: "scheduled" as const,
  };
  expect(releasesDue([event], "2026-01-04")).toHaveLength(1);
  expect(releasesDue([event], "2026-01-02")).toHaveLength(0);
});

test("revision inventory does not treat revised history as original observations", () => {
  const readings = [
    { series: "approval", date: "2026-01-01", value: 40, availableAt: "2026-01-02", source: "v1" },
    { series: "approval", date: "2026-01-01", value: 41, availableAt: "2026-01-03", source: "v2" },
    {
      series: "approval",
      date: "2026-01-01",
      value: 42,
      availableAt: "2026-01-05",
      source: "future",
    },
  ];
  const inventory = revisionInventory(readings, "2026-01-04");
  expect(inventory.unavailable).toBe(1);
  expect(inventory.observations[0]!.revision).toBe(1);
});
