// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** A benchmark run never grades itself unless it opts in, and the opt-in is on the record. */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveTier0Target, tier0HarnessArgs } from "../benchmarks/tier0";
import {
  BUILTIN_BENCHMARK_JUDGE,
  defaultBenchmarkJudge,
  judgeLabel,
  resolveBenchmarkJudge,
  sameJudgeModel,
} from "../src/engine/benchmark-judge";
import { ledgerFromHarnessResult } from "../src/engine/benchmark-ledger";

const env = {} as Record<string, string | undefined>;

describe("benchmark judge policy", () => {
  test("the default judge is configured, else marina/default — never the target", () => {
    expect(defaultBenchmarkJudge(env)).toBe(BUILTIN_BENCHMARK_JUDGE);
    expect(defaultBenchmarkJudge({ MARINA_BENCHMARK_JUDGE_MODEL: " openai/gpt-x " })).toBe(
      "openai/gpt-x",
    );
    expect(resolveBenchmarkJudge({ target: "marina:answerer", env })).toEqual({
      model: "marina/default",
      source: "builtin",
    });
    expect(
      resolveBenchmarkJudge({
        target: "openai/gpt-y",
        env: { MARINA_BENCHMARK_JUDGE_MODEL: "openai/gpt-x" },
      }),
    ).toEqual({ model: "openai/gpt-x", source: "configured" });
    expect(resolveBenchmarkJudge({ target: "marina", judge: "openai/gpt-x", env })).toEqual({
      model: "openai/gpt-x",
      source: "explicit",
    });
  });

  test("a judge that is the target is refused without the opt-in", () => {
    // The bare default model graded by the default model: self-grading.
    const r = resolveBenchmarkJudge({ target: "marina", env });
    expect("error" in r && r.error).toContain("must not grade itself");
    // Explicitly naming the target.
    expect("error" in resolveBenchmarkJudge({ target: "a/b", judge: "a/b", env })).toBe(true);
    // The concrete default model is the same model as marina/default.
    expect(
      "error" in
        resolveBenchmarkJudge({ target: "openrouter/a/b", env, defaultModel: "openrouter/a/b" }),
    ).toBe(true);
  });

  test("self-judging is an explicit opt-in, recorded", () => {
    expect(resolveBenchmarkJudge({ target: "marina", selfJudge: true, env })).toEqual({
      model: "marina/default",
      source: "builtin",
      selfJudge: true,
    });
    // Opting in with a different judge records nothing: the run is not self-graded.
    expect(
      resolveBenchmarkJudge({ target: "a/b", judge: "c/d", selfJudge: true, env }),
    ).not.toHaveProperty("selfJudge");
  });

  test("model identity: aliases of the default model, the openrouter prefix", () => {
    expect(sameJudgeModel("marina", "marina/default")).toBe(true);
    expect(sameJudgeModel("openrouter/a/b", "a/b")).toBe(true);
    expect(sameJudgeModel("marina:answerer", "marina/default")).toBe(false);
    expect(sameJudgeModel("a/b", "marina/default", "a/b")).toBe(true);
    expect(sameJudgeModel("a/b", "marina/default")).toBe(false);
  });

  test("the ledger marks a self-graded run so it never pairs with an independent one", () => {
    expect(judgeLabel({ model: "m", endpoint: "http://x" })).toBe("m @ http://x");
    expect(judgeLabel({ model: "m", endpoint: "http://x", self_judge: true })).toBe(
      "m @ http://x [self-judge]",
    );
    expect(judgeLabel({})).toBeNull();
    const file = (self: boolean) => ({
      config: {
        dataset: "frames",
        judge: { model: "m", endpoint: "http://x", ...(self ? { self_judge: true } : {}) },
      },
      items: [{ id: "q1", correct: true }],
    });
    const opts = { targetKind: "model" as const, target: "m", raw: "", id: "r", now: 1 };
    expect(ledgerFromHarnessResult(file(true), opts).run.judge).toBe("m @ http://x [self-judge]");
    expect(ledgerFromHarnessResult(file(false), opts).run.judge).toBe("m @ http://x");
  });
});

describe("judge policy at the harness and tier0", () => {
  test("the harness refuses a judge-scored run that would grade itself", () => {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "../benchmarks/harness.ts"),
        "--benchmark",
        "frames",
        "--model",
        "marina",
        "--limit",
        "1",
      ],
      { env: { ...process.env, MARINA_BENCHMARK_JUDGE_MODEL: "" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("must not grade itself");
  });

  test("tier0's direct-provider control keeps target grading, now explicit", () => {
    const direct = resolveTier0Target("openrouter/v/m", {}, {});
    const args = tier0HarnessArgs({ benchmark: "frames", limit: 2 }, direct, {
      seed: 1,
      concurrency: 1,
    });
    expect(args[args.indexOf("--judge-model") + 1]).toBe("v/m");
    expect(args).toContain("--self-judge");
    // A crew target is graded by marina/default, never itself, with no opt-in.
    const crew = resolveTier0Target("marina:answerer", {}, {});
    const crewArgs = tier0HarnessArgs({ benchmark: "frames", limit: 2 }, crew, {
      seed: 1,
      concurrency: 1,
    });
    expect(crewArgs[crewArgs.indexOf("--judge-model") + 1]).toBe("marina/default");
    expect(crewArgs).not.toContain("--self-judge");
    // An explicit judge replaces the control's self-judging.
    const judged = tier0HarnessArgs({ benchmark: "frames", limit: 2 }, direct, {
      seed: 1,
      concurrency: 1,
      judgeModel: "x/y",
    });
    expect(judged).not.toContain("--self-judge");
  });
});
