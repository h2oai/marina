// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  type CalibrationContext,
  type CalibrationObservation,
  calibrateUncertainty,
} from "../src/arena/uncertainty";

const context: CalibrationContext = {
  roundId: "future",
  variant: "delphi-final-v1",
  family: "civiqs",
  unit: "net",
  asOf: "2026-10-01T12:00:00Z",
  horizon: 6,
  sourceAge: 4,
};
const forecast = { mean: -40, sd: 2 };
const observations = (): CalibrationObservation[] =>
  Array.from({ length: 24 }, (_, i) => {
    const day = (n: number) => new Date(Date.UTC(2026, 5, n)).toISOString();
    return {
      ...context,
      roundId: `past-${i}`,
      asOf: day(i * 4 + 1),
      lockAt: day(i * 4 + 2),
      availableAt: day(i * 4 + 3),
      forecast,
      outcome: -40 + (i % 2 ? 0.2 : -0.2),
      persistenceCrps: 1,
    };
  });

test("calibrates final errors on a later validation block while preserving centre", () => {
  const result = calibrateUncertainty(forecast, context, observations());
  expect(result.applied).toBe(true);
  expect(result.forecast.mean).toBe(-40);
  expect(result.forecast.sd).toBe(1.3);
  expect(result.training.every((r) => !result.validation.includes(r))).toBe(true);
  expect(result.metrics?.calibratedLoss).toBeLessThan(result.metrics!.originalLoss);
});

test("late outcomes, post-lock predictions, mismatched estimators and duplicate rounds cannot earn calibration", () => {
  const rows = observations();
  const rejected = rows.flatMap((o) => [
    { ...o, availableAt: context.asOf },
    { ...o, asOf: o.lockAt },
    { ...o, variant: "weekly-persistence" },
    { ...o, family: "other" },
    { ...o, unit: "percent" },
    { ...o, roundId: context.roundId },
    { ...o, horizon: Number.NaN },
  ]);
  expect(calibrateUncertainty(forecast, context, rejected).eligible).toBe(0);
  const copies = Array.from({ length: 30 }, () => rows[0]!);
  expect(calibrateUncertainty(forecast, context, copies).eligible).toBe(1);
  expect(calibrateUncertainty(forecast, context, copies).applied).toBe(false);
});

test("a later error regime vetoes narrowing learned on the early block", () => {
  const rows = observations().map((o, i) => ({ ...o, outcome: i < 16 ? -40 : -37.5 }));
  const result = calibrateUncertainty(forecast, context, rows);
  expect(result.applied).toBe(false);
  expect(result.forecast).toEqual(forecast);
  expect(result.metrics?.coverage80After).toBe(result.metrics?.coverage80Before);
});

test("waves are never split and training labels must predate the validation forecast", () => {
  const rows = observations();
  for (const row of rows) {
    row.lockAt = "2026-09-01T14:00:00Z";
    row.availableAt = "2026-09-02T14:00:00Z";
    row.asOf = "2026-09-01T13:00:00Z";
  }
  expect(calibrateUncertainty(forecast, context, rows).applied).toBe(false);
  const delayed = observations().map((o) => ({ ...o, availableAt: "2026-09-30T00:00:00Z" }));
  expect(calibrateUncertainty(forecast, context, delayed).applied).toBe(false);
});

test("horizon and source-age neighbours determine which final residuals are relevant", () => {
  const distant = { ...context, horizon: 180, sourceAge: 180 };
  const rows = observations().flatMap((o) => [
    o,
    {
      ...o,
      roundId: `${o.roundId}-distant`,
      horizon: 180,
      sourceAge: 180,
      outcome: -36,
    },
  ]);
  expect(calibrateUncertainty(forecast, context, rows).scale).toBe(0.65);
  expect(calibrateUncertainty(forecast, distant, rows).scale).toBe(1.5);
});
