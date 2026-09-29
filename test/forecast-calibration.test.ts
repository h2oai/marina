// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { crpsNormal } from "../src/arena/score";
import { forecastCommand, renderHistory, saveAnswer } from "../src/engine/commands/forecast";
import type { ForecastAnswer } from "../src/forecast/question";
import { MarinaDB } from "../src/persistence/database";
import {
  clearCalibrationFinders,
  forecastQuestionFinder,
  listCalibrationFinders,
  registerBuiltinCalibrationFinders,
  runCalibration,
} from "../src/resolvers/calibration";
import type { Sample } from "../src/resolvers/types";
import type { CommandInput, RoomContext } from "../src/types";

const answer = (over: Partial<ForecastAnswer>): ForecastAnswer => ({
  question: "Will X happen?",
  kind: "probability",
  analysts: [{ name: "a", probability: 0.8, weight: 1, status: "ok" }],
  sources: [{ url: "https://example.test/a" }],
  report: "dossier",
  costUsd: 0.05,
  latencyMs: 10,
  ...over,
});

const resolved = (id: string, value: unknown): Sample => ({
  kind: "resolving",
  id,
  ts: 1_900_000_000_000,
  status: "resolved",
  value,
  source: "test",
});

describe("forecast answers are persisted and calibrated", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    clearCalibrationFinders();
    registerBuiltinCalibrationFinders();
  });
  afterEach(() => {
    clearCalibrationFinders();
    db.close();
  });

  it("registers the forecast-question finder with the built-ins", () => {
    expect(listCalibrationFinders().map((f) => f.name)).toContain(forecastQuestionFinder.name);
  });

  it("keeps the full answer and scores a probability once when its Sample resolves", () => {
    const id = saveAnswer(db, "Ada", answer({ probability: 0.8 }), "kalshi/KXFED-26OCT")!;
    const row = db.listForecastAnswers("Ada")[0]!;
    expect(row.id).toBe(id);
    // The answer object is the audit trail: every stage is kept.
    expect(JSON.parse(row.answer_json).analysts[0].name).toBe("a");
    expect(row.resolved_at).toBeNull();

    runCalibration(db, { ...resolved("kalshi/OTHER", { outcome: "no" }) });
    expect(db.listForecastAnswers("Ada")[0]!.resolved_at).toBeNull();

    runCalibration(db, resolved("kalshi/KXFED-26OCT", { outcome: "yes" }));
    const scored = db.listForecastAnswers("Ada")[0]!;
    expect(scored.score).toBeCloseTo(0.04, 6);
    expect(JSON.parse(scored.outcome_json!)).toMatchObject({ outcome: "yes", correct: true });

    // Settled once: a second resolution never re-scores.
    runCalibration(db, resolved("kalshi/KXFED-26OCT", { outcome: "no" }));
    expect(db.listForecastAnswers("Ada")[0]!.score).toBeCloseTo(0.04, 6);
    expect(renderHistory(db.listForecastAnswers("Ada"))).toContain("Brier 0.040");
  });

  it("scores a number forecast by CRPS against a numeric outcome", () => {
    saveAnswer(
      db,
      "Ada",
      answer({ question: "What will it be?", kind: "number", mean: 10, sd: 2 }),
      "inworld/gdp",
    );
    runCalibration(db, resolved("inworld/gdp", { value: 13 }));
    const row = db.listForecastAnswers("Ada")[0]!;
    expect(row.score).toBeCloseTo(crpsNormal(10, 2, 13), 9);
    expect(JSON.parse(row.outcome_json!)).toMatchObject({ actual: 13, within80: false });
  });

  it("forecast track links only the caller's own open forecast", () => {
    const id = saveAnswer(db, "Ada", answer({ probability: 0.3 }))!;
    const sent: string[] = [];
    const ctx = { send: (_: string, text: string) => sent.push(text) } as unknown as RoomContext;
    const names: Record<string, string> = { e_ada: "Ada", e_bob: "Bob" };
    const cmd = forecastCommand({ db, getEntity: (eid) => ({ name: names[eid]! }) });
    const run = (entity: string, args: string) =>
      cmd.handler(ctx, { entity, args } as unknown as CommandInput);

    run("e_bob", `track ${id} kalshi/KXA`);
    expect(sent.at(-1)).toContain("No open forecast");
    run("e_ada", `track ${id} not-a-sample`);
    expect(sent.at(-1)).toContain("Usage: forecast track");
    run("e_ada", `track ${id} kalshi/KXA`);
    expect(sent.at(-1)).toContain("scored when kalshi/KXA resolves");

    runCalibration(db, resolved("kalshi/KXA", { outcome: "no" }));
    run("e_ada", "list");
    expect(sent.at(-1)).toContain(`#${id}`);
    expect(sent.at(-1)).toContain("Brier 0.090");
  });
});
