import { describe, expect, it } from "bun:test";
import type { Score } from "../src/coordination/score";
import { composeStepMessage, runScore } from "../src/sdk/conduct";

function score(steps: Score["steps"]): Score {
  return { id: "sc1", goal: "g", author: "alice", steps };
}

/** Records every dispatch and replies "<target>:<n>". */
function recorder() {
  const calls: { target: string; message: string }[] = [];
  return {
    calls,
    tellAndAwait: async (target: string, message: string) => {
      calls.push({ target, message });
      return `${target}-reply`;
    },
  };
}

describe("runScore — live dispatch over tellAndAwait", () => {
  it("dispatches a chain to the right targets and threads outputs forward", async () => {
    const s = score([
      { id: "plan", instruction: "draft plan", assignee: "planner", access: [] },
      { id: "build", instruction: "implement", assignee: "builder", access: ["plan"] },
    ]);
    const rec = recorder();
    const run = await runScore(s, { tellAndAwait: rec.tellAndAwait });

    expect(rec.calls.map((c) => c.target)).toEqual(["planner", "builder"]);
    expect(run.result).toBe("builder-reply"); // terminal step output
    // builder's message carried plan's reply as threaded context
    const buildMsg = rec.calls.find((c) => c.target === "builder")!.message;
    expect(buildMsg).toContain("implement");
    expect(buildMsg).toContain("[plan] planner-reply");
  });

  it("composeStepMessage includes instruction, context, and a reply directive", () => {
    const msg = composeStepMessage({
      step: { id: "b", instruction: "do the thing", assignee: "x", access: ["a"] },
      assignee: { kind: "entity", value: "x" },
      inputs: [{ fromStepId: "a", output: "prior result" }],
      depth: 0,
    });
    expect(msg).toContain("do the thing");
    expect(msg).toContain("Context from prior steps:");
    expect(msg).toContain("[a] prior result");
    expect(msg).toContain("Reply with your result only.");
  });

  it("errors on a role: assignee with no resolver", async () => {
    const s = score([{ id: "a", instruction: "x", assignee: "role:scholar", access: [] }]);
    const rec = recorder();
    await expect(runScore(s, { tellAndAwait: rec.tellAndAwait })).rejects.toThrow(/resolve/);
  });

  it("uses an injected resolver for role: assignees", async () => {
    const s = score([{ id: "a", instruction: "x", assignee: "role:scholar", access: [] }]);
    const rec = recorder();
    const run = await runScore(s, {
      tellAndAwait: rec.tellAndAwait,
      resolveAssignee: (a) => (a.kind === "role" ? "carol" : null),
    });
    expect(rec.calls[0]!.target).toBe("carol");
    expect(run.result).toBe("carol-reply");
  });

  it("addresses model: workers by their id by default", async () => {
    const s = score([{ id: "a", instruction: "x", assignee: "model:openai/gpt-4o", access: [] }]);
    const rec = recorder();
    await runScore(s, { tellAndAwait: rec.tellAndAwait });
    expect(rec.calls[0]!.target).toBe("openai/gpt-4o");
  });
});
