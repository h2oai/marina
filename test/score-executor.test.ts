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
