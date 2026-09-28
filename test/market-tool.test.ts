// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createWorldTools, type ToolContext } from "../src/agent/tools";
import type { MarinaClient } from "../src/sdk/client";
import type { Perception } from "../src/types";

function fakeCtx() {
  const commands: string[] = [];
  const client = {
    isConnected: () => true,
    command: async (cmd: string): Promise<Perception[]> => {
      commands.push(cmd);
      return [{ kind: "system", data: { text: "ok" } } as unknown as Perception];
    },
  } as unknown as MarinaClient;
  const ctx = { client, gameState: { handlePerception() {} } } as unknown as ToolContext;
  return { ctx, commands };
}

describe("marina_market tool", () => {
  it("routes market actions to `market` and positions to the `position` command", async () => {
    const { ctx, commands } = fakeCtx();
    const tool = createWorldTools(ctx).find((t) => t.name === "marina_market");
    if (!tool) throw new Error("marina_market tool not found");
    await tool.execute("call-1", { action: "leaderboard" });
    await tool.execute("call-2", { action: "info", args: "market:tech" });
    await tool.execute("call-3", { action: "position", args: "open kalshi KXTEST yes 1" });
    await tool.execute("call-4", { action: "position", args: "list" });
    expect(commands).toEqual([
      "market leaderboard",
      "market info market:tech",
      "position open kalshi KXTEST yes 1",
      "position list",
    ]);
  });
});
