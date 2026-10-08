// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Tier-0 harness pieces: adapters, paired statistics, cost accounting, compare
// and preset formatting. Every fixture below is synthetic — no dataset content.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  extractChoiceLetter,
  extractFinalAnswer,
  formatHLEPrompt,
  normalizeShortAnswer,
  runHLE,
} from "../benchmarks/adapters/hle";
import { extractLetter, shuffleChoices } from "../benchmarks/adapters/multiple-choice";
import { compareRuns, formatCompareReport } from "../benchmarks/compare";
import { hleGoldImageItems, hleGoldTextItems } from "../benchmarks/download";
import { defaultTimeoutMs, usageFromResponse } from "../benchmarks/modes/passthrough";
import { resultForDisk } from "../benchmarks/result-file";
import { parseEquivalenceVerdict } from "../benchmarks/scoring/judge";
import { mcnemarExact, pairedBootstrap, wilsonInterval } from "../benchmarks/stats";
import {
  failureReason,
  formatTier0Summary,
  MARINA_TARGET_TIMEOUT_MS,
  resolveTier0Target,
  summarizeSet,
  tier0HarnessArgs,
  tier0Sets,
} from "../benchmarks/tier0";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  DatasetItem,
  ResultItem,
} from "../benchmarks/types";
import { formatUsd, summarizeUsage } from "../benchmarks/usage";

