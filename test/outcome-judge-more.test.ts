// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Retriever } from "../src/arena/research/retrieve";
import { TaskManager } from "../src/coordination/task-manager";
import type { DecisionProvider } from "../src/decisions/types";
import { judgeAgreement } from "../src/outcomes/agreement";
import { judgeWaitingWork, QUALITY_GRACE_MS } from "../src/outcomes/judge-quality";
import { judgeOpenResolutions } from "../src/outcomes/judge-resolution";
import { recordTaskVerdict } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T00:00:00Z");
const ENV = { MARINA_OUTCOME_JUDGE: "observe", MARINA_DAILY_SPEND_CAP_USD: "off" };

/** A judge answering every noul question from `answers` (default 0.9). */
const judge = (answers: Record<string, number> = {}): DecisionProvider & { states: unknown[] } => {
  const j = {
    kind: "test",
    model: "jev",
    calibrated: true,
    states: [] as unknown[],
    async ask(request: { state: unknown; questions: Record<string, unknown> }) {
      j.states.push(request.state);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: answers[k] ?? 0.9 }]),
        ),
        model: "jev",
        provider: "test",
        latencyMs: 1,
      };
    },
  };
  return j as unknown as DecisionProvider & { states: unknown[] };
};

const report =
  (text: string): Retriever =>
  async () => ({
    report: text,
    sources: [{ url: "https://stats.example/a" }],
    costUsd: 0,
    searches: 1,
    retriever: "fake",
  });

describe("judged resolution: multi-select and numbers", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  const save = (
    answer: Record<string, unknown>,
    kind: string,
    over: Record<string, unknown> = {},
  ) =>
    db.saveForecastAnswer({
      entityName: "Ada",
      question: "q",
      kind: kind as never,
      answerJson: JSON.stringify({
        question: "q",
        answer,
        cutoff: { at: new Date(NOW - 5 * DAY).toISOString(), basis: "endTime", pastCutoff: false },
        runs: [],
        research: [],
        sources: [],
        costUsd: 0,
        latencyMs: 1,
        ...over,
      }),
      ...(kind === "multi" ? { prediction: "A, C" } : {}),
      ...(kind === "number" ? { mean: 40, sd: 4, prediction: "40" } : {}),
    });
  const options = [
    { id: "A", label: "Alpha" },
    { id: "B", label: "Beta" },
    { id: "C", label: "Gamma" },
  ];

  it("multi-select: one yes/no per option behind a resolved gate", async () => {
    const id = save({ type: "multi", options }, "multi", {
      prediction: ["A", "C"],
      distribution: { A: 0.8, B: 0.2, C: 0.6 },
    });
    const r = await judgeOpenResolutions(db, {
      env: ENV,
      judge: judge({ resolved: 0.95, option_0: 0.92, option_1: 0.05, option_2: 0.9 }),
      retriever: report("- Alpha and Gamma qualified ([x](https://stats.example/a))"),
      now: () => NOW,
    });
    expect(r).toMatchObject({ judged: 1, proposed: 1 });
    expect(JSON.parse(db.getOutcomeBySubject(`judged:forecast:${id}`)!.truth_json!)).toEqual({
      options: ["A", "C"],
    });
  });

  it("multi-select: not resolved when the gate says so", async () => {
    save({ type: "multi", options }, "multi");
    const r = await judgeOpenResolutions(db, {
      env: ENV,
      judge: judge({ resolved: 0.2 }),
      retriever: report("nothing yet"),
      now: () => NOW,
    });
    expect(r).toMatchObject({ judged: 1, unresolved: 1, proposed: 0 });
  });

  it("numbers: a quoted value is checked against the evidence, then confirmed by the judge", async () => {
    const evidence =
      "- The agency reported 42.5 thousand units in September ([x](https://stats.example/a))";
    const id = save({ type: "number", unit: "thousand units" }, "number");
    const extractor = async () =>
      '{"value": 42.5, "quote": "The agency reported 42.5 thousand units in September"}';
    const j = judge({ confirmed: 0.93 });
    const r = await judgeOpenResolutions(db, {
      env: ENV,
      judge: j,
      retriever: report(evidence),
      extractor,
      now: () => NOW,
    });
    expect(r).toMatchObject({ judged: 1, proposed: 1 });
    const o = db.getOutcomeBySubject(`judged:forecast:${id}`)!;
    expect(JSON.parse(o.truth_json!)).toEqual({ value: 42.5 });
    expect(o.metric).toBe("crps");
    expect(j.states.at(-1)).toMatchObject({ proposed_value: 42.5 });
  });

  it("numbers: an unquoted, invented or unconfirmed value resolves nothing", async () => {
    const evidence = "- The agency reported 42.5 thousand units in September";
    const cases: Array<[string, number]> = [
      ['{"value": 42.5, "quote": "a sentence that is not in the evidence at all"}', 0.95],
      ['{"value": 51, "quote": "The agency reported 42.5 thousand units"}', 0.95],
      ['{"value": null, "quote": ""}', 0.95],
      ['{"value": 42.5, "quote": "The agency reported 42.5 thousand units"}', 0.3],
    ];
    for (const [reply, confirmed] of cases) {
      const fresh = new MarinaDB(":memory:");
      const id = fresh.saveForecastAnswer({
        entityName: "Ada",
        question: "q",
        kind: "number",
        mean: 40,
        sd: 4,
        answerJson: JSON.stringify({
          question: "q",
          answer: { type: "number" },
          cutoff: {
            at: new Date(NOW - 5 * DAY).toISOString(),
            basis: "endTime",
            pastCutoff: false,
          },
        }),
      });
      const r = await judgeOpenResolutions(fresh, {
        env: ENV,
        judge: judge({ confirmed }),
        retriever: report(evidence),
        extractor: async () => reply,
        now: () => NOW,
      });
      expect(r.unresolved).toBe(1);
      expect(fresh.getOutcomeBySubject(`judged:forecast:${id}`)).toBeUndefined();
      await settleDelivery(fresh);
      fresh.close();
    }
  });
});

