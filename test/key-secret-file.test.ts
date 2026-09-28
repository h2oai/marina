// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Default key-encryption secret: `<DB_PATH>.key-secret` (0600) when
 * MARINA_KEY_SECRET is unset. Existing plaintext keys keep working, keys
 * saved afterwards are encrypted, and a database with encrypted keys but no
 * secret file is never handed a fresh (wrong) secret.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { isEncryptedValue } from "../src/persistence/key-crypto";
import {
  ensureKeySecret,
  keySecretPath,
  resetKeySecretForTests,
} from "../src/persistence/key-secret-file";
import { inheritedChildEnv } from "../src/world/world-collective-manager";

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "key-secret-"));
  prev = process.env.MARINA_KEY_SECRET;
  delete process.env.MARINA_KEY_SECRET;
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARINA_KEY_SECRET;
  else process.env.MARINA_KEY_SECRET = prev;
  resetKeySecretForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureKeySecret", () => {
  it("an explicit MARINA_KEY_SECRET wins and no file is written", () => {
    const env = { MARINA_KEY_SECRET: "x".repeat(32) };
    const db = join(dir, "w.db");
    expect(ensureKeySecret(db, () => 0, env)).toEqual({ source: "env" });
    expect(existsSync(keySecretPath(db))).toBe(false);
  });

  it("creates a 0600 file once and reuses it; in-memory databases get none", () => {
    const db = join(dir, "w.db");
    const env: NodeJS.ProcessEnv = {};
    expect(ensureKeySecret(db, () => 0, env).source).toBe("created");
    const secret = env.MARINA_KEY_SECRET!;
    expect(secret.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== "win32") expect(statSync(keySecretPath(db)).mode & 0o777).toBe(0o600);
    const again: NodeJS.ProcessEnv = {};
    expect(ensureKeySecret(db, () => 0, again).source).toBe("file");
    expect(again.MARINA_KEY_SECRET).toBe(secret);
    expect(ensureKeySecret(":memory:", () => 0, {})).toEqual({ source: "none", reason: "memory" });
  });

  it("refuses to mint a secret for a database that already holds encrypted keys", () => {
    const db = join(dir, "w.db");
    const env: NodeJS.ProcessEnv = {};
    expect(ensureKeySecret(db, () => 2, env)).toMatchObject({
      source: "none",
      reason: "orphaned",
      encrypted: 2,
    });
    expect(env.MARINA_KEY_SECRET).toBeUndefined();
    expect(existsSync(keySecretPath(db))).toBe(false);
  });

  it("rejects a truncated secret file instead of replacing it", () => {
    const db = join(dir, "w.db");
    writeFileSync(keySecretPath(db), "short\n", { mode: 0o600 });
    expect(() => ensureKeySecret(db, () => 0, {})).toThrow(/valid key-encryption secret/);
    expect(readFileSync(keySecretPath(db), "utf8")).toBe("short\n");
  });
});

describe("keys across the switch to a default secret", () => {
  it("a plaintext key saved before keeps working; a key saved after is encrypted", () => {
    const dbPath = join(dir, "w.db");
    const db = new MarinaDB(dbPath);
    try {
      db.saveApiKey({ name: "old", provider: "openai", encryptedValue: "sk-old", setBy: "t" });
      ensureKeySecret(dbPath, () => db.auditEncryptedKeys().encrypted);
      expect(process.env.MARINA_KEY_SECRET).toBeDefined();
      db.saveApiKey({ name: "new", provider: "openai", encryptedValue: "sk-new", setBy: "t" });
      expect(db.getApiKey("old")?.encrypted_value).toBe("sk-old");
      expect(db.getApiKey("new")?.encrypted_value).toBe("sk-new");
      const raw = (db as unknown as { db: import("bun:sqlite").Database }).db
        .query("SELECT name, encrypted_value FROM api_keys ORDER BY name")
        .all() as {
        name: string;
        encrypted_value: string;
      }[];
      expect(isEncryptedValue(raw.find((r) => r.name === "new")!.encrypted_value)).toBe(true);
      expect(raw.find((r) => r.name === "old")!.encrypted_value).toBe("sk-old");
      // A child world does not inherit the parent's automatic secret.
      expect(inheritedChildEnv().MARINA_KEY_SECRET).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
