// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { acquireDatabaseLease, unlockStoppedDatabase } from "../src/persistence/database-lease";
import { createRecoveryBundle, restoreRecoveryBundle } from "../src/persistence/recovery-bundle";

test("offline recovery round-trips databases, private configuration, assets and workspaces; rejects live leases and tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-bundle-test-"));
  const dbPath = join(dir, "world.db");
  const db = new MarinaDB(dbPath);
  const id = db.createNote("Alice", "recovery evidence");
  db.close();
  const auth = new Database(join(dir, "auth.db"));
  auth.run("CREATE TABLE accounts(id TEXT PRIMARY KEY)");
  auth.run("INSERT INTO accounts VALUES ('identity')");
  auth.close();
  mkdirSync(join(dir, "workspace"));
  writeFileSync(join(dir, "workspace", "code.ts"), "export const value = 42;");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "image.bin"), new Uint8Array([1, 2, 3]));
  writeFileSync(join(dir, ".env"), "MARINA_KEY_SECRET=private-fixture-key\n");
  const spec = {
    databases: { world: dbPath, auth: join(dir, "auth.db") },
    files: { assets: "assets", workspace: "workspace", configuration: ".env" },
  };
  const release = acquireDatabaseLease(dbPath);
  try {
    expect(() => createRecoveryBundle(spec, join(dir, "blocked"), dir)).toThrow("leased");
    expect(() => unlockStoppedDatabase(dbPath)).toThrow("leased");
  } finally {
    release();
  }
  try {
    const bundle = join(dir, "bundle"),
      restored = join(dir, "restored");
    createRecoveryBundle(spec, bundle, dir);
    restoreRecoveryBundle(bundle, restored);
    const recovered = new MarinaDB(join(restored, "databases", "world.db"));
    try {
      expect(recovered.getNote(id)?.content).toBe("recovery evidence");
    } finally {
      recovered.close();
    }
    expect(readFileSync(join(restored, "files", "workspace", "code.ts"), "utf8")).toContain("42");
    expect(statSync(join(restored, "files", "configuration")).mode & 0o777).toBe(0o600);
    expect(() => restoreRecoveryBundle(bundle, restored)).toThrow("must be new");
    writeFileSync(join(bundle, "files", "assets", "image.bin"), "tampered");
    expect(() => restoreRecoveryBundle(bundle, join(dir, "tampered"))).toThrow(
      "verification failed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