describe("judged quality of work with no verdict", () => {
  let db: MarinaDB;
  let tasks: TaskManager;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    tasks = new TaskManager(db);
    db.saveAgentConfig({
      name: "Helper",
      model: "vendor/model-a",
      role: "coder",
      spawnedBy: "system",
    });
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  const submitted = () => {
    const t = tasks.create({
      title: "Rename the config loader",
      description: "Keep the old name as an alias",
      creatorId: "e_creator",
      creatorName: "creator",
    } as never);
    const id = typeof t === "number" ? t : (t as { id: number }).id;
    tasks.claim(id, "e_helper", "Helper");
    tasks.submit(id, "e_helper", "Renamed it; the old name is an alias.");
    return id;
  };

  it("observe: a waiting submission gets one judged opinion that teaches nothing", async () => {
    const id = submitted();
    const j = judge({ complete: 0.85 });
    expect((await judgeWaitingWork(db, { env: ENV, judge: j, now: () => Date.now() })).judged).toBe(
      0,
    ); // grace
    const later = () => Date.now() + QUALITY_GRACE_MS + 1;
    const r = await judgeWaitingWork(db, { env: ENV, judge: j, now: later });
    expect(r).toMatchObject({ judged: 1, delivered: 0 });
    const [o] = db.listOutcomes({ basis: "judged" });
    expect(o).toMatchObject({
      kind: "task",
      owner: "Helper",
      succeeded: 1,
      metric: "judge-quality",
    });
    expect(o!.subject.startsWith(`judged:task:${id}:Helper:`)).toBe(true);
    expect(db.outcomeDeliveries(o!.id)).toEqual([]);
    expect(j.states.at(-1)).toMatchObject({ submission: "Renamed it; the old name is an alias." });
    // Judged once per submission.
    expect((await judgeWaitingWork(db, { env: ENV, judge: j, now: later })).judged).toBe(0);
    // The creator's later verdict is what the opinion is measured against.
    recordTaskVerdict(db, { taskId: id, claimant: "Helper", approved: true, at: later() + 1 });
    expect(judgeAgreement(db)[0]).toMatchObject({ compared: 1, agreed: 1 });
  });

  it("off judges nothing; no backend judges nothing", async () => {
    submitted();
    const later = () => Date.now() + QUALITY_GRACE_MS + 1;
    expect((await judgeWaitingWork(db, { env: {}, judge: judge(), now: later })).judged).toBe(0);
    expect((await judgeWaitingWork(db, { env: ENV, now: later })).stoppedBy).toBe(
      "no decision backend",
    );
  });
});
