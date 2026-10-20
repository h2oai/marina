// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  fileProphetAnswers,
  PROPHET_OWNER,
  parseJournal,
  parseResolutions,
  prophetExternalId,
  prophetResolutionValue,
  resolveProphetAnswers,
} from "../benchmarks/prophet/writeback";
import type { TypedForecastAnswer } from "../src/forecast/typed";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";

/** A typed answer as `POST /v1/forecast` returns it (only what filing and scoring read). */
const answer = (
  type: "choice" | "multi",
  options: Array<{ id: string; label: string }>,
  distribution: Record<string, number>,
  prediction: string | string[],
): TypedForecastAnswer =>
  ({
    question: "Which synthetic outcome happens?",
    answer: { type, options, probabilities: true },
    distribution,
    prediction,
    formatted: Array.isArray(prediction) ? prediction.join(",") : prediction,
    runs: [],
    sources: [],
    research: [],
    cutoff: { at: "2026-10-01T00:00:00.000Z", basis: "now", pastCutoff: false },
    costUsd: 0,
    latencyMs: 1,
  }) as unknown as TypedForecastAnswer;

const exclusive = answer(
  "choice",
  [
    { id: "A", label: "Red" },
    { id: "B", label: "Green" },
  ],
  { A: 0.7, B: 0.3 },
  "A",
);
const yesNo = answer(
  "choice",
  [
    { id: "A", label: "Yes: Before 2027" },
    { id: "B", label: "No" },
  ],
  { A: 0.2, B: 0.8 },
  "B",
);
const part = (labels: string[]) =>
  answer(
    "multi",
    labels.map((label, i) => ({ id: String.fromCharCode(65 + i), label })),
    Object.fromEntries(labels.map((_, i) => [String.fromCharCode(65 + i), 0.1])),
    [],
  );

const journal = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");

describe("Prophet write-back", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  it("parses the agent's journal and drops malformed lines", () => {
    const { entries, invalid } = parseJournal(
      journal([
        { event: "ev-1", mode: "live", answer: exclusive },
        { event: "ev-2", mode: "measure", part: 1, answer: part(["X", "Y"]) },
        { event: "bad id with spaces", mode: "live", answer: exclusive },
        { event: "ev-3", mode: "other", answer: exclusive },
        { event: "ev-4", mode: "live", answer: { answer: { type: "number" } } },
      ]),
    );
    expect(entries.map((e) => [e.event, e.part, e.mode])).toEqual([
      ["ev-1", undefined, "live"],
      ["ev-2", 1, "measure"],
    ]);
    expect(invalid).toBe(3);
  });

  it("files each answer once under marina:prophet with the board's source and eval mode", () => {
    const { entries } = parseJournal(
      journal([
        { event: "ev-1", mode: "live", answer: exclusive },
        { event: "ev-2", mode: "measure", answer: yesNo },
      ]),
    );
    expect(fileProphetAnswers(db, entries)).toEqual({ filed: 2, existing: 0, failed: 0 });
    // Filing again keeps the first row.
    expect(fileProphetAnswers(db, entries)).toEqual({ filed: 0, existing: 2, failed: 0 });
    const live = db.getForecastAnswerByExternalId(PROPHET_OWNER, prophetExternalId("ev-1"))!;
    expect(live.source).toBe("prophet-arena");
    expect(live.eval_mode).toBe("live");
    expect(live.kind).toBe("choice");
    const replay = db.getForecastAnswerByExternalId(PROPHET_OWNER, "prophet:ev-2")!;
    expect(replay.eval_mode).toBe("measure");
  });

  it("maps resolved outcome names to each answer's own option ids", () => {
    expect(prophetResolutionValue(exclusive, ["Green"])).toEqual({ options: ["B"] });
    expect(prophetResolutionValue(exclusive, ["Blue"])).toBeUndefined();
    expect(prophetResolutionValue(yesNo, ["before 2027"])).toEqual({ options: ["A"] });
    expect(prophetResolutionValue(yesNo, [])).toEqual({ options: ["B"] });
    expect(prophetResolutionValue(part(["X", "Y", "Z"]), ["Y", "Z"])).toEqual({
      options: ["B", "C"],
    });
    // A part none of whose outcomes happened cannot be scored as a multi-select.
    expect(prophetResolutionValue(part(["X"]), ["Y"])).toBeUndefined();
  });

  it("resolves through the one outcome path: one outcome row, lessons and history pending", () => {
    fileProphetAnswers(
      db,
      parseJournal(
        journal([
          { event: "ev-1", mode: "live", answer: exclusive },
          { event: "wide", mode: "live", part: 0, answer: part(["P", "Q"]) },
          { event: "wide", mode: "live", part: 1, answer: part(["R", "S"]) },
        ]),
      ).entries,
    );
    const resolutions = parseResolutions(
      JSON.stringify([
        { event: "ev-1", outcome: "Red", resolvedAt: "2026-10-10T00:00:00Z" },
        { event: "wide", outcomes: ["Q"] },
        { event: "never-filed", outcome: "x" },
      ]),
    );
    const now = Date.parse("2026-10-12T00:00:00Z");
    expect(resolveProphetAnswers(db, resolutions, now)).toEqual({
      settled: 2,
      already: 0,
      unfiled: 1,
      // Part 1 (R, S): neither happened — unscorable, stays open.
      unscored: 1,
    });
    const row = db.getForecastAnswerByExternalId(PROPHET_OWNER, "prophet:ev-1")!;
    expect(row.resolved_at).toBe(Date.parse("2026-10-10T00:00:00Z"));
    const outcome = db.getOutcomeBySubject(`forecast:${row.id}`)!;
    expect(outcome.kind).toBe("forecast");
    expect(outcome.source).toBe("prophet-arena:choice");
    expect(outcome.eval_mode).toBe("live");
    expect(outcome.succeeded).toBe(1);
    const refs = JSON.parse(outcome.refs_json ?? "[]") as string[];
    expect(refs).toContain("prophet:ev-1");
    expect(refs).toContain("prophet-event:ev-1");
    // Lessons and history are delivered from this row by the server's delivery pass.
    expect(
      db
        .outcomeDeliveries(outcome.id)
        .map((d) => [d.consumer, d.state])
        .sort(),
    ).toEqual([
      ["history", "pending"],
      ["lessons", "pending"],
    ]);
    // Resolving again: already settled; the wide event's open part stays open.
    expect(resolveProphetAnswers(db, resolutions, now)).toEqual({
      settled: 0,
      already: 2,
      unfiled: 1,
      unscored: 1,
    });
  });
});
