// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { crpsNormal } from "../src/arena/score";
import {
  forecastCommand,
  renderHistory,
  saveAnswer,
  saveTypedAnswer,
} from "../src/engine/commands/forecast";
import type { ForecastAnswer } from "../src/forecast/question";
import type { TypedForecastAnswer } from "../src/forecast/typed";
import { scoreTypedAnswer } from "../src/forecast/typed-score";
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

const typedAnswer = (over: Partial<TypedForecastAnswer>): TypedForecastAnswer =>
  ({
    question: "Who wins?",
    answer: {
      type: "choice",
      options: [
        { id: "A", label: "Home" },
        { id: "B", label: "Away" },
      ],
    },
    runs: [],
    research: [],
    sources: [],
    cutoff: { at: "2026-09-01T00:00:00.000Z", basis: "now", pastCutoff: false },
    costUsd: 0,
    latencyMs: 1,
    ...over,
  }) as TypedForecastAnswer;

describe("typed answers are scored when their Sample resolves", () => {
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

  it("a choice: multiclass Brier from its distribution, matched by id or label", () => {
    saveTypedAnswer(
      db,
      "Ada",
      typedAnswer({ prediction: "A", formatted: "A", distribution: { A: 0.7, B: 0.3 } }),
      "kalshi/MATCH",
    );
    runCalibration(db, resolved("kalshi/MATCH", { option: "Home" }));
    const row = db.listForecastAnswers("Ada")[0]!;
    expect(row.score).toBeCloseTo(0.18, 6); // (0.7−1)² + 0.3²
    expect(JSON.parse(row.outcome_json!)).toMatchObject({ outcome: ["A"], correct: true });
    expect(renderHistory([row])).toContain("Brier 0.180");
  });

  it("an outcome that matches none of its options leaves the answer open", () => {
    saveTypedAnswer(db, "Ada", typedAnswer({ prediction: "A", formatted: "A" }), "kalshi/MATCH");
    runCalibration(db, resolved("kalshi/MATCH", { option: "Draw" }));
    expect(db.listForecastAnswers("Ada")[0]!.resolved_at).toBeNull();
  });

  it("a typed number carries its uncertainty and is scored by CRPS", () => {
    saveTypedAnswer(
      db,
      "Ada",
      typedAnswer({
        answer: { type: "number" },
        prediction: 100,
        formatted: "100",
        uncertainty: { sd: 10 },
      }),
      "fred/CPI",
    );
    runCalibration(db, resolved("fred/CPI", { value: 110 }));
    expect(db.listForecastAnswers("Ada")[0]!.score).toBeCloseTo(crpsNormal(100, 10, 110), 6);
  });

  it("scores multi, ranking and text, and a yes/no outcome against Yes/No options", () => {
    const multi = scoreTypedAnswer(
      {
        answer: { type: "multi", options: [{ id: "A" }, { id: "B" }, { id: "C" }] },
        prediction: ["A", "B"],
      },
      { options: ["A", "C"] },
    )!;
    expect(multi.loss).toBeCloseTo(2 / 3, 4);
    expect(multi.succeeded).toBe(false);
    const ranking = scoreTypedAnswer(
      { answer: { type: "ranking", size: 3 }, prediction: ["x", "y", "z"] },
      { ranking: ["y", "q", "x"] },
    )!;
    expect(ranking.quality).toBeCloseTo(2 / 3, 4);
    const text = scoreTypedAnswer(
      { answer: { type: "text" }, prediction: "Paris." },
      { value: "paris" },
    )!;
    expect(text).toMatchObject({ loss: 0, succeeded: true });
    const yesNo = scoreTypedAnswer(
      {
        answer: { type: "choice", options: [{ id: "Yes" }, { id: "No" }] },
        prediction: "No",
      },
      { outcome: "yes" },
    )!;
    expect(yesNo).toMatchObject({ loss: 2, succeeded: false, outcome: ["Yes"] });
  });
});
