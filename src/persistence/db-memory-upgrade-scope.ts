// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

const upgrading = new WeakSet<Database>();
export function isMemoryUpgrade(db: Database): boolean {
  return upgrading.has(db);
}
/** Only synchronous, transactional data conversion may preserve older rows
 * exceeding today's admission limits. Never used by request handlers. */
export function withMemoryUpgrade<T>(db: Database, run: () => T): T {
  if (!db.inTransaction || upgrading.has(db)) throw new Error("Invalid memory upgrade scope");
  upgrading.add(db);
  try {
    return run();
  } finally {
    upgrading.delete(db);
  }
}
