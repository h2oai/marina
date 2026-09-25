// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { type Score, ScoreError } from "../src/coordination/score";
import {
  type DispatchContext,
  executeScore,
  type ScoreStepEvent,
} from "../src/coordination/score-executor";

function score(steps: Score["steps"]): Score {
  return { id: "sc1", goal: "g", author: "alice", steps };
}

describe("Score executor", () => {
  it("runs a chain and threads access outputs forward", async () => {
    const s = score([
      { id: "plan", instruction: "make a plan", assignee: "planner", access: [] },
      { id: "build", instruction: "implement", assignee: "builder", access: ["plan"] },
    ]);
    const seen: Record<string, DispatchContext["inputs"]> = {};
    const run = await executeScore(s, async (ctx) => {
      seen[ctx.step.id] = ctx.inputs;
      return `${ctx.step.id}:done`;
    });
    expect(run.outputs.plan).toBe("plan:done");
    expect(run.outputs.build).toBe("build:done");
    expect(run.result).toBe("build:done"); // terminal step
    // build saw plan's output as input
    expect(seen.build).toEqual([{ fromStepId: "plan", output: "plan:done" }]);
    expect(seen.plan).toEqual([]);
  });

  it("runs independent steps and feeds both into the sink", async () => {
    const s = score([
      { id: "a", instruction: "branch a", assignee: "x", access: [] },
      { id: "b", instruction: "branch b", assignee: "y", access: [] },
      { id: "merge", instruction: "combine", assignee: "z", access: ["a", "b"] },
    ]);
    let mergeInputs: DispatchContext["inputs"] = [];
    const run = await executeScore(s, async (ctx) => {
      if (ctx.step.id === "merge") mergeInputs = ctx.inputs;
      return `${ctx.step.id}!`;
    });
    expect(run.result).toBe("merge!");
    expect(mergeInputs).toEqual([
      { fromStepId: "a", output: "a!" },
      { fromStepId: "b", output: "b!" },
    ]);
  });

  it("emits start/done lifecycle events per step", async () => {
    const s = score([{ id: "a", instruction: "go", assignee: "x", access: [] }]);
    const events: ScoreStepEvent[] = [];
    await executeScore(s, async () => "ok", { onStep: (e) => events.push(e) });
    expect(events.map((e) => e.phase)).toEqual(["start", "done"]);
    expect(events[1]!.output).toBe("ok");
  });

  it("rejects an invalid Score before dispatching", async () => {
    const s = score([{ id: "a", instruction: "x", assignee: "bob", access: ["ghost"] }]);
    let dispatched = false;
    await expect(
      executeScore(s, async () => {
        dispatched = true;
        return "";
      }),
    ).rejects.toThrow(ScoreError);
    expect(dispatched).toBe(false);
  });

  it("errors on a conduct step with no conduct handler", async () => {
    const s = score([{ id: "a", instruction: "sub-goal", assignee: "conduct", access: [] }]);
    await expect(executeScore(s, async () => "")).rejects.toThrow(/no conduct handler/);
  });

  it("routes conduct steps to the handler with incremented depth", async () => {
    const s = score([{ id: "a", instruction: "sub-goal", assignee: "conduct", access: [] }]);
    let handlerDepth = -1;
    const run = await executeScore(s, async () => "should-not-be-called", {
      conduct: async (ctx) => {
        handlerDepth = ctx.depth;
        return "sub-result";
      },
    });
    expect(handlerDepth).toBe(1); // top level is 0; conduct child is 1
    expect(run.result).toBe("sub-result");
  });

  it("enforces the recursion depth cap", async () => {
    const s = score([{ id: "a", instruction: "deep", assignee: "conduct", access: [] }]);
    await expect(
      executeScore(s, async () => "", {
        conduct: async () => "x",
        depth: 3,
        maxDepth: 3,
      }),
    ).rejects.toThrow(/max depth/);
  });

  it("propagates dispatch errors", async () => {
    const s = score([{ id: "a", instruction: "x", assignee: "bob", access: [] }]);
    await expect(
      executeScore(s, async () => {
        throw new Error("worker blew up");
      }),
    ).rejects.toThrow(/worker blew up/);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("bounded Score execution", () => {
  it("admits ready successors while an unrelated branch is still running", async () => {
    const slow = deferred<string>();
    const successor = deferred<void>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const run = executeScore(
      score([
        { id: "slow", instruction: "slow", assignee: "x", access: [] },
        { id: "fast", instruction: "fast", assignee: "y", access: [] },
        { id: "next", instruction: "ready", assignee: "z", access: ["fast"] },
        { id: "end", instruction: "merge", assignee: "z", access: ["slow", "next"] },
      ]),
      async (ctx) => {
        started.push(ctx.step.id);
        peak = Math.max(peak, ++active);
        try {
          if (ctx.step.id === "slow") return await slow.promise;
          if (ctx.step.id === "next") successor.resolve();
          return ctx.step.id;
        } finally {
          active--;
        }
      },
      { concurrency: 2 },
    );
    await successor.promise;
    expect(started).toEqual(["slow", "fast", "next"]);
    slow.resolve("done");
    expect((await run).result).toBe("end");
    expect(peak).toBe(2);
  });

  it("cancels active dispatch, stops queued steps and ignores late results", async () => {
    const controller = new AbortController();
    const work = deferred<string>();
    const signals: AbortSignal[] = [];
    const events: ScoreStepEvent[] = [];
    const run = executeScore(
      score([
        { id: "first", instruction: "first", assignee: "x", access: [] },
        { id: "queued", instruction: "queued", assignee: "y", access: [] },
      ]),
      (ctx) => {
        signals.push(ctx.signal);
        return work.promise;
      },
      {
        signal: controller.signal,
        concurrency: 1,
        onStep: (event) => events.push(event),
      },
    );
    controller.abort();
    await expect(run).rejects.toThrow("aborted");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    work.resolve("late success");
    await Promise.resolve();
    expect(events.some((event) => event.phase === "done")).toBe(false);
  });

  it("a failed worker cancels its active siblings without admitting queued work", async () => {
    const failed = deferred<string>();
    const signals: AbortSignal[] = [];
    const run = executeScore(
      score(["a", "b", "c"].map((id) => ({ id, instruction: id, assignee: id, access: [] }))),
      (ctx) => {
        signals.push(ctx.signal);
        return ctx.step.id === "a" ? failed.promise : new Promise(() => {});
      },
      { concurrency: 2 },
    );
    failed.reject(new Error("worker failed"));
    await expect(run).rejects.toThrow("worker failed");
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("enforces an overall deadline even when a dispatcher ignores cancellation", async () => {
    const run = executeScore(
      score([{ id: "a", instruction: "hang", assignee: "x", access: [] }]),
      () => new Promise(() => {}),
      { timeoutMs: 10 },
    );
    await expect(run).rejects.toThrow("deadline exceeded");
  });

  it("snapshots instructions and rejects invalid concurrency before starting", async () => {
    const first = deferred<string>();
    const s = score([
      { id: "a", instruction: "first", assignee: "x", access: [] },
      { id: "b", instruction: "original", assignee: "y", access: ["a"] },
    ]);
    const run = executeScore(s, (ctx) =>
      ctx.step.id === "a" ? first.promise : Promise.resolve(ctx.step.instruction),
    );
    s.steps[1]!.instruction = "changed";
    first.resolve("ready");
    expect((await run).result).toBe("original");
    await expect(executeScore(s, async () => "bad", { concurrency: 0 })).rejects.toThrow(
      "positive integer",
    );
  });
});
