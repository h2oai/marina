#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { getErrorMessage } from "../src/engine/errors";
import { replayPendingBridges } from "../src/memory/legacy-bridge";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";
import { acquireDatabaseLease } from "../src/persistence/database-lease";

try {
  const [operation, path, owner] = process.argv.slice(2);
  if (!path || !["status", "backfill", "retry"].includes(operation ?? ""))
    throw new Error("Usage: memory:compatibility status|backfill|retry DB [OWNER]");
  const release = acquireDatabaseLease(path);
  const db = new MarinaDB(path);
  try {
    if (operation === "backfill") {
      let cursor = 0;
      for (;;) {
        const page = db.queueLegacyBridgeBackfill(owner, cursor);
        if (!page.scanned) break;
        cursor = page.afterId;
        await replayPendingBridges(db, 1000);
        console.log(JSON.stringify({ scanned: page.scanned, cursor }));
      }
      // Provenance can create more work than notes. Drain bounded batches
      // while progress is made; persistent failures remain visible below.
      for (;;) {
        const before = db.pendingLegacyBridges(1000).map((job) => job.id);
        if (!before.length) break;
        await replayPendingBridges(db, 1000);
        const after = db.pendingLegacyBridges(1000).map((job) => job.id);
        if (before.length === after.length && before.every((id, index) => id === after[index]))
          break;
      }
    } else if (operation === "retry") await replayPendingBridges(db, 1000);
    const pending = db
      .pendingLegacyBridges(1000)
      .map(({ id, operation, attempts, last_error }) => ({ id, operation, attempts, last_error }));
    console.log(JSON.stringify({ pending }));
    if (pending.length && operation !== "status") process.exitCode = 1;
  } finally {
    await closeWorldMemoryService(db);
    db.close();
    release();
  }
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
