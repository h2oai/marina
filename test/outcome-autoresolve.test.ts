// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EARNED_MIN_COMPARED, judgeAgreement } from "../src/outcomes/agreement";
import { autoresolveLinked } from "../src/outcomes/autoresolve";
import { recordTaskOpinion, recordTaskVerdict } from "../src/outcomes/live";
import { consumersFor, settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import {
  clearCalibrationFinders,
  forecastQuestionFinder,
  registerCalibrationFinder,
} from "../src/resolvers/calibration";
import { getResolver, registerResolver, unregisterResolver } from "../src/resolvers/registry";
import type { Resolver } from "../src/resolvers/types";

type Args = { venue: string; ticker: string };

describe("automatic resolution of linked answers", () => {
  let db: MarinaDB;
  let previous: Resolver<unknown> | undefined;
  const calls: string[] = [];
  const fake: Resolver<Args> = {
    kind: "resolving",
    describe: "test",
    parseArgs: (raw: Record<string, unknown>) =>
      raw.venue === "kalshi" || raw.venue === "polymarket"
        ? { ok: true, args: { venue: raw.venue, ticker: String(raw.ticker) } }
        : { ok: false, error: "venue" },
    idFromArgs: (a: Args) => `${a.venue}/${a.ticker}`,
    resolve: async ({ args }: { args: Args }) => {
      calls.push(args.ticker);
      return args.ticker === "OPEN"
        ? { status: "no-change", source: "test" }
        : { status: "resolved", value: { outcome: "yes" }, source: "test" };
    },
  } as unknown as Resolver<Args>;

  beforeEach(() => {
    db = new MarinaDB(":memory:");
    calls.length = 0;
    previous = getResolver("resolving");
    if (previous) unregisterResolver(previous);
    registerResolver(fake);
    clearCalibrationFinders();
    registerCalibrationFinder(forecastQuestionFinder);
  });
  afterEach(async () => {
    await settleDelivery(db);
    unregisterResolver(fake as Resolver<unknown>);
    if (previous) registerResolver(previous);
    clearCalibrationFinders();
    db.close();
  });

  const save = (sampleId: string) =>
    db.saveForecastAnswer({
      entityName: "Ada",
      question: "q",
      kind: "probability",
      probability: 0.8,
      answerJson: "{}",
      sampleId,
    });

  it("reads each waiting market once and settles every answer on a resolved one", async () => {
    const a = save("kalshi/FED");
    const b = save("kalshi/FED");
    const c = save("kalshi/OPEN");
    save("inworld/7");
    const r = await autoresolveLinked(db, { env: {} });
    expect(r).toEqual({ checked: 2, resolved: 1, open: 1, errors: 0, unsupported: 1 });
    expect(calls.sort()).toEqual(["FED", "OPEN"]);
    for (const id of [a, b]) expect(db.getForecastAnswer(id)!.resolved_at).not.toBeNull();
    expect(db.getForecastAnswer(c)!.resolved_at).toBeNull();
    expect(db.listOutcomes({ kind: "forecast" })).toHaveLength(2);
    // Settled answers are no longer waited on.
    expect(db.openLinkedSampleIds(10).sort()).toEqual(["inworld/7", "kalshi/OPEN"]);
  });

  it("off reads nothing", async () => {
    save("kalshi/FED");
    expect(
      (await autoresolveLinked(db, { env: { MARINA_OUTCOME_AUTORESOLVE: "off" } })).checked,
    ).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("judged outcomes and judge agreement", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
  });

  it("an opinion is recorded but never delivered; none is no outcome", () => {
    expect(consumersFor("task", "judged")).toEqual([]);
    recordTaskOpinion(db, {
      taskId: 1,
      claimant: "Ada",
      judge: "test:jev",
      opinion: "pass",
      at: 10,
    });
    recordTaskOpinion(db, {
      taskId: 2,
      claimant: "Ada",
      judge: "test:jev",
      opinion: "none",
      at: 11,
    });
    const [o] = db.listOutcomes({ basis: "judged" });
    expect(db.listOutcomes({ basis: "judged" })).toHaveLength(1);
    expect(o).toMatchObject({
      subject: "judged:task:1:Ada:10",
      basis: "judged",
      judge: "test:jev",
    });
    expect(db.outcomeDeliveries(o!.id)).toEqual([]);
  });

  it("agreement compares each opinion with the creator's later verdict on the same attempt", () => {
    recordTaskOpinion(db, { taskId: 1, claimant: "Ada", judge: "j", opinion: "pass", at: 10 });
    recordTaskVerdict(db, { taskId: 1, claimant: "Ada", approved: false, at: 20 }); // false pass
    recordTaskOpinion(db, { taskId: 2, claimant: "Ada", judge: "j", opinion: "fail", at: 10 });
    recordTaskVerdict(db, { taskId: 2, claimant: "Ada", approved: false, at: 30 }); // agreed
    recordTaskOpinion(db, { taskId: 3, claimant: "Ada", judge: "j", opinion: "pass", at: 10 }); // no verdict yet
    // A verdict BEFORE the opinion is a different attempt.
    recordTaskVerdict(db, { taskId: 4, claimant: "Ada", approved: true, at: 5 });
    recordTaskOpinion(db, { taskId: 4, claimant: "Ada", judge: "j", opinion: "pass", at: 10 });
    expect(judgeAgreement(db)).toEqual([
      expect.objectContaining({
        judge: "j",
        judged: 4,
        compared: 2,
        agreed: 1,
        falsePass: 1,
        earned: false,
      }),
    ]);
  });

  it("a judge earns trust only from enough agreement", () => {
    for (let i = 0; i < EARNED_MIN_COMPARED + 5; i++) {
      recordTaskOpinion(db, { taskId: i, claimant: "Ada", judge: "good", opinion: "pass", at: 10 });
      recordTaskVerdict(db, { taskId: i, claimant: "Ada", approved: true, at: 20 });
    }
    expect(judgeAgreement(db)[0]).toMatchObject({ judge: "good", earned: true });
  });
});
