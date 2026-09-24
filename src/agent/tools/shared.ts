// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Root of the agent-tools import DAG: the `ToolContext` every tool factory
// receives, perception → text formatting, the `execCommand` bridge that runs a
// world command through the SDK client and feeds perceptions to the game state,
// and the `wrap` helper that turns a typed schema + command builder into an
// AgentTool. Imports nothing from `./`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { MarinaClient } from "../../sdk/client";
import type { Perception } from "../../types";
import type { GameStateManager } from "../game-state";

// ─── Shared Context ─────────────────────────────────────────────────────────

export interface ToolContext {
  client: MarinaClient;
  gameState: GameStateManager;
}

// ─── Perception Formatting ──────────────────────────────────────────────────

export function formatPerceptions(perceptions: Perception[]): string {
  return (
    perceptions
      .map((p) => {
        const text = (p.data?.text as string) ?? "";
        const message = (p.data?.message as string) ?? "";
        return text || message || `[${p.kind}]`;
      })
      .filter(Boolean)
      .join("\n\n") || "(no response)"
  );
}

// ─── Command Execution Helper ───────────────────────────────────────────────

export async function execCommand(
  ctx: ToolContext,
  command: string,
  signal?: AbortSignal,
): Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, unknown> }> {
  if (!ctx.client.isConnected()) {
    throw new Error("Not connected to Marina.");
  }
  if (signal?.aborted) throw new Error("Command aborted");

  const perceptions = await ctx.client.command(command);
  for (const p of perceptions) {
    ctx.gameState.handlePerception(p);
  }

  return {
    content: [{ type: "text", text: formatPerceptions(perceptions) }],
    details: { command, perceptionCount: perceptions.length },
  };
}

export function wrap(
  name: string,
  labelStr: string,
  desc: string,
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema types vary
  schema: any,
  buildCmd: (params: Record<string, unknown>) => string,
  ctx: ToolContext,
): AgentTool {
  return {
    name,
    label: labelStr,
    description: desc,
    parameters: schema,
    execute: async (_id: string, params: unknown, signal?: AbortSignal) =>
      execCommand(ctx, buildCmd(params as Record<string, unknown>), signal),
  };
}
