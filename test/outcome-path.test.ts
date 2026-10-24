// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider } from "../src/decisions/types";
import { jsonlHistory } from "../src/forecast/history";
import { memoryLessonSink } from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  recallLessons,
} from "../src/learning/service";
import {
  AGGREGATE_MIN_OUTCOMES,
  deliverOutcomes,
  MAX_DELIVERY_ATTEMPTS,
} from "../src/outcomes/deliver";
import { fileAnswer, resolveFiled } from "../src/outcomes/filing";
import { resolveForecast } from "../src/outcomes/forecast";
import { observeOutcomeEvent } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
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

  /** A writer that always gives a rule, recording what it was shown. */
  const ruleWriter = (seen: string[] = []) => ({
    name: "test/writer",
    async complete(system: string, user: string) {
      seen.push(`${system}\n${user}`);
      return '{"category":"calibration","rule":"Discount strong priors on policy questions."}';
    },
  });
  const resolveMany = (n: number, over: Record<string, unknown> = {}) => {
    const ids = Array.from({ length: n }, () => file(db, over));
    for (const id of ids) resolveForecast(db, id, { outcome: "no" }, 1_900_000_000_000);
    return ids;
  };
  const lessonDelivery = (id: number) => {
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    return db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")!;
  };

  it("forecasts wait (no attempt spent) and teach ONE aggregate lesson once AGGREGATE_MIN_OUTCOMES wait", async () => {
    const first = resolveMany(AGGREGATE_MIN_OUTCOMES - 1);
    await settleDelivery(db);
    // Not armed yet: each waits for its group.
    await deliverOutcomes(db, { env: env() });
    for (const id of first)
      expect(lessonDelivery(id)).toMatchObject({ state: "pending", attempts: 0 });
    expect(lessonDelivery(first[0]!).reason).toStartWith("aggregating: ");

    const sink = memoryLessonSink();
    const seen: string[] = [];
    enableOutcomeLearning(db, { sink, writer: ruleWriter(seen), judge: judge(), env: env() });
    // One short of the group: nothing is written, nothing is asked.
    await deliverOutcomes(db, { env: env() });
    expect(sink.all()).toHaveLength(0);
    expect(seen).toHaveLength(0);
    for (const id of first) expect(lessonDelivery(id).state).toBe("pending");

    // The group is complete: the next pass (here the background one) learns it.
    const [last] = resolveMany(1);
    await settleDelivery(db);
    await deliverOutcomes(db, { env: env() });
    for (const id of [...first, last!]) {
      expect(lessonDelivery(id).state).toBe("done");
      expect(lessonDelivery(id).reason).toBe(`aggregate of ${AGGREGATE_MIN_OUTCOMES}: trusted`);
    }
    const lessons = sink.all().filter((l) => l.domain !== "meta");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      domain: "forecast",
      source: "forecast:probability",
      rule: "Discount strong priors on policy questions.",
      provenance: { learner: "outcome-aggregate", aggregate: String(AGGREGATE_MIN_OUTCOMES) },
    });
    // The aggregate prompt, cross-outcome statistics, and the questions only as private context.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("a batch of outcomes of the same kind");
    expect(seen[0]).toContain(`0 of ${AGGREGATE_MIN_OUTCOMES} succeeded`);
    expect(seen[0]).toContain("Context (do not quote)");
    expect(seen[0]).toContain("Will the Fed cut in October?");
  });

  it("a group waiting for aggregation survives a restart", async () => {
    const path = join(dir, "outcomes.db");
    let disk = new MarinaDB(path);
    const fileOn = (d: MarinaDB) => {
      const id = file(d);
      resolveForecast(d, id, { outcome: "yes" }, 1_900_000_000_000);
      return id;
    };
    try {
      const before = [fileOn(disk), fileOn(disk), fileOn(disk)];
      await settleDelivery(disk);
      enableOutcomeLearning(disk, {
        sink: memoryLessonSink(),
        writer: ruleWriter(),
        judge: judge(),
        env: env(),
      });
      await deliverOutcomes(disk, { env: env() });
      await settleDelivery(disk);
      disableOutcomeLearning(disk);
      disk.close();

      // A new process: the waiting deliveries are still there, held for the group.
      disk = new MarinaDB(path);
      expect(disk.pendingOutcomes("lessons", 10, { aggregating: true })).toHaveLength(3);
      const sink = memoryLessonSink();
      enableOutcomeLearning(disk, { sink, writer: ruleWriter(), judge: judge(), env: env() });
      fileOn(disk);
      fileOn(disk);
      await settleDelivery(disk);
      await deliverOutcomes(disk, { env: env() });
      expect(sink.all().filter((l) => l.domain !== "meta")).toHaveLength(1);
      for (const id of before) {
        const o = disk.getOutcomeBySubject(`forecast:${id}`)!;
        expect(disk.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")?.state).toBe(
          "done",
        );
      }
    } finally {
      await settleDelivery(disk);
      disableOutcomeLearning(disk);
      disk.close();
    }
  });

  it("the hourly budget defers lessons and drops none", async () => {
    resolveMany(AGGREGATE_MIN_OUTCOMES);
    resolveMany(AGGREGATE_MIN_OUTCOMES, { source: "board" });
    await settleDelivery(db);
    // Armed with a budget of one: one group's lesson now, the other waits for the next window.
    const limited = env({ MARINA_LESSONS_MAX_PER_HOUR: "1" });
    enableOutcomeLearning(db, {
      sink: memoryLessonSink(),
      writer: ruleWriter(),
      judge: judge(),
      env: limited,
    });
    const report = await deliverOutcomes(db, { env: limited });
    expect(report.lessons).toMatchObject({ done: AGGREGATE_MIN_OUTCOMES, failed: 0 });
    expect(db.pendingOutcomes("lessons", 20)).toHaveLength(AGGREGATE_MIN_OUTCOMES);
  });

  it("no verdict keeps a group pending and counts the attempt; repeated failures end failed", async () => {
    const ids = resolveMany(AGGREGATE_MIN_OUTCOMES);
    await settleDelivery(db);
    enableOutcomeLearning(db, {
      sink: memoryLessonSink(),
      writer: ruleWriter(),
      judge: judge(true),
      env: env(),
    });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i++) {
      await deliverOutcomes(db, { env: env() });
      expect(lessonDelivery(ids[0]!).state).toBe("pending");
      expect(lessonDelivery(ids[0]!).reason).toStartWith("aggregating: ");
    }
    await deliverOutcomes(db, { env: env() });
    for (const id of ids)
      expect(lessonDelivery(id)).toMatchObject({
        state: "failed",
        attempts: MAX_DELIVERY_ATTEMPTS,
      });
    expect(lessonDelivery(ids[0]!).reason).toContain("no verdict");
  });

  it("groups by family: a lesson is learned per family, scoped to it, and judged within it", async () => {
    const sink = memoryLessonSink();
    const seen: string[] = [];
    const j = judge();
    const asked: unknown[] = [];
    const recording = {
      ...j,
      async ask(request: { state: unknown; questions: Record<string, unknown> }) {
        asked.push(request.state);
        return (j as unknown as { ask: (r: unknown) => Promise<unknown> }).ask(request);
      },
    } as unknown as DecisionProvider;
    const byFamily = (family: string, n: number) =>
      Array.from({ length: n }, () => {
        const id = file(db);
        resolveForecast(db, id, { outcome: "no" }, 1_900_000_000_000, {
          refs: [`family:${family}`],
        });
        return id;
      });
    byFamily("civiqs", AGGREGATE_MIN_OUTCOMES - 1);
    byFamily("yougov", AGGREGATE_MIN_OUTCOMES - 1);
    await settleDelivery(db);
    enableOutcomeLearning(db, { sink, writer: ruleWriter(seen), judge: recording, env: env() });
    // Eight waiting, but no family has five: nothing is learned.
    await deliverOutcomes(db, { env: env() });
    expect(sink.all()).toHaveLength(0);
    byFamily("civiqs", 1);
    await settleDelivery(db);
    await deliverOutcomes(db, { env: env() });
    const learned = sink.all().filter((l) => l.domain !== "meta");
    expect(learned).toHaveLength(1);
    expect(learned[0]!.scopeFamily).toBe("civiqs");
    expect(learned[0]!.refs).toContain("family:civiqs");
    // The judge's `general` question is asked within the declared scope.
    expect(asked[0]).toMatchObject({
      applies_to: { source: "forecast:probability", family: "civiqs" },
    });
    expect(db.pendingOutcomes("lessons", 20, { aggregating: true })).toHaveLength(
      AGGREGATE_MIN_OUTCOMES - 1,
    );
  });

  it("with no model provider, nothing throws, fails or is written: deliveries wait with the reason", async () => {
    // Writer and judge from the environment, which names no provider at all.
    const bare = { MARINA_LESSONS: "on" } as NodeJS.ProcessEnv;
    const sink = memoryLessonSink();
    enableOutcomeLearning(db, { sink, env: bare });
    db.saveAgentConfig({ name: "Roamer", model: "vendor/model-b", spawnedBy: "system" });
    const ids = resolveMany(AGGREGATE_MIN_OUTCOMES);
    observeOutcomeEvent(db, {
      type: "task_approved",
      entity: "e_creator" as EntityId,
      taskId: 1,
      claimantName: "Roamer",
      timestamp: 1_000,
    });
    await settleDelivery(db);
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) {
      const report = await deliverOutcomes(db, { env: bare });
      expect(report.lessons?.failed ?? 0).toBe(0);
      expect(report.lessons?.done ?? 0).toBe(0);
    }
    for (const id of ids)
      expect(lessonDelivery(id)).toMatchObject({ state: "pending", attempts: 0 });
    expect(lessonDelivery(ids[0]!).reason).toContain("no model provider configured");
    const task = db.listOutcomes({ kind: "task" })[0]!;
    expect(db.outcomeDeliveries(task.id).find((d) => d.consumer === "lessons")).toMatchObject({
      state: "pending",
      attempts: 0,
      reason: "waiting: no model provider configured",
    });
    expect(sink.all()).toHaveLength(0);
    const recalled = await recallLessons(db, "forecast", "Fed cut", { env: bare });
    expect(recalled.recalled).toEqual([]);
  });

  it("a measurement run of a named board teaches (as that board) but never tunes", async () => {
    const path = join(dir, "history.jsonl");
    const sink = memoryLessonSink();
    enableOutcomeLearning(db, { sink, writer: null, judge: judge(), env: env() });
    const id = file(db, { evalMode: "measure", source: "prophet" });
    resolveForecast(db, id, { outcome: "yes" }, 1);
    await settleDelivery(db);
    await deliverOutcomes(db, { env: env({ MARINA_FORECAST_HISTORY: path }) });
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    expect(o).toMatchObject({ eval_mode: "measure", source: "prophet:probability" });
    const states = db.outcomeDeliveries(o.id).map((d) => [d.consumer, d.state, d.reason]);
    expect(states[0]).toEqual(["history", "skipped", "measurement"]);
    expect(states[1]?.[0]).toBe("lessons");
    expect(states[1]?.[1]).not.toBe("skipped");
    expect(await jsonlHistory(path).all()).toHaveLength(0);
  });

  it("a measurement run that names no board is skipped (its own board could not be fenced off)", async () => {
    enableOutcomeLearning(db, {
      sink: memoryLessonSink(),
      writer: null,
      judge: judge(),
      env: env(),
    });
    const id = file(db, { evalMode: "measure" });
    resolveForecast(db, id, { outcome: "yes" }, 1);
    await settleDelivery(db);
    await deliverOutcomes(db, { env: env() });
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    expect(o).toMatchObject({ eval_mode: "measure", source: "forecast:probability" });
    expect(db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")).toMatchObject({
      state: "skipped",
      reason: "measurement without a board",
    });
  });

  it("history records the formation that answered and its score (routing evidence)", async () => {
    const path = join(dir, "history.jsonl");
    const id = file(db, {
      probability: 0.7,
      answerJson: JSON.stringify({
        pipeline: "typed",
        typed: { formation: { pattern: "delphi" } },
      }),
    });
    {
      using _ = scopeProcessState({ env: { MARINA_FORECAST_HISTORY: path } });
      resolveForecast(db, id, { outcome: "yes" }, 1_900_000_000_000);
      await settleDelivery(db);
      await deliverOutcomes(db);
    }
    const [record] = await jsonlHistory(path).all();
    expect(record).toMatchObject({ id: `forecast:${id}`, formation: "delphi" });
    expect(record!.score).toBeGreaterThan(0.9);
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
