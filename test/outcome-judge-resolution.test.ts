// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Retriever } from "../src/arena/research/retrieve";
import type { DecisionProvider } from "../src/decisions/types";
import { EARNED_MIN_COMPARED, judgeAgreement } from "../src/outcomes/agreement";
import { resolveForecast } from "../src/outcomes/forecast";
import { judgeOpenResolutions } from "../src/outcomes/judge-resolution";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T00:00:00Z");

const judge = (pick: string, confidence = 0.95): DecisionProvider & { asked: number } => {
  const j = {
    kind: "test",
    model: "jev",
    calibrated: true,
    asked: 0,
    async ask() {
      j.asked++;
      return {
        answers: { resolution: { type: "choice", choice: pick, confidence } },
        model: "jev",
        provider: "test",
        latencyMs: 1,
      };
    },
  };
  return j as unknown as DecisionProvider & { asked: number };
};
const retriever: Retriever = async () => ({
  report: "- Home won 2–1 on Oct 3 ([news](https://news.example/a))",
  sources: [{ url: "https://news.example/a" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});

describe("judged resolution of answers no market settles", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  const save = (endedDaysAgo: number, over: Record<string, unknown> = {}) =>
    db.saveForecastAnswer({
      entityName: "Ada",
      question: "Who wins the match?",
      kind: "choice",
      prediction: "A",
      answerJson: JSON.stringify({
        question: "Who wins the match?",
        answer: {
          type: "choice",
          options: [
            { id: "A", label: "Home" },
            { id: "B", label: "Away" },
          ],
        },
        prediction: "A",
        distribution: { A: 0.7, B: 0.3 },
        cutoff: {
          at: new Date(NOW - endedDaysAgo * DAY).toISOString(),
          basis: "endTime",
          pastCutoff: false,
        },
        runs: [],
        research: [],
        sources: [],
        costUsd: 0,
        latencyMs: 1,
      }),
      ...over,
    });

  const run = (mode: string, j: DecisionProvider) =>
    judgeOpenResolutions(db, {
      env: { MARINA_OUTCOME_JUDGE: mode, MARINA_DAILY_SPEND_CAP_USD: "off" },
      judge: j,
      retriever,
      now: () => NOW,
    });

  it("off judges nothing; observe proposes without settling or teaching", async () => {
    const id = save(5);
    const j = judge("A");
    expect((await run("off", j)).judged).toBe(0);
    const r = await run("observe", j);
    expect(r).toMatchObject({ judged: 1, proposed: 1, settled: 0 });
    expect(db.getForecastAnswer(id)!.resolved_at).toBeNull();
    const o = db.getOutcomeBySubject(`judged:forecast:${id}`)!;
    expect(o).toMatchObject({ basis: "judged", judge: "test:jev", succeeded: 1 });
    expect(db.outcomeDeliveries(o.id)).toEqual([]);
    // Judged once.
    expect((await run("observe", j)).judged).toBe(0);
  });

  it("skips answers inside the grace period, linked ones and measurement runs", async () => {
    save(1);
    save(5, { sampleId: "kalshi/X" });
    save(5, { evalMode: "measure" });
    expect((await run("observe", judge("A"))).judged).toBe(0);
  });

  it("not resolved yet waits a day and records nothing", async () => {
    const id = save(5);
    const r = await run("observe", judge("not_resolved"));
    expect(r).toMatchObject({ judged: 1, unresolved: 1, proposed: 0 });
    expect(db.getOutcomeBySubject(`judged:forecast:${id}`)).toBeUndefined();
    expect((await run("observe", judge("A"))).judged).toBe(0);
  });

  it("on settles only for a judge that has earned agreement, and only when confident", async () => {
    const first = save(5);
    expect((await run("on", judge("A"))).settled).toBe(0); // not earned yet
    expect(db.getForecastAnswer(first)!.resolved_at).toBeNull();
    // Earn agreement: proposals later confirmed by the mechanical resolution.
    for (let i = 0; i < EARNED_MIN_COMPARED + 5; i++) {
      const id = save(5);
      await run("observe", judge("A"));
      resolveForecast(db, id, { option: "A" }, NOW + 1);
    }
    expect(judgeAgreement(db)[0]).toMatchObject({ judge: "test:jev", earned: true });
    const unsure = save(5);
    expect((await run("on", judge("A", 0.6))).settled).toBe(0);
    expect(db.getForecastAnswer(unsure)!.resolved_at).toBeNull();
    const sure = save(5);
    const r = await run("on", judge("B", 0.97));
    expect(r.settled).toBe(1);
    const settled = db.getOutcomeBySubject(`forecast:${sure}`)!;
    expect(settled).toMatchObject({ basis: "judged", judge: "test:jev", succeeded: 0 });
    // A settled judged outcome is delivered (lessons, history), labelled judged.
    expect(db.outcomeDeliveries(settled.id).map((d) => d.consumer)).toEqual(["history", "lessons"]);
  });

  it("an outage records nothing", async () => {
    const id = save(5);
    const down = {
      kind: "test",
      model: "jev",
      async ask() {
        throw new Error("timeout");
      },
    } as unknown as DecisionProvider;
    expect((await run("observe", down)).failed).toBe(1);
    expect(db.getOutcomeBySubject(`judged:forecast:${id}`)).toBeUndefined();
  });
});
