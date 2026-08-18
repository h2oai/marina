// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createWorldTools, type ToolContext } from "../src/agent/tools";
import type { MarinaClient } from "../src/sdk/client";
import type { Perception } from "../src/types";

const STORED = JSON.stringify({
  goal: "research question",
  steps: [
    { id: "dig", instruction: "research it", assignee: "role:scholar", access: [] },
    { id: "write", instruction: "summarize", assignee: "scribe", access: ["dig"] },
  ],
});

const INLINE = JSON.stringify({
  goal: "ship",
  steps: [
    { id: "plan", instruction: "plan it", assignee: "planner", access: [] },
    { id: "build", instruction: "build it", assignee: "builder", access: ["plan"] },
  ],
});

function perception(text: string): Perception {
  return { kind: "system", data: { text } } as unknown as Perception;
}

function fakeCtx() {
  const commands: string[] = [];
  const tells: { target: string; message: string }[] = [];
  const client = {
    command: async (cmd: string): Promise<Perception[]> => {
      commands.push(cmd);
      if (cmd.startsWith("conduct json")) return [perception(STORED)];
      if (cmd.startsWith("conduct resolve role:scholar")) return [perception("carol")];
      if (cmd.startsWith("conduct resolve")) return [perception("(unresolved)")];
      return [perception("ok")];
    },
    tellAndAwait: async (target: string, message: string): Promise<string> => {
      tells.push({ target, message });
      return `${target}-output`;
    },
  } as unknown as MarinaClient;
  const ctx = { client, gameState: { handlePerception() {} } } as unknown as ToolContext;
  return { ctx, commands, tells };
}

function conductTool(ctx: ToolContext) {
  const tool = createWorldTools(ctx).find((t) => t.name === "marina_conduct");
  if (!tool) throw new Error("marina_conduct tool not found");
  return tool;
}

async function text(tool: ReturnType<typeof conductTool>, params: unknown): Promise<string> {
  const res = (await tool.execute("call-1", params)) as { content: { text: string }[] };
  return res.content.map((c) => c.text).join("\n");
}

describe("marina_conduct tool", () => {
  it("runs an inline Score, dispatching steps to entity workers in order", async () => {
    const { ctx, tells } = fakeCtx();
    const out = await text(conductTool(ctx), { score: INLINE });
    expect(tells.map((t) => t.target)).toEqual(["planner", "builder"]);
    expect(out).toContain("Result: builder-output");
    // build received plan's output as threaded context
    expect(tells[1]!.message).toContain("[plan] planner-output");
  });

  it("loads a stored Score by name and pre-resolves role: assignees", async () => {
    const { ctx, commands, tells } = fakeCtx();
    const out = await text(conductTool(ctx), { name: "myscore" });
    expect(commands).toContain("conduct json myscore");
    expect(commands).toContain("conduct resolve role:scholar");
    // role:scholar resolved to carol; scribe is an entity
    expect(tells.map((t) => t.target).sort()).toEqual(["carol", "scribe"]);
    expect(out).toContain("Result:");
  });

  it("reports a finished run to the feed via 'conduct ran'", async () => {
    const { ctx, commands } = fakeCtx();
    await text(conductTool(ctx), { name: "myscore" });
    expect(commands.some((c) => c.startsWith("conduct ran myscore --"))).toBe(true);
  });

  it("errors clearly when neither name nor score is given", async () => {
    const { ctx } = fakeCtx();
    const out = await text(conductTool(ctx), {});
    expect(out).toContain("Provide a stored");
  });
});
