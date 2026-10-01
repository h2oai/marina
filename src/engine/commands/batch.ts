// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandDef, EntityId } from "../../types";
import { splitCommandChain } from "../parse-input";

const MAX_BATCH = 20;

export function batchCommand(deps: {
  processCommand: (entityId: EntityId, raw: string) => void | Promise<void>;
  /** Optional rate-limit check. When present, each subcommand consumes
   * one token; batching N commands costs the same as N individual
   * commands — no amplification. */
  checkRateLimit?: (entityId: EntityId) => boolean;
  /** Whether `verb` runs as a command for this entity (builtin, room command
   *  or macro) — lets a `;` inside a message stay text (`splitCommandChain`). */
  isCommand?: (entityId: EntityId, verb: string) => boolean;
}): CommandDef {
  return {
    category: "System",
    usage: ["batch <commands>"],
    name: "batch",
    aliases: [],
    help: "Execute multiple commands in sequence, separated by semicolons.\nUsage: batch look ; north ; look ; note Found something\n\nA ';' inside a message (say, tell, channel send, note, …) stays text unless a command follows it; quote the text or write \\; to keep any ';' literal. Up to 20 commands per batch. Each subcommand consumes one rate-limit token.",
    async handler(ctx, input) {
      const isCommand = deps.isCommand;
      const commands = splitCommandChain(
        input.args,
        isCommand ? (verb) => isCommand(input.entity, verb) : undefined,
      );

      if (commands.length === 0) {
        ctx.send(input.entity, "Usage: batch <cmd1> ; <cmd2> ; <cmd3>");
        return;
      }

      if (commands.length > MAX_BATCH) {
        ctx.send(input.entity, `Batch limited to ${MAX_BATCH} commands. Got ${commands.length}.`);
        return;
      }

      let executed = 0;
      let rateBlocked = 0;
      for (const cmd of commands) {
        // Consume one rate-limit token per subcommand so batching provides
        // no amplification over sending commands individually. Note: the
        // outer `batch` invocation already consumed a token at the entry
        // point, so we start from the second subcommand's worth of work.
        if (deps.checkRateLimit && !deps.checkRateLimit(input.entity)) {
          rateBlocked++;
          continue;
        }
        await deps.processCommand(input.entity, cmd);
        executed++;
      }

      if (rateBlocked > 0) {
        ctx.send(
          input.entity,
          `Batch: executed ${executed}, rate-limited ${rateBlocked} subcommand(s). Slow down.`,
        );
      }
    },
  };
}
