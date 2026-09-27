// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { tryLogAsync } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import type { CommandDef } from "../types";
import { replayPendingBridges } from "./legacy-bridge";

const logger = new Logger();

/** Legacy mutations enqueue in their SQLite transaction. Adapters only wake
 * the shared worker; they never need to orchestrate per-verb mirror writes. */
export async function flushMemoryCompatibility(db: MarinaDB): Promise<void> {
  if (db.pendingLegacyBridges(1).length) await replayPendingBridges(db);
}

/** Keep synchronous world commands in their tick. Async commands flush after
 * completion too; failures still leave committed work recoverable on restart. */
export function withMemoryCompatibility(
  db: MarinaDB | undefined,
  handler: CommandDef["handler"],
): CommandDef["handler"] {
  const flush = () => {
    if (db)
      void tryLogAsync(logger, "memory", "Compatibility work remains queued", () =>
        flushMemoryCompatibility(db),
      );
  };
  return (ctx, input) => {
    try {
      const result = handler(ctx, input);
      if (result instanceof Promise) return result.finally(flush);
      flush();
      return result;
    } catch (error) {
      flush();
      throw error;
    }
  };
}
