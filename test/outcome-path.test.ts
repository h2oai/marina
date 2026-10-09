// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider } from "../src/decisions/types";
import { jsonlHistory } from "../src/forecast/history";
import { memoryLessonSink } from "../src/learning/outcomes";
import { disableOutcomeLearning, enableOutcomeLearning } from "../src/learning/service";
import { deliverOutcomes, MAX_DELIVERY_ATTEMPTS } from "../src/outcomes/deliver";
import { fileAnswer, resolveFiled } from "../src/outcomes/filing";
import { resolveForecast } from "../src/outcomes/forecast";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { scopeProcessState } from "./process-state";

const judge = (fail = false): DecisionProvider =>
  ({
    kind: "test",
    model: "test/jev",
    calibrated: true,
    async ask(request: { questions: Record<string, unknown> }) {
      if (fail) throw new Error("judge timeout");
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: 0.9 }]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      };
    },
  }) as unknown as DecisionProvider;

const file = (db: MarinaDB, over: Record<string, unknown> = {}) =>
  db.saveForecastAnswer({
    entityName: "Ada",
    question: "Will the Fed cut in October?",
    kind: "probability",
    probability: 0.8,
    answerJson: "{}",
    ...over,
  });

describe("one outcome path", () => {
  let db: MarinaDB;
  let dir: string;
  const env = (over: Record<string, string> = {}) => ({ MARINA_LESSONS: "on", ...over });
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    dir = mkdtempSync(join(tmpdir(), "marina-outcomes-"));
  });
  afterEach(async () => {
    await settleDelivery(db);
    disableOutcomeLearning(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("settles an answer once and records one outcome with a pending delivery per consumer", async () => {
    const id = file(db);
    const r = resolveForecast(db, id, { outcome: "yes" }, 1_900_000_000_000, {
      refs: ["sample:kalshi/FED"],
    });
    expect(r).toMatchObject({ answerId: id, succeeded: true });
    expect(r!.loss).toBeCloseTo(0.04, 6);
    expect(resolveForecast(db, id, { outcome: "no" }, 1_900_000_000_001)).toBeUndefined();
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    expect(o).toMatchObject({
      kind: "forecast",
      source: "forecast:probability",
      owner: "Ada",
      succeeded: 1,
      basis: "mechanical",
      resolved_at: 1_900_000_000_000,
    });
    expect(o.quality).toBeCloseTo(0.96, 6);
    expect(JSON.parse(o.refs_json!)).toEqual([`forecast:${id}`, "sample:kalshi/FED"]);
    // No question text on the outcome: it stays on the subject row.
    expect(JSON.stringify(o)).not.toContain("Fed cut");
    const raw = (db as unknown as { db: { run(sql: string): unknown } }).db;
    expect(() => raw.run("UPDATE outcomes SET succeeded = 0")).toThrow(/append-only/);
    await settleDelivery(db);
    expect(db.outcomeDeliveries(o.id).map((d) => d.consumer)).toEqual(["history", "lessons"]);
  });

  it("an unscorable outcome leaves the answer open and records nothing", () => {
    const id = file(db);
    expect(resolveForecast(db, id, { value: 3 }, 1)).toBeUndefined();
    expect(db.getForecastAnswer(id)!.resolved_at).toBeNull();
    expect(db.listOutcomes()).toHaveLength(0);
  });

  it("lessons wait until learning is armed, then are judged with the subject's private context", async () => {
    const id = file(db);
    resolveForecast(db, id, { outcome: "no" }, 1_900_000_000_000);
    await settleDelivery(db);
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    const lessons = () => db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")!;
    expect(lessons().state).toBe("pending");

    const sink = memoryLessonSink();
    const seen: string[] = [];
    enableOutcomeLearning(db, {
      sink,
      writer: {
        name: "test/writer",
        async complete(system: string, user: string) {
          seen.push(`${system}\n${user}`);
          return '{"category":"calibration","rule":"Discount strong priors."}';
        },
      },
      judge: judge(),
      env: env(),
    });
    const report = await deliverOutcomes(db, { env: env() });
    expect(report.lessons).toMatchObject({ done: 1 });
    expect(lessons().state).toBe("done");
    expect(seen.join("\n")).toContain("Will the Fed cut in October?");
  });

  it("the hourly budget defers lessons and drops none", async () => {
    const ids = [file(db), file(db), file(db)];
    for (const id of ids) resolveForecast(db, id, { outcome: "yes" }, 1);
    await settleDelivery(db);
    // Armed with a budget of one: one lesson now, two wait for the next window.
    const limited = env({ MARINA_LESSONS_MAX_PER_HOUR: "1" });
    enableOutcomeLearning(db, {
      sink: memoryLessonSink(),
      writer: null,
      judge: judge(),
      env: limited,
    });
    const report = await deliverOutcomes(db, { env: limited });
    expect(report.lessons).toEqual({ done: 1, skipped: 0, failed: 0, waiting: 2 });
    expect(db.pendingOutcomes("lessons", 10)).toHaveLength(2);
  });

  it("no verdict keeps a lesson pending and counts the attempt; repeated failures end failed", async () => {
    const id = file(db);
    resolveForecast(db, id, { outcome: "yes" }, 1);
    await settleDelivery(db);
    enableOutcomeLearning(db, {
      sink: memoryLessonSink(),
      writer: null,
      judge: judge(true),
      env: env(),
    });
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    const lessons = () => db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")!;
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i++) {
      await deliverOutcomes(db, { env: env() });
      expect(lessons().state).toBe("pending");
    }
    await deliverOutcomes(db, { env: env() });
    expect(lessons()).toMatchObject({ state: "failed", attempts: MAX_DELIVERY_ATTEMPTS });
    expect(lessons().reason).toContain("no verdict");
  });

  it("a measurement run is recorded but never teaches or tunes", async () => {
    const path = join(dir, "history.jsonl");
    enableOutcomeLearning(db, {
      sink: memoryLessonSink(),
      writer: null,
      judge: judge(),
      env: env(),
    });
    const id = file(db, { evalMode: "measure", source: "prophet" });
    resolveForecast(db, id, { outcome: "yes" }, 1);
    await settleDelivery(db);
    await deliverOutcomes(db, { env: env({ MARINA_FORECAST_HISTORY: path }) });
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    expect(o).toMatchObject({ eval_mode: "measure", source: "prophet:probability" });
    expect(db.outcomeDeliveries(o.id).map((d) => [d.consumer, d.state, d.reason])).toEqual([
      ["history", "skipped", "measurement"],
      ["lessons", "skipped", "measurement"],
    ]);
    expect(await jsonlHistory(path).all()).toHaveLength(0);
  });

  it("history gets a plain probability as a yes/no record, and skips with a reason when unset", async () => {
    const path = join(dir, "history.jsonl");
    const a = file(db, { probability: 0.7 });
    const b = file(db);
    {
      using _ = scopeProcessState({ env: { MARINA_FORECAST_HISTORY: path } });
      resolveForecast(db, a, { outcome: "yes" }, 1_900_000_000_000);
      await settleDelivery(db);
      await deliverOutcomes(db);
    }
    const [record] = await jsonlHistory(path).all();
    expect(record).toMatchObject({
      id: `forecast:${a}`,
      answerType: "choice",
      raw: { distribution: { yes: 0.7, no: expect.closeTo(0.3, 6) } },
      outcome: { options: ["yes"] },
    });
    using _ = scopeProcessState({ env: { MARINA_FORECAST_HISTORY: undefined } });
    resolveForecast(db, b, { outcome: "no" }, 1);
    await settleDelivery(db);
    await deliverOutcomes(db);
    const ob = db.getOutcomeBySubject(`forecast:${b}`)!;
    expect(db.outcomeDeliveries(ob.id).find((d) => d.consumer === "history")).toMatchObject({
      state: "skipped",
      reason: "no history configured",
    });
  });

  it("lessons off skips every pending lesson with the reason", async () => {
    const id = file(db);
    resolveForecast(db, id, { outcome: "yes" }, 1);
    await settleDelivery(db);
    await deliverOutcomes(db, { env: { MARINA_LESSONS: "off" } });
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    expect(db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")).toMatchObject({
      state: "skipped",
      reason: "lessons off",
    });
  });

  it("a board's answer is found by its own id, unique per owner", () => {
    const id = file(db, { externalId: "metaculus:q42", source: "metaculus", evalMode: "live" });
    expect(db.getForecastAnswerByExternalId("Ada", "metaculus:q42")?.id).toBe(id);
    expect(() => file(db, { externalId: "metaculus:q42" })).toThrow();
    expect(file(db, { entityName: "Bo", externalId: "metaculus:q42" })).toBeGreaterThan(id);
  });
});

describe("board filing on the outcome path", () => {
  it("files once per owner and id, and tells unfiled from settled", async () => {
    const db = new MarinaDB(":memory:");
    const filing = { owner: "marina:board", source: "board", externalId: "board:q1" };
    const id = fileAnswer(
      db,
      { question: "q", kind: "probability", probability: 0.6, answer: {} },
      filing,
    );
    expect(
      fileAnswer(db, { question: "q", kind: "probability", probability: 0.1, answer: {} }, filing),
    ).toBe(id);
    expect(db.getForecastAnswer(id!)!.probability).toBe(0.6);
    expect(resolveFiled(db, "marina:board", "board:q2", { outcome: "yes" }, 1)).toBe("unfiled");
    expect(resolveFiled(db, "marina:board", "board:q1", { outcome: "yes" }, 1)).toMatchObject({
      answerId: id,
      succeeded: true,
    });
    expect(resolveFiled(db, "marina:board", "board:q1", { outcome: "no" }, 2)).toBe("settled");
    expect(db.getOutcomeBySubject(`forecast:${id}`)!.source).toBe("board:probability");
    await settleDelivery(db);
    db.close();
  });
});
