// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Arbiter in typed forecasts (`MARINA_FORECAST_ARBITER`, `src/forecast/arbiter.ts`),
 * models mocked: off is byte-identical; observe records only; on makes the
 * verifier and critic advisory and lets only a bar-clearing overrule change the
 * answer; replace drops the per-run verifier; uncontested forecasts never reach
 * the Arbiter; earned trust comes from resolved history.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { recordFromAnswer } from "../src/forecast/adjust";
import type { AnswerSpec } from "../src/forecast/answer-types";
import {
  arbiterHistory,
  forecastArbiterModeFromEnv,
  forecastTrackRecord,
  resetForecastArbiterQuotaForTests,
} from "../src/forecast/arbiter";
import { memoryHistory } from "../src/forecast/history";
import { typedOptionsFromEnv } from "../src/forecast/service";
import { formationEnv } from "../src/forecast/surface";
import {
  forecastTyped,
  type ModelPart,
  type TypedForecastAnswer,
  type TypedForecastOptions,
} from "../src/forecast/typed";
import type { Retriever } from "../src/research/retrieve";

const spec: AnswerSpec = {
  type: "choice",
  options: [
    { id: "A", label: "Spain" },
    { id: "B", label: "Brazil" },
  ],
};

const REPORT = [
  "- 2026-09-01 — The final score was 3-1 to Brazil. ([Reuters](https://www.reuters.com/a))",
  "- 2026-09-01 — Brazil beat Spain 3-1 on Sunday. ([AP](https://apnews.com/b))",
].join("\n");

