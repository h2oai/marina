// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CommandDef, EntityId } from "../../types";

const MAX_BATCH = 20;

export function batchCommand(deps: {
  processCommand: (entityId: EntityId, raw: string) => void;
  /** Optional rate-limit check. When present, each subcommand consumes
   * one token; batching N commands costs the same as N individual
   * commands — no amplification. */
  checkRateLimit?: (entityId: EntityId) => boolean;
}): CommandDef {
  return {
    name: "batch",
    aliases: [],
    help: "Execute multiple commands in sequence, separated by semicolons.\nUsage: batch look ; north ; look ; note Found something\n\nUp to 20 commands per batch. Each subcommand consumes one rate-limit token.",
    handler(ctx, input) {
      const commands = input.args
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);

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
        deps.processCommand(input.entity, cmd);
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
