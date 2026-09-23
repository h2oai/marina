// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared fixture for the memory-transfer-*.test.ts family (split from the
 * former single memory-transfer.test.ts so the 14 s volume test can sit in its
 * own file and shard independently).
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { exportState, importState } from "../src/persistence/export-import";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { memoryPortableDigest } from "../src/sdk/memory-portable";
import type { MemoryTransferPage } from "../src/sdk/memory-transfer";

/** Per-test teardown queue; each test file drains it in its own afterEach. */
export const cleanups: (() => void | Promise<void>)[] = [];

/** Drain and run every registered cleanup (newest first). */
export async function runTransferCleanups(): Promise<void> {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}
export async function fixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "marina-transfer-"));
  let db = new MarinaDB(join(directory, "memory.db")),
    service = new MemoryService(db);
  const owner = db.ensurePrincipal({ type: "service", displayName: name }).principal_id;
  const credential = db.issueMemoryCredential(owner);
  const client = new MarinaMemoryClient(`http://${name}.test`, credential.token, 130000, (req) =>
    handleMemoryServiceApi(req, service),
  );
  const space = (await client.createSpace(name)).id;
  const get = () => ({
    db,
    service,
    actor: db.verifyMemoryCredential(credential.token)!,
    raw: (db as unknown as { db: Database }).db,
  });
  cleanups.push(async () => {
    await service.close();
    db.close();
    rmSync(directory, { recursive: true });
  });
  return {
    client,
    space,
    credential,
    owner,
    get,
    snapshotRoundTrip() {
      const snapshot = exportState(join(directory, "memory.db"));
      db.close();
      const result = importState(join(directory, "memory.db"), snapshot);
      db = new MarinaDB(join(directory, "memory.db"));
      service = new MemoryService(db);
      return result;
    },
    restart() {
      db.close();
      db = new MarinaDB(join(directory, "memory.db"));
      service = new MemoryService(db);
    },
  };
}
export async function sign(page: MemoryTransferPage) {
  const { sha256: _, next_cursor: __, ...payload } = page;
  return { ...page, sha256: await memoryPortableDigest(payload) };
}
