// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `marina_command` — the universal escape hatch resident in every profile —
// plus the `COMMAND_ROSTER` / `ECOLOGY_ROSTER` re-export importers reach
// through `./tools`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { COMMAND_ROSTER, ECOLOGY_ROSTER } from "../prompts/lean-system";
import { execCommand, type ToolContext } from "./shared";

// ─── marina_command (foundation) ──────────────────────────────────────────

const commandSchema = Type.Object({
  command: Type.String({
    description: "The command to execute (e.g., 'look', 'north', 'say hello', 'note something')",
  }),
});

/**
 * The command roster lives in the system prompt (`# COMMANDS`, one copy in the
 * stable prefix — see prompts/lean-system.ts). Re-exported here so existing
 * importers and tests keep one import path.
 */
export { COMMAND_ROSTER, ECOLOGY_ROSTER };

/**
 * `marina_command` — the universal escape hatch, resident in EVERY profile.
 * Its description is one sentence: the roster used to ride here (~2 KB on
 * every request); it now rides once in the system prompt. `rosterMode` is
 * accepted for call-site compatibility and ignored.
 */
export function createCommandTool(
  ctx: ToolContext,
  _rosterMode: "compact" | "verbose" = "verbose",
): AgentTool<typeof commandSchema> {
  return {
    name: "marina_command",
    label: "Execute Command",
    description:
      "Run any raw Marina world command (see # COMMANDS in your instructions; `help <command>` explains one) — the universal escape hatch when no typed tool fits.",
    parameters: commandSchema,
    execute: async (_id, { command }: Static<typeof commandSchema>, signal) =>
      execCommand(ctx, command, signal),
  };
}
