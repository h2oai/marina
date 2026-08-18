// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadScoreOutcomes } from "../src/coordination/score-outcome";
import { storeScore } from "../src/coordination/score-store";
import { MarinaDB } from "../src/persistence/database";
import {
  clearCalibrationFinders,
  conductorScoreFinder,
  registerBuiltinCalibrationFinders,
  runCalibration,
} from "../src/resolvers/calibration";
import type { Sample } from "../src/resolvers/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_conductor_finder.db";

const SCORE = {
  id: "x",
  goal: "forecast it",
  author: "alice",
  steps: [
    { id: "research", instruction: "gather evidence", assignee: "scholar", access: [] },
    {
      id: "predict",
      instruction: "estimate probability",
      assignee: "forecaster",
      access: ["research"],
    },
  ],
};

function resolvedSample(id: string, outcome: "yes" | "no"): Sample {
  return {
    kind: "resolving",
    id,
    ts: Date.now(),
    status: "resolved",
    value: { outcome },
    source: id,
  };
}

describe("conductorScoreFinder — automatic shape→outcome closure", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    storeScore(db, "alice", "forecast-chain", SCORE);
    // Producer: a Score tracked against a resolvable question (what `conduct
    // track` writes), predicting YES at 0.80.
    db.createNote(
      "alice",
      "[score-run:inworld/MKT-1] score:forecast-chain category:forecasting topology:chain predict=0.80",
      undefined,
      { importance: 6, noteType: "process" },
    );
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("scores the prediction by Brier and records the shape as a prior", () => {
    conductorScoreFinder.calibrate(db, resolvedSample("inworld/MKT-1", "yes"));
    const priors = loadScoreOutcomes(db, { category: "forecasting" });
    expect(priors).toHaveLength(1);
    // predict 0.80, actual 1 → Brier 0.04 → quality 0.96
    expect(priors[0]!.score).toBeCloseTo(0.96, 2);
    expect(priors[0]!.topology).toBe("chain");
    expect(priors[0]!.content).toContain("auto:");
  });

  it("a wrong prediction yields a low-quality prior", () => {
    conductorScoreFinder.calibrate(db, resolvedSample("inworld/MKT-1", "no"));
    const priors = loadScoreOutcomes(db, { category: "forecasting" });
    // predict 0.80, actual 0 → Brier 0.64 → quality 0.36
    expect(priors[0]!.score).toBeCloseTo(0.36, 2);
  });

  it("ignores samples with no matching score-run note", () => {
    conductorScoreFinder.calibrate(db, resolvedSample("inworld/OTHER", "yes"));
    expect(loadScoreOutcomes(db)).toHaveLength(0);
  });

  it("is registered as a built-in finder and runs via runCalibration", () => {
    clearCalibrationFinders();
    registerBuiltinCalibrationFinders();
    runCalibration(db, resolvedSample("inworld/MKT-1", "yes"));
    expect(loadScoreOutcomes(db, { category: "forecasting" })).toHaveLength(1);
    // runCalibration is a no-op for non-resolved samples.
    const open: Sample = { ...resolvedSample("inworld/MKT-1", "yes"), status: "changed" };
    runCalibration(db, open);
    expect(loadScoreOutcomes(db, { category: "forecasting" })).toHaveLength(1); // unchanged
  });
});
