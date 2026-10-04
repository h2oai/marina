// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCalibrationHistory } from "../src/arena/calibration-history";
import { type CalibrationObservation, calibrateUncertainty } from "../src/arena/uncertainty";

const cutoff = "2026-10-10T12:00:00Z";
const row: CalibrationObservation = {
  roundId: "econ-w41",
  variant: "exact-policy-v1",
  family: "civiqs",
  unit: "net",
  asOf: "2026-10-04T12:00:00Z",
  lockAt: "2026-10-07T14:00:00Z",
  availableAt: "2026-10-09T14:00:00Z",
  horizon: 7,
  sourceAge: 2,
  forecast: { mean: -40, sd: 2 },
  outcome: -39.8,
  persistenceCrps: 1,
};

test("repeated scoring and timezone aliases cannot multiply evidence", () => {
  const source = structuredClone(row);
  const result = mergeCalibrationHistory(
    [[source], [row, { ...row, asOf: "2026-10-04T05:00:00-07:00" }]],
    cutoff,
  );
  expect(result.observations).toHaveLength(1);
  expect(result.duplicates).toBe(2);
  expect(result.groups[0]).toMatchObject({ rounds: 1, waves: 1, status: "insufficient-rounds" });
  result.observations[0]!.forecast.mean = 0;
  expect(source.forecast.mean).toBe(-40);
  expect(result.promotion).toBe("none");
});

test("latest pre-lock forecast wins independently of import order, not best score", () => {
  const later = { ...row, asOf: "2026-10-06T12:00:00Z", forecast: { mean: -80, sd: 2 } };
  const a = mergeCalibrationHistory([[row, later]], cutoff);
  const b = mergeCalibrationHistory([[later, row]], cutoff);
  expect(a).toEqual(b);
  expect(a.superseded).toBe(1);
  expect(a.observations[0]!.forecast.mean).toBe(-80);
});

test("policy grid, family, and unit stay separate; one wave is never a holdout", () => {
  const grid = Array.from({ length: 26 }, (_, p) =>
    Array.from({ length: 4 }, (_, q) => ({ ...row, variant: `policy-${p}`, roundId: `q-${q}` })),
  ).flat();
  const result = mergeCalibrationHistory([grid, grid], cutoff);
  expect(result.observations).toHaveLength(104);
  expect(result.groups).toHaveLength(26);
  expect(result.groups.every((g) => g.rounds === 4 && g.waves === 1)).toBe(true);
  const separate = mergeCalibrationHistory(
    [[row, { ...row, family: "other" }, { ...row, unit: "percent" }]],
    cutoff,
  );
  expect(separate.groups).toHaveLength(3);
  const wave = mergeCalibrationHistory(
    [Array.from({ length: 12 }, (_, i) => ({ ...row, roundId: `q-${i}` }))],
    cutoff,
  );
  expect(wave.groups[0]!.status).toBe("insufficient-waves");
});

test("outcomes at or after the cutoff cannot enter history", () => {
  const result = mergeCalibrationHistory(
    [[row, { ...row, roundId: "pending", availableAt: cutoff }]],
    cutoff,
  );
  expect(result.unavailable).toBe(1);
  expect(result.observations.map((o) => o.roundId)).toEqual([row.roundId]);
  expect(mergeCalibrationHistory([[]], cutoff).groups).toEqual([]);
});

test("invalid chronology, incomplete exports and conflicting evidence fail closed", () => {
  for (const invalid of [
    null,
    {},
    { ...row, variant: "" },
    { ...row, forecast: { mean: 0, sd: 0 } },
    { ...row, persistenceCrps: Number.NaN },
    { ...row, sourceAge: -1 },
    { ...row, asOf: "2026-10-04T12:00:00" },
    { ...row, asOf: row.lockAt },
    { ...row, availableAt: row.lockAt },
  ])
    expect(() => mergeCalibrationHistory([[invalid]], cutoff)).toThrow();
  expect(() => mergeCalibrationHistory([{}], cutoff)).toThrow("must be an array");
  expect(() => mergeCalibrationHistory([[]], "yesterday")).toThrow("timezone");
  expect(() =>
    mergeCalibrationHistory([[row], [{ ...row, forecast: { mean: 1, sd: 1 } }]], cutoff),
  ).toThrow("conflicting calibration observation");
  expect(() =>
    mergeCalibrationHistory([[row, { ...row, asOf: "2026-10-05T12:00:00Z", outcome: 10 }]], cutoff),
  ).toThrow("conflicting calibration outcome");
  expect(() =>
    mergeCalibrationHistory([Array.from({ length: 100_001 }, () => row)], cutoff),
  ).toThrow("exceeds 100000");
});

test("merged history uses the existing chronological calibration gate for a future target", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 5, n)).toISOString();
  const rows = Array.from({ length: 24 }, (_, i) => ({
    ...row,
    roundId: `history-${i}`,
    asOf: day(i * 4 + 1),
    lockAt: day(i * 4 + 2),
    availableAt: day(i * 4 + 3),
  }));
  const report = mergeCalibrationHistory([rows, rows], cutoff);
  expect(report.groups[0]!.status).toBe("requires-target-validation");
  const context = { ...row, roundId: "future", asOf: cutoff };
  const calibrated = calibrateUncertainty(row.forecast, context, report.observations);
  expect(calibrated.applied).toBe(true);
  expect(calibrated.training).toHaveLength(16);
  expect(calibrated.validation).toHaveLength(8);
  expect(calibrated.forecast.mean).toBe(row.forecast.mean);
  expect(report.promotion).toBe("none");
});

test("CLI merges scorer exports and its own history without overwriting evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marina-calibration-"));
  const script = join(import.meta.dir, "../scripts/arena-calibration-history.ts");
  const input = join(dir, "scores.json");
  const first = join(dir, "history.json");
  const next = join(dir, "next.json");
  const run = async (output: string, ...inputs: string[]) => {
    const child = Bun.spawn(
      [process.execPath, script, "--as-of", cutoff, "--output", output, ...inputs],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  try {
    await writeFile(input, JSON.stringify({ calibrationObservations: [row] }));
    expect((await run(first, input)).exitCode).toBe(0);
    expect((await run(next, first, input)).exitCode).toBe(0);
    const result = JSON.parse(await readFile(next, "utf8"));
    expect(result.observations).toHaveLength(1);
    expect(result.duplicates).toBe(1);
    expect((await run(input, input)).exitCode).not.toBe(0);
    expect(JSON.parse(await readFile(input, "utf8"))).toEqual({ calibrationObservations: [row] });
    const invalid = join(dir, "invalid.json");
    await writeFile(invalid, JSON.stringify({ observations: [row] }));
    expect((await run(join(dir, "rejected.json"), invalid)).stderr).toContain("not a calibration");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
