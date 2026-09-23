// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Meta key-value ────────────────────────────────────────────────────────

export function getMetaValue(db: Database, key: string): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? undefined;
}

export function setMetaValue(db: Database, key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
}
