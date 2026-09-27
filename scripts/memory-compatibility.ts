#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { getErrorMessage } from "../src/engine/errors";
import { MarinaDB } from "../src/persistence/database";
import { acquireDatabaseLease } from "../src/persistence/database-lease";
import { numericMemoryIntegrity } from "../src/persistence/db-memory-projections";

try {
  const [operation, path] = process.argv.slice(2);
  if (!path || !["status", "upgrade"].includes(operation ?? ""))
    throw new Error(
      "Usage: memory:compatibility status|upgrade DB. Backfill/retry were retired; database upgrades convert memory atomically.",
    );
  const release = acquireDatabaseLease(path);
  try {
    const db = new MarinaDB(path);
    try {
      const result = numericMemoryIntegrity(db.memoryRepository().raw);
      console.log(JSON.stringify(result));
      if (result.unconverted || result.broken || result.duplicateBodies) process.exitCode = 1;
    } finally {
      db.close();
    }
  } finally {
    release();
  }
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