describe("Wilson interval", () => {
  it("matches known 95% values", () => {
    const a = wilsonInterval(8, 10);
    expect(a.low).toBeCloseTo(0.4902, 4);
    expect(a.high).toBeCloseTo(0.9433, 4);
    const b = wilsonInterval(0, 10);
    expect(b.low).toBe(0);
    expect(b.high).toBeCloseTo(0.2775, 4);
    const c = wilsonInterval(10, 10);
    expect(c.high).toBe(1);
    expect(c.low).toBeCloseTo(0.7225, 4);
  });

  it("is the whole unit interval with no data", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("McNemar exact test", () => {
  it("matches the two-sided binomial tail", () => {
    // 2 · (C(12,0) + C(12,1) + C(12,2)) / 2^12 = 158 / 4096
    expect(mcnemarExact(10, 2).p).toBeCloseTo(158 / 4096, 10);
    // 2 · (1 / 64)
    expect(mcnemarExact(0, 6).p).toBeCloseTo(0.03125, 10);
    expect(mcnemarExact(6, 0).p).toBeCloseTo(0.03125, 10);
  });

  it("caps at 1 and handles no discordant pairs", () => {
    expect(mcnemarExact(5, 5).p).toBe(1);
    expect(mcnemarExact(0, 0)).toEqual({ b: 0, c: 0, p: 1 });
  });
});

describe("paired bootstrap", () => {
  it("is degenerate when every pair moves the same way", () => {
    const r = pairedBootstrap([false, false, false], [true, true, true], { resamples: 500 });
    expect(r.diff).toBe(1);
    expect(r.interval).toEqual({ low: 1, high: 1 });
    const same = pairedBootstrap([true, false], [true, false], { resamples: 500 });
    expect(same.diff).toBe(0);
    expect(same.interval).toEqual({ low: 0, high: 0 });
  });

  it("is reproducible per seed and brackets the observed difference", () => {
    const a = [true, false, true, false, true, true, false, false, true, false];
    const b = [true, true, true, false, true, true, true, false, true, true];
    const r1 = pairedBootstrap(a, b, { seed: 7, resamples: 2000 });
    const r2 = pairedBootstrap(a, b, { seed: 7, resamples: 2000 });
    expect(r1).toEqual(r2);
    expect(r1.diff).toBeCloseTo(0.3, 10);
    expect(r1.interval.low).toBeLessThanOrEqual(r1.diff);
    expect(r1.interval.high).toBeGreaterThanOrEqual(r1.diff);
    expect(r1.interval.low).toBeGreaterThanOrEqual(0);
  });

  it("refuses unpaired arms", () => {
    expect(() => pairedBootstrap([true], [true, false])).toThrow();
  });
});

describe("multiple-choice adapter", () => {
  it("reads the committed letter within the option range", () => {
    expect(extractLetter("Work... so the final line.\nAnswer: C", 4)).toBe("C");
    expect(extractLetter("I think the answer is (B).", 4)).toBe("B");
    expect(extractLetter("D", 4)).toBe("D");
    // "F" is not an option of a four-choice question; the last in-range letter wins.
    expect(extractLetter("Option A fails, so F... the pick is B", 4)).toBe("B");
    expect(extractLetter("Answer: Because of symmetry, C", 4)).toBe("C");
  });

  const item = (id: string): DatasetItem => ({
    id,
    question: "synthetic?",
    choices: ["right", "wrong-1", "wrong-2", "wrong-3"],
    answer: "A",
  });

  it("shuffles options deterministically per seed and keeps the key on the right option", () => {
    const items = ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8"].map(item);
    for (const seed of [0, 1, 42]) {
      for (const it of items) {
        const s = shuffleChoices(it, seed);
        expect(s).toEqual(shuffleChoices(it, seed));
        expect([...(s.choices ?? [])].sort()).toEqual([...(it.choices ?? [])].sort());
        expect(s.choices?.["ABCD".indexOf(s.answer)]).toBe("right");
      }
    }
    const order = (seed: number) => items.map((it) => shuffleChoices(it, seed).answer).join("");
    expect(order(1)).not.toBe(order(2));
    // The answer letter is not stuck on A across items.
    expect(new Set(order(42)).size).toBeGreaterThan(1);
  });

  it("leaves an item without a usable key untouched", () => {
    const odd = { ...item("y"), answer: "Z" };
    expect(shuffleChoices(odd, 3)).toBe(odd);
  });
});

describe("HLE adapter parsing", () => {
  it("extracts the labelled final answer", () => {
    expect(extractFinalAnswer("Explanation: blah\nExact Answer: 42\nConfidence: 80%")).toBe("42");
    expect(extractFinalAnswer("**Final Answer:** x^2 + 1")).toBe("x^2 + 1");
    expect(extractFinalAnswer("no label here")).toBeUndefined();
  });

  it("reads multiple-choice letters beyond J and skips the pronoun I", () => {
    expect(extractChoiceLetter("Explanation: ...\nAnswer: K\nConfidence: 60%")).toBe("K");
    expect(extractChoiceLetter("Answer: I think C")).toBe("C");
    expect(extractChoiceLetter("Answer: (B) the second")).toBe("B");
    expect(extractChoiceLetter("so the answer is D.")).toBe("D");
    expect(extractChoiceLetter("no commitment")).toBe("");
  });

  it("normalizes short answers for exact match", () => {
    expect(normalizeShortAnswer("  $\\boxed{17}$. ")).toBe("17");
    expect(normalizeShortAnswer('"Blue Whale"')).toBe("blue whale");
    expect(normalizeShortAnswer("\\text{yes}")).toBe("yes");
    expect(normalizeShortAnswer("\\(9\\)")).toBe("9");
  });

  it("keeps only Gold, text-only rows", () => {
    const row = (id: string, cls: string, record: Record<string, unknown>) => ({
      id,
      Verified_Classes: cls,
      category: "Math",
      raw_subject: "Synthetic",
      question: `q-${id}`,
      answer: `a-${id}`,
      json: JSON.stringify(record),
    });
    const items = hleGoldTextItems([
      row("g1", "Gold subset", { image: "", answer_type: "exactMatch" }),
      row("g2", "Gold subset", { image: "data:image/png;base64,AAAA", answer_type: "exactMatch" }),
      row("g3", "Gold subset", { image: "", answer_type: "multipleChoice" }),
      row("r1", "Revision subset", { image: "", answer_type: "exactMatch" }),
      { ...row("g4", "Gold subset", {}), json: "{not json" },
    ]);
    expect(items.map((i) => i.id)).toEqual(["hle-g1", "hle-g3"]);
    expect(items[0]?.metadata?.answerType).toBe("exactMatch");
    expect(items[1]?.metadata?.answerType).toBe("multipleChoice");

    const images = hleGoldImageItems([
      row("g1", "Gold subset", { image: "", answer_type: "exactMatch" }),
      row("g2", "Gold subset", { image: "data:image/png;base64,AAAA", answer_type: "exactMatch" }),
      row("g5", "Gold subset", { image: "javascript:alert(1)", answer_type: "exactMatch" }),
      row("r2", "Revision subset", { image: "data:image/png;base64,BBBB" }),
    ]);
    expect(images.map((i) => i.id)).toEqual(["hle-g2"]);
    expect(images[0]?.metadata?.image).toBe("data:image/png;base64,AAAA");
  });

  it("sends a multimodal item's image as an image_url part; text items stay strings", () => {
    const text = formatHLEPrompt({ id: "t", question: "q?", answer: "a" });
    expect(text[1]?.content).toBe("q?");
    const mm = formatHLEPrompt({
      id: "m",
      question: "what is shown?",
      answer: "a",
      metadata: { image: "data:image/png;base64,AAAA" },
    });
    expect(mm[1]?.content).toEqual([
      { type: "text", text: "what is shown?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("parses strict judge verdicts", () => {
    expect(parseEquivalenceVerdict("CORRECT")).toBe("correct");
    expect(parseEquivalenceVerdict("Incorrect.")).toBe("incorrect");
    expect(parseEquivalenceVerdict("At first CORRECT, but on reflection INCORRECT")).toBe(
      "incorrect",
    );
    expect(parseEquivalenceVerdict("maybe")).toBeNull();
  });
});

describe("usage accounting", () => {
  it("takes cost from Marina's header, else usage.cost, never a guess", () => {
    expect(
      usageFromResponse({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, "0.002"),
    ).toEqual({ promptTokens: 10, completionTokens: 5, costUsd: 0.002 });
    expect(usageFromResponse({ usage: { cost: 0.01 } }, null).costUsd).toBe(0.01);
    expect(usageFromResponse({}, null)).toEqual({
      promptTokens: undefined,
      completionTokens: undefined,
      costUsd: undefined,
    });
  });

  it("sums only reported values and prints n/a otherwise", () => {
    const base = { question: "", expected: "", actual: "", correct: true, latencyMs: 1 };
    const s = summarizeUsage([
      { ...base, id: "1", usage: { calls: 1, costUsd: 0.01, promptTokens: 3 } },
      { ...base, id: "2", usage: { calls: 1 }, judgeUsage: { calls: 1, costUsd: 0.001 } },
    ]);
    expect(s.costUsd).toBe(0.01);
    expect(s.judgeCostUsd).toBe(0.001);
    expect(s.pricedItems).toBe(1);
    expect(s.calls).toBe(3);
    expect(s.completionTokens).toBeUndefined();
    expect(formatUsd(undefined)).toBe("n/a");
    expect(summarizeUsage([{ ...base, id: "3" }]).costUsd).toBeUndefined();
  });
});

describe("runHLE against a fake endpoint", () => {
  let server: ReturnType<typeof Bun.serve>;
  let endpoint = "";
  // Synthetic replies keyed by question text.
  const replies: Record<string, string> = {
    "q-exact": "Explanation: synthetic\nExact Answer: $42$\nConfidence: 90%",
    "q-judged": "Explanation: synthetic\nExact Answer: forty-two\nConfidence: 50%",
    "q-wrong": "Explanation: synthetic\nExact Answer: 7\nConfidence: 50%",
    "q-mc": "Explanation: synthetic\nAnswer: B\nConfidence: 70%",
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: { role: string; content: string }[] };
        const system = body.messages[0]?.content ?? "";
        const user = body.messages[1]?.content ?? "";
        let content: string;
        if (system.startsWith("You grade one answer")) {
          content = user.includes("forty-two") ? "CORRECT" : "INCORRECT";
        } else {
          content = replies[user] ?? "Exact Answer: ?";
        }
        return Response.json(
          {
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          },
          { headers: { "x-marina-cost-usd": "0.00100000" } },
        );
      },
    });
    endpoint = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));

  it("scores exact match without a judge, judges the rest, and records cost", async () => {
    const items: DatasetItem[] = [
      { id: "e", question: "q-exact", answer: "42", metadata: { answerType: "exactMatch" } },
      { id: "j", question: "q-judged", answer: "42", metadata: { answerType: "exactMatch" } },
      { id: "w", question: "q-wrong", answer: "42", metadata: { answerType: "exactMatch" } },
      { id: "m", question: "q-mc", answer: "B", metadata: { answerType: "multipleChoice" } },
    ];
    const config: BenchmarkConfig = {
      name: "t",
      dataset: "hle-verified-gold",
      adapter: "hle",
      scoring: "accuracy",
      mode: "passthrough",
      model: "fake",
      endpoint,
      concurrency: 2,
      judge: { model: "fake-judge", endpoint },
    };
    const out = await runHLE(items, config);
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(byId.e?.correct).toBe(true);
    expect(byId.e?.judge).toBeUndefined();
    expect(byId.j?.correct).toBe(true);
    expect(byId.j?.judge).toBe("correct");
    expect(byId.w?.correct).toBe(false);
    expect(byId.w?.judge).toBe("incorrect");
    expect(byId.m?.correct).toBe(true);
    const usage = summarizeUsage(out);
    expect(usage.costUsd).toBeCloseTo(0.004, 10);
    expect(usage.judgeCostUsd).toBeCloseTo(0.002, 10);
    expect(usage.promptTokens).toBe(600);
  });
});

function fakeRun(model: string, outcomes: Record<string, boolean>, cost?: number): BenchmarkResult {
  const items: ResultItem[] = Object.entries(outcomes).map(([id, correct]) => ({
    id,
    question: "",
    expected: "",
    actual: correct ? "x" : "y",
    correct,
    latencyMs: 1,
    ...(cost !== undefined
      ? { usage: { calls: 1, costUsd: cost, promptTokens: 10, completionTokens: 2 } }
      : {}),
  }));
  return {
    config: {
      name: "Synthetic",
      dataset: "synthetic",
      adapter: "multiple-choice",
      scoring: "accuracy",
      mode: "passthrough",
      model,
      endpoint: "http://fake",
      concurrency: 1,
    },
    timestamp: 0,
    duration_ms: 0,
    scores: { overall: 0, breakdown: {} },
    metadata: {
      total: items.length,
      answered: items.length,
      timeouts: 0,
      errors: 0,
      avgLatencyMs: 0,
    },
    items,
  };
}

describe("compare report", () => {
  const a = fakeRun("arm-a", { i1: true, i2: false, i3: false, i4: true, only_a: true }, 0.01);
  const b = fakeRun("arm-b", { i1: true, i2: true, i3: true, i4: false, only_b: false });

  it("pairs by id and computes the discordant counts", () => {
    const r = compareRuns(a, b, { resamples: 500 });
    expect(r.paired).toBe(4);
    expect(r.onlyInA).toBe(1);
    expect(r.onlyInB).toBe(1);
    expect(r.mcnemar.b).toBe(1);
    expect(r.mcnemar.c).toBe(2);
    expect(r.arms[0].accuracy).toBe(0.5);
    expect(r.arms[1].accuracy).toBe(0.75);
    expect(r.bootstrap.diff).toBeCloseTo(0.25, 10);
    expect(r.arms[0].costUsd).toBeCloseTo(0.04, 10);
    expect(r.arms[0].costPerItemUsd).toBeCloseTo(0.01, 10);
    expect(r.arms[1].costUsd).toBeUndefined();
  });

  it("formats accuracy, intervals, tests and n/a cost", () => {
    const text = formatCompareReport(compareRuns(a, b, { resamples: 500 }));
    expect(text).toContain("paired items: 4 (unpaired: 1 only in A, 1 only in B)");
    expect(text).toContain("accuracy  50.0% (2/4)  95% Wilson [15.0%, 85.0%]");
    expect(text).toContain("cost      $0.0400  per item $0.0100");
    expect(text).toContain("cost      n/a  per item n/a");
    expect(text).toContain("tokens    40 in / 8 out");
    expect(text).toContain("tokens    n/a");
    expect(text).toContain("McNemar exact: A-only correct 1, B-only correct 2, p = 1.000");
    expect(text).toMatch(/Paired bootstrap B − A: \+25\.0pp {2}95% CI \[/);
  });

  it("warns when the runs are not the same benchmark", () => {
    const other = fakeRun("arm-c", { i1: true });
    other.config.dataset = "other";
    expect(compareRuns(a, other).warnings[0]).toContain("different datasets");
  });
});

describe("tier0 preset", () => {
  it("resolves crew, OpenRouter and URL targets", () => {
    const crew = resolveTier0Target("marina:answerer", {}, { MARINA_BENCH_API_KEY: "k1" });
    expect(crew).toMatchObject({
      endpoint: "http://localhost:3300",
      model: "marina:answerer",
      apiKey: "k1",
      defaultJudgeModel: "marina/default",
    });
    const or = resolveTier0Target("openrouter/vendor/model-x", {}, { OPENROUTER_API_KEY: "k2" });
    expect(or).toMatchObject({
      endpoint: "https://openrouter.ai/api",
      model: "vendor/model-x",
      apiKey: "k2",
    });
    expect(or.defaultJudgeModel).toBeUndefined();
    const url = resolveTier0Target("http://127.0.0.1:4555/", { model: "m" }, {});
    expect(url).toMatchObject({ endpoint: "http://127.0.0.1:4555", model: "m" });
    expect(() => resolveTier0Target("bogus", {}, {})).toThrow(/unrecognized/);
  });

  it("plans the fixed sets and keeps keys out of argv", () => {
    expect(tier0Sets()).toEqual([
      { benchmark: "hle-verified-gold", limit: 40 },
      { benchmark: "gpqa", limit: 40 },
      { benchmark: "frames", limit: 20 },
    ]);
    expect(tier0Sets({ frames: 0 }).map((s) => s.benchmark)).toEqual(["hle-verified-gold", "gpqa"]);
    const target = resolveTier0Target("marina:answerer", { apiKey: "secret-key" }, {});
    const args = tier0HarnessArgs({ benchmark: "gpqa", limit: 40 }, target, {
      seed: 42,
      concurrency: 5,
    });
    expect(args.join(" ")).not.toContain("secret-key");
    expect(args).toContain("--seed");
    expect(args[args.indexOf("--judge-model") + 1]).toBe("marina/default");
  });

  it("forwards lessons and the measurement mode to every harness child", () => {
    const target = resolveTier0Target("openrouter/openai/gpt-6.1-sol", {}, {});
    const set = { benchmark: "gpqa", limit: 4 };
    expect(tier0HarnessArgs(set, target, { seed: 42, concurrency: 1 })).not.toContain("--lessons");
    const args = tier0HarnessArgs(set, target, {
      seed: 42,
      concurrency: 1,
      lessons: true,
      lessonsMode: "measure",
    });
    expect(args).toContain("--lessons");
    expect(args[args.indexOf("--lessons-mode") + 1]).toBe("measure");
  });

  it("gives crews a generous per-request timeout and lets --timeout override it", () => {
    const set = { benchmark: "hle-verified-gold", limit: 40 };
    const crew = resolveTier0Target("marina:answerer", {}, {});
    const crewArgs = tier0HarnessArgs(set, crew, { seed: 42, concurrency: 2 });
    expect(crewArgs[crewArgs.indexOf("--timeout") + 1]).toBe(String(MARINA_TARGET_TIMEOUT_MS));
    const custom = tier0HarnessArgs(set, crew, { seed: 42, concurrency: 2, timeoutMs: 1200000 });
    expect(custom[custom.indexOf("--timeout") + 1]).toBe("1200000");
    // A direct model keeps the harness default unless asked.
    const direct = resolveTier0Target("openrouter/openai/gpt-6.1-sol", {}, {});
    expect(tier0HarnessArgs(set, direct, { seed: 42, concurrency: 2 })).not.toContain("--timeout");
  });

  it("never writes the endpoint key into a saved result", () => {
    const secret = "test-endpoint-credential";
    const result = {
      config: {
        name: "HLE",
        dataset: "hle-verified-gold",
        adapter: "hle",
        scoring: "judge",
        mode: "passthrough",
        model: "openrouter/openai/gpt-6.1-sol",
        endpoint: "http://localhost:3300",
        apiKey: secret,
        concurrency: 2,
        judge: {
          model: "openrouter/openai/gpt-6.1-sol",
          endpoint: "http://localhost:3300",
          apiKey: secret,
        },
      },
      timestamp: 1,
      duration_ms: 1,
      scores: { overall: 0 },
      metadata: { total: 0, answered: 0, timeouts: 0, errors: 0, avgLatencyMs: 0 },
      items: [],
    } as unknown as BenchmarkResult;
    const onDisk = JSON.stringify(resultForDisk(result));
    expect(onDisk).not.toContain(secret);
    expect(onDisk).not.toContain("apiKey");
    // Everything else survives, and the in-memory result is untouched.
    expect(resultForDisk(result).config.judge).toEqual({
      model: "openrouter/openai/gpt-6.1-sol",
      endpoint: "http://localhost:3300",
    });
    expect(result.config.apiKey).toBe(secret);
  });

  it("reads the per-request timeout at call time", () => {
    const prev = process.env.HARNESS_TIMEOUT_MS;
    try {
      delete process.env.HARNESS_TIMEOUT_MS;
      expect(defaultTimeoutMs()).toBe(600_000);
      process.env.HARNESS_TIMEOUT_MS = "900000";
      expect(defaultTimeoutMs()).toBe(900_000);
      process.env.HARNESS_TIMEOUT_MS = "junk";
      expect(defaultTimeoutMs()).toBe(600_000);
    } finally {
      if (prev === undefined) delete process.env.HARNESS_TIMEOUT_MS;
      else process.env.HARNESS_TIMEOUT_MS = prev;
    }
  });

  it("reports the thrown message of a failed child, not its stack", () => {
    const stderr = [
      "Fatal error: 344 |   if (!hfToken()) {",
      "345 |     throw new Error(",
      "error: synthetic gated dataset message",
      "      at downloadX (/x/download.ts:345:15)",
      "      at /x/harness.ts:775:1",
    ].join("\n");
    expect(failureReason(stderr)).toBe("synthetic gated dataset message");
    expect(failureReason("plain failure\n  at y (z:1:1)")).toBe("plain failure");
    expect(failureReason("")).toBeUndefined();
  });

  it("summarizes sets with accuracy, interval and cost", () => {
    const run = fakeRun("m", { a: true, b: false, c: true, d: true }, 0.002);
    run.metadata.usage = summarizeUsage(run.items);
    const s = summarizeSet("gpqa", "/x/gpqa.json", run);
    expect(s.accuracy).toBe(0.75);
    expect(s.costUsd).toBeCloseTo(0.008, 10);
    const text = formatTier0Summary(resolveTier0Target("http://h", { model: "m" }, {}), [
      s,
      { benchmark: "frames", status: "failed", error: "boom" },
    ]);
    expect(text).toContain("gpqa");
    expect(text).toContain("75.0% (3/4)");
    expect(text).toContain("cost $0.0080 ($0.0020/item)");
    expect(text).toContain("frames             FAILED — boom");
    expect(text).toContain("total cost $0.0080");
  });
});
