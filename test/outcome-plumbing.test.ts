// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Outcome delivery plumbing: stale aggregate groups, per-group claims, the
 * formation on history records, and the delivery backfill.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider } from "../src/decisions/types";
import { typedFormation } from "../src/forecast/formations";
import { jsonlHistory } from "../src/forecast/history";
import { recipeCard } from "../src/forecast/method-cards";
import { memoryLessonSink } from "../src/learning/outcomes";
import { disableOutcomeLearning, enableOutcomeLearning } from "../src/learning/service";
import {
  AGGREGATE_STALE_MIN_OUTCOMES,
  AGGREGATE_STALE_MS,
  aggregateReady,
  backfillOutcomeDeliveries,
  deliverOutcomes,
  formationFromMethodRef,
} from "../src/outcomes/deliver";
import { resolveForecast } from "../src/outcomes/forecast";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { AGGREGATING_REASON, type OutcomeInput } from "../src/persistence/db-outcomes";
import { noProviderEnv } from "./hermetic-env";
import { scopeProcessState } from "./process-state";

const DAY = 24 * 60 * 60 * 1000;

const judge = (): DecisionProvider =>
  ({
    kind: "test",
    model: "test/jev",
    calibrated: true,
    async ask(request: { questions: Record<string, unknown> }) {
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

/** A writer that always gives a rule; `delayMs` keeps a pass inside its model call. */
const ruleWriter = (seen: string[] = [], delayMs = 0) => ({
  name: "test/writer",
  async complete(system: string, user: string) {
    seen.push(`${system}\n${user}`);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return '{"category":"calibration","rule":"Discount strong priors on slow series."}';
  },
});

describe("outcome delivery plumbing", () => {
  let db: MarinaDB;
  let dir: string;
  const env = (over: Record<string, string> = {}) => ({ MARINA_LESSONS: "on", ...over });
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    dir = mkdtempSync(join(tmpdir(), "marina-outcome-plumbing-"));
  });
  afterEach(async () => {
    await settleDelivery(db);
    disableOutcomeLearning(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const file = (over: Record<string, unknown> = {}) =>
    db.saveForecastAnswer({
      entityName: "Ada",
      question: "Will the monthly index rise?",
      kind: "probability",
      probability: 0.7,
      answerJson: "{}",
      ...over,
    });
  const resolveMany = (n: number, refs: string[] = ["family:monthly"]) =>
    Array.from({ length: n }, () => {
      const id = file();
      resolveForecast(db, id, { outcome: "no" }, 1_900_000_000_000, { refs });
      return id;
    });
  const lessonDelivery = (id: number) => {
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    return db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")!;
  };
  const lessons = (sink: ReturnType<typeof memoryLessonSink>) =>
    sink.all().filter((l) => l.domain !== "meta");

  describe("stale aggregate groups", () => {
    it("is ready at 30 days with 3 outcomes, not at 29 days, never with 2", () => {
      const at = (n: number) => Array.from({ length: n }, () => ({ created_at: 0 }));
      expect(aggregateReady(at(5), 0)).toBe("full");
      expect(aggregateReady(at(3), AGGREGATE_STALE_MS)).toBe("stale");
      expect(aggregateReady(at(3), AGGREGATE_STALE_MS - 1)).toBeUndefined();
      expect(aggregateReady(at(2), AGGREGATE_STALE_MS * 10)).toBeUndefined();
      expect(AGGREGATE_STALE_MS).toBe(30 * DAY);
      expect(AGGREGATE_STALE_MIN_OUTCOMES).toBe(3);
    });

    it("learns a group of 3 once its oldest has waited 30 days, with the true N", async () => {
      const ids = resolveMany(3);
      const recorded = db.getOutcomeBySubject(`forecast:${ids[0]}`)!.created_at;
      await settleDelivery(db);
      const sink = memoryLessonSink();
      const seen: string[] = [];
      enableOutcomeLearning(db, { sink, writer: ruleWriter(seen), judge: judge(), env: env() });

      await deliverOutcomes(db, { env: env(), now: recorded + 29 * DAY });
      expect(lessons(sink)).toHaveLength(0);
      expect(seen).toHaveLength(0);
      for (const id of ids) expect(lessonDelivery(id)).toMatchObject({ state: "pending" });

      await deliverOutcomes(db, { env: env(), now: recorded + 30 * DAY });
      const learned = lessons(sink);
      expect(learned).toHaveLength(1);
      expect(learned[0]).toMatchObject({
        scopeFamily: "monthly",
        provenance: { learner: "outcome-aggregate", aggregate: "3" },
      });
      expect(seen[0]).toContain("0 of 3 succeeded");
      expect(seen[0]).toContain("only 3 outcomes");
      for (const id of ids)
        expect(lessonDelivery(id)).toMatchObject({
          state: "done",
          reason: "aggregate of 3: trusted",
        });
    });

    it("a group of 2 keeps waiting however long it waits", async () => {
      const ids = resolveMany(2);
      await settleDelivery(db);
      const sink = memoryLessonSink();
      enableOutcomeLearning(db, { sink, writer: ruleWriter(), judge: judge(), env: env() });
      await deliverOutcomes(db, { env: env(), now: Date.now() + 365 * DAY });
      expect(lessons(sink)).toHaveLength(0);
      for (const id of ids)
        expect(lessonDelivery(id)).toMatchObject({ state: "pending", attempts: 0 });
      expect(lessonDelivery(ids[0]!).reason).toStartWith(`${AGGREGATING_REASON}: `);
    });

    it("with no model provider a stale group waits: nothing throws, fails or is written", async () => {
      using _ = scopeProcessState({ env: { ...noProviderEnv(), MARINA_LESSONS: "on" } });
      const sink = memoryLessonSink();
      enableOutcomeLearning(db, { sink });
      const ids = resolveMany(3);
      await settleDelivery(db);
      for (let i = 0; i < 3; i++) {
        const report = await deliverOutcomes(db, { now: Date.now() + 40 * DAY });
        expect(report.lessons?.failed ?? 0).toBe(0);
        expect(report.lessons?.done ?? 0).toBe(0);
      }
      expect(lessons(sink)).toHaveLength(0);
      for (const id of ids)
        expect(lessonDelivery(id)).toMatchObject({ state: "pending", attempts: 0 });
      expect(lessonDelivery(ids[0]!).reason).toContain("no model provider configured");
      // The backfill and history need no model either.
      expect(() => backfillOutcomeDeliveries(db)).not.toThrow();
    });
  });

  describe("per-group claims", () => {
    it("two passes at once learn a group exactly once", async () => {
      const ids = resolveMany(5);
      await settleDelivery(db);
      const sink = memoryLessonSink();
      const seen: string[] = [];
      enableOutcomeLearning(db, {
        sink,
        writer: ruleWriter(seen, 25),
        judge: judge(),
        env: env(),
      });
      await Promise.all([deliverOutcomes(db, { env: env() }), deliverOutcomes(db, { env: env() })]);
      expect(lessons(sink)).toHaveLength(1);
      expect(seen).toHaveLength(1);
      for (const id of ids) expect(lessonDelivery(id).state).toBe("done");
    });

    it("a claim is all or none, hides the group from other passes, and releases intact", () => {
      const ids = resolveMany(3);
      const outcomeIds = ids.map((id) => db.getOutcomeBySubject(`forecast:${id}`)!.id);
      const held = `${AGGREGATING_REASON}: k`;
      for (const id of outcomeIds) db.waitOutcomeDelivery(id, "lessons", held);
      db.waitOutcomeDelivery(outcomeIds[2]!, "lessons", `${held}; no model provider configured`);
      const pending = () => db.pendingOutcomes("lessons", 10, { aggregating: true }).length;
      const lessonReason = (id: number) =>
        db.outcomeDeliveries(id).find((d) => d.consumer === "lessons")?.reason;

      expect(db.claimOutcomeDeliveries(outcomeIds, "lessons", held, "a")).toBe(true);
      expect(pending()).toBe(0);
      expect(db.pendingOutcomes("lessons", 10)).toHaveLength(0);
      // Another pass that scanned the same group cannot claim it.
      expect(db.claimOutcomeDeliveries(outcomeIds, "lessons", held, "b")).toBe(false);
      expect(db.releaseOutcomeClaims("lessons", "a")).toBe(3);
      expect(pending()).toBe(3);
      expect(lessonReason(outcomeIds[2]!)).toBe(`${held}; no model provider configured`);

      // One settled meanwhile: the whole claim is refused, nothing changes.
      db.setOutcomeDelivery(outcomeIds[0]!, "lessons", "done", "elsewhere");
      expect(db.claimOutcomeDeliveries(outcomeIds, "lessons", held, "c")).toBe(false);
      expect(pending()).toBe(2);

      // A claim left by a pass that died is released once stale.
      const rest = outcomeIds.slice(1);
      expect(db.claimOutcomeDeliveries(rest, "lessons", held, "d", 1_000)).toBe(true);
      expect(db.releaseStaleOutcomeClaims("lessons", 1_000)).toBe(0);
      expect(db.releaseStaleOutcomeClaims("lessons", 1_001)).toBe(2);
      expect(pending()).toBe(2);
      expect(lessonReason(rest[0]!)).toBe(held);
    });
  });

  describe("formation on history records", () => {
    it("maps a method ref to the formation routing reads", () => {
      expect(formationFromMethodRef(["family:x", "method:formation:delphi"])).toBe("delphi");
      expect(formationFromMethodRef(["method:formation:delphi+closed-book"])).toBe(
        "formation:delphi+closed-book",
      );
      expect(formationFromMethodRef(["method:nowcast"])).toBeUndefined();
      expect(formationFromMethodRef(["method:formation:symbiosis"])).toBeUndefined();
      expect(formationFromMethodRef(["method:model:vendor/m"])).toBeUndefined();
      expect(formationFromMethodRef([])).toBeUndefined();
      // Formation routing reads a plain formation; card routing reads both,
      // and a variant never counts as its plain formation.
      expect(typedFormation("delphi")).toBe("delphi");
      expect(typedFormation("formation:delphi+closed-book")).toBeUndefined();
      expect(recipeCard("delphi")?.id).toBe("formation:delphi");
      expect(recipeCard("formation:delphi+closed-book")?.id).toBe("formation:delphi+closed-book");
    });

    it("stamps `formation` from `method:formation:delphi`, and leaves it absent otherwise", async () => {
      const path = join(dir, "history.jsonl");
      const tagged = file();
      const plain = file();
      {
        using _ = scopeProcessState({ env: { MARINA_FORECAST_HISTORY: path } });
        resolveForecast(db, tagged, { outcome: "yes" }, 1_900_000_000_000, {
          refs: ["family:civiqs", "method:formation:delphi"],
        });
        resolveForecast(db, plain, { outcome: "yes" }, 1_900_000_000_000, {
          refs: ["method:nowcast"],
        });
        await settleDelivery(db);
        await deliverOutcomes(db);
      }
      const records = await jsonlHistory(path).all();
      const byId = new Map(records.map((r) => [r.id, r]));
      expect(byId.get(`forecast:${tagged}`)).toMatchObject({ formation: "delphi" });
      expect(byId.get(`forecast:${plain}`)).toBeDefined();
      expect("formation" in byId.get(`forecast:${plain}`)!).toBe(false);
    });
  });

  describe("delivery backfill", () => {
    const old = (over: Partial<OutcomeInput> & { subject: string }) =>
      db.recordOutcomeRow(
        {
          kind: "forecast",
          source: "forecast:probability",
          domain: "forecast",
          owner: "Ada",
          succeeded: false,
          quality: 0.5,
          basis: "mechanical",
          resolvedAt: 1_000,
          now: 1_000,
          ...over,
        },
        [],
      ).id;
    const consumers = (id: number) =>
      db.outcomeDeliveries(id).map((d) => [d.consumer, d.state, d.attempts, d.reason]);

    it("adds the rows consumersFor gives today, idempotently, never touching an existing row", () => {
      const live = old({ subject: `forecast:${file()}` });
      const resident = old({ subject: `forecast:${file()}`, source: "market:probability" });
      const bench = old({
        subject: "bench:run-1",
        kind: "benchmark",
        source: "benchmark:smoke",
        domain: "benchmark",
        evalMode: "measure",
      });
      const judged = old({
        subject: "judged:task:1:Ada:1",
        kind: "task",
        source: "task:verdict",
        domain: "tools",
        basis: "judged",
        judge: "decision:test",
      });
      // Already delivered to lessons; history is the only missing row.
      const partial = db.recordOutcomeRow(
        {
          subject: `forecast:${file()}`,
          kind: "forecast",
          source: "forecast:probability",
          domain: "forecast",
          succeeded: true,
          basis: "mechanical",
          resolvedAt: 1_000,
        },
        ["lessons"],
      ).id;
      db.setOutcomeDelivery(partial, "lessons", "done", "already learned");

      const first = backfillOutcomeDeliveries(db, { now: 5_000 });
      expect(first.added).toBe(4);
      expect(consumers(live)).toEqual([
        ["history", "pending", 0, null],
        ["lessons", "pending", 0, null],
      ]);
      expect(consumers(resident)).toEqual([["lessons", "pending", 0, null]]);
      expect(consumers(bench)).toEqual([]);
      expect(consumers(judged)).toEqual([]);
      expect(consumers(partial)).toEqual([
        ["history", "pending", 0, null],
        ["lessons", "done", 1, "already learned"],
      ]);

      const snapshot = [live, resident, bench, judged, partial].map(consumers);
      // Again (same process), and from a fresh scan (a restart): nothing changes.
      expect(backfillOutcomeDeliveries(db, { now: 6_000 }).added).toBe(0);
      expect(backfillOutcomeDeliveries(db, { now: 6_000, scan: 1 }).added).toBe(0);
      expect([live, resident, bench, judged, partial].map(consumers)).toEqual(snapshot);
    });

    it("scans a bounded window per call and resumes after it", () => {
      const ids = Array.from({ length: 5 }, () => old({ subject: `forecast:${file()}` }));
      expect(backfillOutcomeDeliveries(db, { scan: 2 })).toMatchObject({ scanned: 2, added: 4 });
      expect(consumers(ids[2]!)).toEqual([]);
      expect(backfillOutcomeDeliveries(db, { scan: 2 })).toMatchObject({ scanned: 2, added: 4 });
      expect(backfillOutcomeDeliveries(db, { scan: 2 })).toMatchObject({ scanned: 1, added: 2 });
      for (const id of ids) expect(consumers(id)).toHaveLength(2);
    });

    it("backfilled measurements follow the board rule: unnamed is skipped; neither writes history", async () => {
      const path = join(dir, "history.jsonl");
      const unnamed = old({ subject: `forecast:${file()}`, evalMode: "measure" });
      const named = old({
        subject: `forecast:${file()}`,
        evalMode: "measure",
        refs: ["eval:futurex"],
      });
      enableOutcomeLearning(db, {
        sink: memoryLessonSink(),
        writer: ruleWriter(),
        judge: judge(),
        env: env(),
      });
      await deliverOutcomes(db, { env: env({ MARINA_FORECAST_HISTORY: path }) });
      const state = (id: number, consumer: string) =>
        db.outcomeDeliveries(id).find((d) => d.consumer === consumer);
      expect(state(unnamed, "lessons")).toMatchObject({
        state: "skipped",
        reason: "measurement without a board",
      });
      expect(state(unnamed, "history")).toMatchObject({ state: "skipped", reason: "measurement" });
      expect(state(named, "history")).toMatchObject({ state: "skipped", reason: "measurement" });
      // A named board's forecast teaches: it waits for its group.
      expect(state(named, "lessons")).toMatchObject({ state: "pending", attempts: 0 });
      expect(state(named, "lessons")?.reason).toStartWith(`${AGGREGATING_REASON}: `);
      expect(await jsonlHistory(path).all()).toHaveLength(0);
    });
  });
});
