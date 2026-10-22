// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The capture quota is answered from the covering index (migration 178),
 * never by reading stored payloads: `bytes` sits after the up-to-2 MiB
 * `value_json`, so a plain scan walked every earlier payload on every write.
 */

import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { CONTENT_QUOTA_USED_SQL } from "../src/persistence/db-investigation-journal";

it("the capture quota sum uses the covering (attempt_id, bytes) index", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-investigation-quota-"));
  const path = join(directory, "world.db");
  try {
    new MarinaDB(path).close();
    const raw = new Database(path, { readonly: true });
    try {
      const plan = (
        raw.query(`EXPLAIN QUERY PLAN ${CONTENT_QUOTA_USED_SQL}`).all("attempt", "case") as {
          detail: string;
        }[]
      )
        .map((row) => row.detail)
        .join(" | ");
      expect(plan).toContain("COVERING INDEX idx_investigation_content_attempt_bytes");
    } finally {
      raw.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
