// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Root of the agent-tools import DAG: the `ToolContext` every tool factory
// receives, perception → text formatting, the `execCommand` bridge that runs a
// world command through the SDK client and feeds perceptions to the game state,
// and the `wrap` helper that turns a typed schema + command builder into an
// AgentTool. Imports nothing from `./`; strips courtesy from outgoing messages
// (`../acknowledgement`).

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { stripAnsi } from "../../net/ansi";
import type { MarinaClient } from "../../sdk/client";
import type { Perception } from "../../types";
import { stripCommandPleasantry } from "../acknowledgement";
import type { GameStateManager } from "../game-state";
import { escapeHarnessMarkers, fenceToolResult } from "../peer-text";
import { toolResultTrust } from "../tool-policy";

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
        // Agents read text, not terminal colour codes.
        return stripAnsi(text || message) || `[${p.kind}]`;
      })
      .filter(Boolean)
      .join("\n\n") || "(no response)"
  );
}

// ─── Handler refusals ───────────────────────────────────────────────────────
//
// Command handlers answer a bad call with an ordinary message ("Usage: …",
// `Unknown task subcommand "x"`, `Pool "x" not found …`), which would otherwise
// reach the model as a successful tool result. These patterns are anchored
// to the FIRST line of a short, single-message reply, so listings and reads
// that merely mention such words stay successes.

const REFUSAL_FIRST_LINE: readonly RegExp[] = [
  /^usage:/i,
  /^unknown\b.*\b(command|subcommand|action|verb)\b/i,
  /^(error|failed|refused|denied)\b/i,
  /^(cannot|can't|could not|couldn't) /i,
  /^you must be at least\b/i,
];
const NOT_FOUND = /\bnot found\b/i;

/** The refusal text when a command's reply is a usage/unknown/not-found/refusal message. */
export function handlerRefusal(perceptions: Perception[]): string | undefined {
  const messages = perceptions.filter((p) => p.kind === "message");
  if (messages.length !== 1 || perceptions.some((p) => p.kind === "error")) return undefined;
  const text = formatPerceptions(messages).trim();
  const first = text.split("\n")[0]!.trim();
  if (REFUSAL_FIRST_LINE.some((pattern) => pattern.test(first))) return text;
  if (text.length <= 600 && first.length <= 200 && NOT_FOUND.test(first)) return text;
  return undefined;
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
  // Outgoing `tell` / `channel send` lose courtesy openers and closers.
  command = stripCommandPleasantry(command);

  const perceptions = await ctx.client.command(command, signal);
  for (const p of perceptions) {
    ctx.gameState.handlePerception(p);
  }
  const failures = perceptions.filter((p) => p.kind === "error");
  if (failures.length) throw new Error(formatPerceptions(failures));
  const refusal = handlerRefusal(perceptions);
  if (refusal) throw new Error(refusal);

  return {
    content: [{ type: "text", text: renderCommandResult(command, formatPerceptions(perceptions)) }],
    details: {
      command,
      perceptionCount: perceptions.length,
      deliveries: perceptions.flatMap((p) => (p.data.delivery ? [p.data.delivery] : [])),
      contextBlocks: perceptions.flatMap((p) => {
        const code =
          p.tag === "code"
            ? (p.data.code as { metadata?: { contextBlocks?: unknown[] } } | undefined)
            : undefined;
        const blocks = code?.metadata?.contextBlocks;
        return Array.isArray(blocks) ? blocks : [];
      }),
    },
  };
}

/**
 * A command result as the model reads it. External content (web, data,
 * probes, connectors, process output) is fenced as untrusted data; peer
 * messages (channel history, boards, the tell inbox, the feed) as peer
 * content; any peer-authored world text has its harness markers escaped
 * (`./peer-text`). Everything else is returned as the engine sent it.
 */
export function renderCommandResult(command: string, text: string): string {
  const trust = toolResultTrust("marina_command", { command });
  if (trust.fence) return fenceToolResult(text, trust.fence);
  return trust.sources.includes("world_event") ? escapeHarnessMarkers(text) : text;
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
