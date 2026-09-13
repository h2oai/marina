// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { MemoryError } from "../memory/service-types";

const active = new WeakSet<Database>();
export function requireMemoryWriter(db: Database) {
  if (active.has(db))
    throw new MemoryError(
      503,
      "import_busy",
      "Memory publication is in progress; retry the same request key",
    );
}
/** SQLite remains a single writer. Avoid blocking the server thread on that
 * lock: memory writes get a retryable error, other SQLite callers fail fast. */
export function admitMemoryImport(db: Database) {
  requireMemoryWriter(db);
  const path = (db.query("PRAGMA database_list").all() as { name: string; file: string }[]).find(
    (row) => row.name === "main",
  )?.file;
  if (!path)
    throw new MemoryError(
      503,
      "import_process_unavailable",
      "Background publication requires a file-backed database",
    );
  const prior = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  db.exec("PRAGMA busy_timeout=0");
  active.add(db);
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      active.delete(db);
      db.exec(`PRAGMA busy_timeout=${prior}`);
    },
  };
}
