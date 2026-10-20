// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Residents' own forecasts on the one outcome path: a market room's `predict`
 * and `conduct track` file a `forecast_answers` row that resolves with its
 * Sample, records one outcome (lessons, never the pipeline's forecast
 * history), and credits `forecast_resolved` standing to whoever produced it —
 * the filer and any producers its filing names — under the daily cap and the
 * independence rule, one party at a time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ledgerFor } from "../src/agent/standing";
import { fileAnswer, fileResidentForecast } from "../src/outcomes/filing";
import { producersOf, resolveForecast } from "../src/outcomes/forecast";
import { consumersFor, settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { forecastQuestionFinder, inworldMarketResolverFinder } from "../src/resolvers/calibration";
import type { Sample } from "../src/resolvers/types";
import type { CommandInput, EntityId, RoomContext } from "../src/types";
import { marketRooms } from "../worlds/markets";
import { cleanupDb } from "./helpers";

const TEST_DB = `test_resident_forecast_outcomes_${process.pid}.db`;

const resolved = (id: string, outcome: "yes" | "no", resolvedBy?: string): Sample => ({
  kind: "resolving",
  id,
  ts: Date.now(),
  status: "resolved",
  value: { outcome, ...(resolvedBy ? { resolvedBy } : {}) },
  source: id,
});

const forecastCredits = (db: MarinaDB, id: string) =>
  ledgerFor(db, id).filter((r) => r.kind === "forecast_resolved");

describe("resident forecasts on the outcome path", () => {
  let db: MarinaDB;
  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    for (const [id, name] of [
      ["u_ann", "Ann"],
      ["u_bob", "Bob"],
      ["u_cy", "Cy"],
      ["u_ops", "Ops"],
    ] as const)
      db.createUser({ id, name });
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
    cleanupDb(TEST_DB);
  });

  it("files once per call; a newer call supersedes the open one, unscored", () => {
    const base = {
      owner: "Ann",
      source: "market" as const,
      key: "inworld:market:geo",
      sampleId: "inworld/market:geo",
      question: "Will it happen?",
      answer: { direction: "yes" },
    };
    const first = fileResidentForecast(db, { ...base, probability: 0.6 }, 1_000)!;
    const second = fileResidentForecast(db, { ...base, probability: 0.8 }, 2_000)!;
    expect(second).not.toBe(first);
    expect(db.getForecastAnswer(first)).toMatchObject({ resolved_at: 2_000, score: null });
    expect(JSON.parse(db.getForecastAnswer(first)!.outcome_json!)).toEqual({ superseded: true });
    expect(db.openForecastsForSample("inworld/market:geo").map((f) => f.id)).toEqual([second]);
    expect(db.getOutcomeBySubject(`forecast:${first}`)).toBeUndefined();
    // Another resident's call on the same market is its own.
    const other = fileResidentForecast(db, { ...base, owner: "Bob", probability: 0.3 }, 3_000)!;
    expect(db.openForecastsForSample("inworld/market:geo").map((f) => f.id)).toEqual([
      second,
      other,
    ]);
  });

  it("an in-world market's resolution settles each call once, teaches, and pays independent residents", () => {
    // A market room's `predict`, through the room module itself.
    const room = marketRooms()["markets/geo"]!;
    const store = new Map<string, unknown>();
    const entities = [
      { id: "e_ann" as EntityId, name: "Ann", properties: {} },
      { id: "e_ops" as EntityId, name: "Ops", properties: {} },
    ];
    const ctx = {
      roomId: "markets/geo",
      entities,
      getEntity: (id: EntityId) => entities.find((e) => e.id === id),
      store: {
        get: (k: string) => store.get(k),
        set: (k: string, v: unknown) => void store.set(k, v),
        delete: (k: string) => store.delete(k),
        keys: () => [...store.keys()],
      },
      send: () => {},
      broadcast: () => {},
      fileForecast: (p: Parameters<NonNullable<RoomContext["fileForecast"]>>[0]) =>
        fileResidentForecast(db, p),
    } as unknown as RoomContext;
    const predict = room.commands!.predict as (c: RoomContext, i: CommandInput) => void;
    predict(ctx, {
      entity: "e_ann" as EntityId,
      verb: "predict",
      args: "yes 90 treaty talks",
    } as CommandInput);
    // The room's own board keeps working.
    expect((store.get("positions") as unknown[]).length).toBe(1);
    const [filed] = db.openForecastsForSample("inworld/market:geo");
    expect(filed).toMatchObject({ entity_name: "Ann", kind: "probability", source: "market" });
    expect(filed!.probability).toBeCloseTo(0.9, 6);

    const sample = resolved("inworld/market:geo", "yes", "Ops");
    inworldMarketResolverFinder.calibrate(db, sample);
    forecastQuestionFinder.calibrate(db, sample);
    const outcome = db.getOutcomeBySubject(`forecast:${filed!.id}`)!;
    expect(outcome).toMatchObject({ kind: "forecast", source: "market:probability", succeeded: 1 });
    expect(JSON.parse(outcome.participants_json!)).toEqual([{ agent: "Ann" }]);
    // Lessons, never the forecast pipeline's history.
    expect(db.outcomeDeliveries(outcome.id).map((d) => d.consumer)).toEqual(["lessons"]);
    expect(forecastCredits(db, "u_ann")[0]?.amount).toBeCloseTo(0.48, 3);
  });

  it("a resident who resolves its own market earns nothing for its call", () => {
    const id = fileResidentForecast(db, {
      owner: "Ops",
      source: "market",
      key: "inworld:m1",
      sampleId: "inworld/m1",
      question: "q",
      probability: 0.95,
      answer: {},
    })!;
    forecastQuestionFinder.calibrate(db, resolved("inworld/m1", "yes", "Ops"));
    expect(db.getForecastAnswer(id)?.resolved_at).not.toBeNull();
    expect(forecastCredits(db, "u_ops")).toHaveLength(0);
  });

  it("`conduct track` sources resolve through the same path, lessons only", () => {
    expect(consumersFor("forecast", "mechanical", { source: "conduct:probability" })).toEqual([
      "lessons",
    ]);
    expect(consumersFor("forecast", "mechanical", { source: "forecast:probability" })).toEqual([
      "lessons",
      "history",
    ]);
    const id = fileResidentForecast(db, {
      owner: "Bob",
      source: "conduct",
      key: "conduct:chain:kalshi/X",
      sampleId: "kalshi/X",
      question: "Score chain on kalshi/X",
      probability: 0.2,
      answer: { score: "chain" },
    })!;
    forecastQuestionFinder.calibrate(db, resolved("kalshi/X", "no"));
    expect(db.getOutcomeBySubject(`forecast:${id}`)).toMatchObject({
      source: "conduct:probability",
      succeeded: 1,
    });
    expect(forecastCredits(db, "u_bob")).toHaveLength(1);
  });

  it("credits each independent producer a filing names, one party once, under the daily cap", () => {
    // Cy's agent is in Cy's lineage: one party with Cy.
    db.saveAgentConfig({ name: "cy-bot", model: "marina/default", spawnedBy: "Cy" });
    db.createUser({ id: "u_cybot", name: "cy-bot" });
    const id = fileAnswer(
      db,
      { question: "q", kind: "probability", probability: 0.9, answer: { note: "x" } },
      {
        owner: "Ann",
        source: "board",
        externalId: "board:1",
        producers: ["Bob", "Cy", "cy-bot", "Ann", "bob"],
      },
    )!;
    expect(producersOf(db.getForecastAnswer(id)!)).toEqual(["Bob", "Cy", "cy-bot"]);
    resolveForecast(db, id, { outcome: "yes" }, Date.now());
    expect(forecastCredits(db, "u_ann")).toHaveLength(1);
    expect(forecastCredits(db, "u_bob")).toHaveLength(1);
    expect(forecastCredits(db, "u_cy")).toHaveLength(1);
    expect(forecastCredits(db, "u_cybot")).toHaveLength(0);
    const outcome = db.getOutcomeBySubject(`forecast:${id}`)!;
    expect(
      (JSON.parse(outcome.participants_json!) as { agent: string }[]).map((p) => p.agent),
    ).toEqual(["Ann", "Bob", "Cy", "cy-bot"]);

    // Bob is at today's cap; Cy's lineage cannot collect what Cy was refused.
    const again = fileAnswer(
      db,
      { question: "q2", kind: "probability", probability: 0.9, answer: {} },
      { owner: "Bob", source: "board", externalId: "board:2", producers: ["cy-bot"] },
    )!;
    resolveForecast(db, again, { outcome: "yes" }, Date.now());
    expect(forecastCredits(db, "u_bob")).toHaveLength(1);
    expect(forecastCredits(db, "u_cybot")).toHaveLength(1);
  });

  it("producers never earn from a resolver in their own party, nor from a measurement filing", () => {
    const measured = fileAnswer(
      db,
      { question: "q", kind: "probability", probability: 0.9, answer: {} },
      { owner: "Ann", source: "board", externalId: "m:1", evalMode: "measure", producers: ["Bob"] },
    )!;
    resolveForecast(db, measured, { outcome: "yes" }, Date.now());
    const live = fileAnswer(
      db,
      { question: "q", kind: "probability", probability: 0.9, answer: {} },
      { owner: "Ann", source: "board", externalId: "l:1", producers: ["Bob"] },
    )!;
    resolveForecast(db, live, { outcome: "yes" }, Date.now(), { resolvedBy: "Bob" });
    expect(forecastCredits(db, "u_bob")).toHaveLength(0);
    expect(forecastCredits(db, "u_ann")).toHaveLength(1);
  });

  it("an answer filed without producers records no participants (unchanged)", () => {
    const id = fileAnswer(
      db,
      { question: "q", kind: "probability", probability: 0.7, answer: { a: 1 } },
      { owner: "Ann", source: "board", externalId: "plain:1" },
    )!;
    expect(db.getForecastAnswer(id)!.answer_json).toBe('{"a":1}');
    resolveForecast(db, id, { outcome: "yes" }, Date.now());
    expect(db.getOutcomeBySubject(`forecast:${id}`)!.participants_json).toBeNull();
  });
});