const retriever: Retriever = async () => ({
  report: REPORT,
  sources: [{ url: "https://www.reuters.com/a" }, { url: "https://apnews.com/b" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});

interface World {
  /** Answer per run number (1-based). */
  runs: string[];
  critic?: { verdict: "keep" | "revise"; answer?: string; confidence?: number };
  verifier?: { verdict: "accept" | "correct"; answer?: string };
  arbiter?: Record<string, unknown>;
}

const overruleToB = {
  verdict: "overrule",
  answer: "B",
  items: [
    {
      item: "B",
      citations: [
        { source: "https://www.reuters.com/a", quote: "The final score was 3-1 to Brazil." },
        { source: "https://apnews.com/b", quote: "Brazil beat Spain 3-1 on Sunday." },
      ],
    },
  ],
  source_quality: 0.9,
  reasoning_quality: 0.8,
  confidence: 0.85,
  reason: "Two independent wire reports give Brazil.",
};

async function run(
  world: World,
  options: TypedForecastOptions,
  extra: { history?: ReturnType<typeof memoryHistory> } = {},
): Promise<{ prompts: string[]; answer: TypedForecastAnswer }> {
  const prompts: string[] = [];
  const reply = (system: string, user: string): string => {
    if (system.startsWith("You plan research"))
      return JSON.stringify({ restatement: "Who won?", queries: ["final"] });
    if (system.startsWith("You review a research dossier")) return JSON.stringify({ done: true });
    if (system.startsWith("You are the forecaster's critic"))
      return JSON.stringify({
        confidence: 0.9,
        reason: "a wire report",
        ...(world.critic ?? { verdict: "keep" }),
      });
    if (system.startsWith("You verify a forecaster's draft"))
      return JSON.stringify({ reason: "checked", ...(world.verifier ?? { verdict: "accept" }) });
    if (system.startsWith("You are the Arbiter"))
      return JSON.stringify(world.arbiter ?? { verdict: "abstain", confidence: 0.2 });
    const i = Number(/Independent run (\d+) of/.exec(user)?.[1] ?? "1");
    return JSON.stringify({
      answer: world.runs[(i - 1) % world.runs.length],
      confidence: 0.6,
      reason: "r",
    });
  };
  const part = (name: string): ModelPart => ({
    name,
    complete: async (s, u) => {
      prompts.push(`${name}\n${s}\n${u}`);
      return reply(s, u);
    },
  });
  const answer = await forecastTyped(
    { question: "Who won the final?", answer: spec, endTime: "2026-11-01T00:00:00Z", id: "q1" },
    {
      retriever,
      analysts: [part("m1")],
      planner: part("planner"),
      now: () => new Date("2026-09-05T00:00:00Z"),
      ...(extra.history
        ? {
            adjust: {
              prior: "off",
              calibration: "off",
              priorWeight: 0,
              margin: 0,
              score: "brier",
              minRecords: 0,
              history: extra.history,
            },
          }
        : {}),
      options: { runs: 3, researchRounds: 1, followUp: false, minEvidenceLines: 0, ...options },
    },
  );
  return { prompts, answer };
}

const stable = (a: TypedForecastAnswer) => {
  const { latencyMs: _l, arbiter: _a, ...rest } = a;
  return JSON.stringify(rest);
};
const arbiterPrompts = (p: string[]) => p.filter((x) => x.includes("You are the Arbiter"));

beforeEach(() => resetForecastArbiterQuotaForTests());

/** Two runs say A, one says B; the critic and the verifier push B. */
const contested: World = {
  runs: ["A", "A", "B"],
  critic: { verdict: "revise", answer: "B", confidence: 0.9 },
  verifier: { verdict: "correct", answer: "B" },
};

describe("MARINA_FORECAST_ARBITER", () => {
  it("parses the mode; off adds no option", () => {
    expect(forecastArbiterModeFromEnv({})).toBe("off");
    expect(forecastArbiterModeFromEnv({ MARINA_FORECAST_ARBITER: "Replace" })).toBe("replace");
    expect(forecastArbiterModeFromEnv({ MARINA_FORECAST_ARBITER: "yes" })).toBe("off");
    expect("arbiter" in typedOptionsFromEnv({})).toBe(false);
    expect("arbiter" in typedOptionsFromEnv({ MARINA_FORECAST_ARBITER: "off" })).toBe(false);
    expect(typedOptionsFromEnv({ MARINA_FORECAST_ARBITER: "observe" }).arbiter).toBe("observe");
    expect(formationEnv("arbiter", {})).toEqual({ env: { MARINA_FORECAST_ARBITER: "replace" } });
  });

  it("off is byte-identical to no option: same prompts, same answer", async () => {
    const none = await run(contested, { verify: true });
    const off = await run(contested, { verify: true, arbiter: "off" });
    expect(off.prompts).toEqual(none.prompts);
    expect(JSON.stringify({ ...off.answer, latencyMs: 0 })).toBe(
      JSON.stringify({ ...none.answer, latencyMs: 0 }),
    );
    expect(off.answer.arbiter).toBeUndefined();
    expect(arbiterPrompts(off.prompts)).toHaveLength(0);
    // Today's behaviour: the verifier and critic overrule the runs to B.
    expect(off.answer.prediction).toBe("B");
  });

  it("observe records what the Arbiter would do and changes nothing else", async () => {
    const off = await run(contested, { verify: true });
    const obs = await run(
      { ...contested, arbiter: { ...overruleToB, answer: "A", items: [] } },
      {
        verify: true,
        arbiter: "observe",
      },
    );
    expect(obs.prompts.filter((p) => !p.includes("You are the Arbiter"))).toEqual(off.prompts);
    expect(stable(obs.answer)).toBe(stable(off.answer));
    const rec = obs.answer.arbiter!;
    expect(rec.mode).toBe("observe");
    expect(rec.applied).toBe(false);
    expect(rec.result?.status).toBe("adjudicated");
    // Judged on the DRAFTS: two A's against one B, plus the dissent.
    expect(rec.majority).toBe("A");
    expect(rec.result?.disagreement.reasons).toEqual(["runs-disagree", "dissent"]);
    expect(arbiterPrompts(obs.prompts)).toHaveLength(1);
  });

  it("on: the verifier and critic only advise; without a cleared bar the majority stands", async () => {
    // The Arbiter overrules with ONE source: below the bar → keep.
    const weak = {
      ...overruleToB,
      items: [{ item: "B", citations: [overruleToB.items[0]!.citations[0]!] }],
    };
    const on = await run({ ...contested, arbiter: weak }, { verify: true, arbiter: "on" });
    expect(on.answer.prediction).toBe("A");
    expect(on.answer.critique?.applied).toBe(false);
    expect(on.answer.critique?.deferred).toBe("arbiter");
    const corrected = on.answer.runs.filter((r) => r.verified?.verdict === "correct");
    expect(corrected.length).toBeGreaterThan(0);
    for (const r of corrected) {
      expect(r.verified?.proposed).toBe("B");
      expect(r.verified?.draft).toBeUndefined();
    }
    expect(on.answer.runs.map((r) => r.formatted)).toEqual(["A", "A", "B"]);
    expect(on.answer.arbiter?.result?.bar?.verdict).toBe("keep");
    expect(on.answer.arbiter?.applied).toBe(false);
  });

  it("on: an overrule with two independent domains and confidence ≥ 0.7 changes the answer", async () => {
    const on = await run({ ...contested, arbiter: overruleToB }, { verify: true, arbiter: "on" });
    expect(on.answer.prediction).toBe("B");
    expect(on.answer.confidence).toBe(0.85);
    expect(on.answer.arbiter).toMatchObject({ applied: true, majority: "A", overrule: "B" });
    expect(on.answer.arbiter?.result?.bar?.domains).toEqual(["apnews.com", "reuters.com"]);
  });

  it("replace: no per-run verifier at all; the Arbiter is called only when contested", async () => {
    const rep = await run(
      { ...contested, arbiter: overruleToB },
      { verify: true, arbiter: "replace" },
    );
    expect(rep.prompts.some((p) => p.includes("You verify a forecaster's draft"))).toBe(false);
    expect(rep.answer.runs.every((r) => r.verified === undefined)).toBe(true);
    expect(rep.answer.prediction).toBe("B");
    // Unanimous runs, an agreeing critic: never contested, never called.
    const calm = await run(
      { runs: ["A"], critic: { verdict: "keep" }, arbiter: overruleToB },
      { verify: true, arbiter: "replace" },
    );
    expect(arbiterPrompts(calm.prompts)).toHaveLength(0);
    expect(calm.answer.arbiter?.result?.status).toBe("uncontested");
    expect(calm.answer.prediction).toBe("A");
  });
});

describe("earned trust from resolved history", () => {
  it("records overrules with whether they beat the majority, booleans only", async () => {
    const on = await run({ ...contested, arbiter: overruleToB }, { arbiter: "on" });
    expect(arbiterHistory(on.answer, { options: ["B"] })).toEqual({
      evaluator: "planner",
      overruled: true,
      applied: true,
      right: true,
    });
    expect(arbiterHistory(on.answer, { options: ["A"] })?.right).toBe(false);
    const rec = recordFromAnswer({
      id: "forecast:1",
      req: { question: "Who won the final?", answer: spec },
      answer: on.answer,
      truth: { options: ["B"] },
      resolvedAt: "2026-11-02T00:00:00Z",
    });
    expect(rec?.arbiter).toEqual({
      evaluator: "planner",
      overruled: true,
      applied: true,
      right: true,
    });
    // Without an arbiter the record carries no field (off is unchanged).
    const off = await run(contested, {});
    const plain = recordFromAnswer({
      id: "forecast:2",
      req: { question: "Who won the final?", answer: spec },
      answer: off.answer,
      truth: { options: ["B"] },
      resolvedAt: "2026-11-02T00:00:00Z",
    });
    expect(plain && "arbiter" in plain).toBe(false);
  });

  it("reads the record from history visible at the cutoff, per evaluator", async () => {
    const history = memoryHistory(
      Array.from({ length: 4 }, (_, i) => ({
        id: `forecast:${i}`,
        answerType: "choice" as const,
        group: "choice",
        resolvedAt: i < 3 ? "2026-08-01T00:00:00Z" : "2026-12-01T00:00:00Z",
        raw: {},
        outcome: { options: ["A"] },
        arbiter: { evaluator: "planner", overruled: true, applied: false, right: i !== 1 },
      })),
    );
    const rec = await forecastTrackRecord(history, "planner", "2026-09-05T00:00:00Z", "q1");
    expect(rec).toMatchObject({ resolved: 3, right: 2, earned: false });
    const other = await forecastTrackRecord(history, "someone-else", "2026-09-05T00:00:00Z", "q1");
    expect(other?.resolved).toBe(0);
    const on = await run({ ...contested, arbiter: overruleToB }, { arbiter: "on" }, { history });
    expect(on.answer.arbiter?.track).toMatchObject({ resolved: 3, right: 2 });
  });
});
