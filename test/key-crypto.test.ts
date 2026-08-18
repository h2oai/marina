// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedValue,
  isKeyEncryptionEnabled,
} from "../src/persistence/key-crypto";
import { cleanupDb } from "./helpers";

const SECRET = "test-secret-at-least-16-chars-long";

describe("key-crypto", () => {
  const prev = process.env.MARINA_KEY_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.MARINA_KEY_SECRET;
    else process.env.MARINA_KEY_SECRET = prev;
  });

  it("isKeyEncryptionEnabled tracks the secret (and its length)", () => {
    delete process.env.MARINA_KEY_SECRET;
    expect(isKeyEncryptionEnabled()).toBe(false);
    process.env.MARINA_KEY_SECRET = "too-short";
    expect(isKeyEncryptionEnabled()).toBe(false);
    process.env.MARINA_KEY_SECRET = SECRET;
    expect(isKeyEncryptionEnabled()).toBe(true);
  });

  it("round-trips a value through AES-256-GCM", () => {
    process.env.MARINA_KEY_SECRET = SECRET;
    const enc = encryptSecret("sk-super-secret");
    expect(isEncryptedValue(enc)).toBe(true);
    expect(enc).not.toContain("sk-super-secret");
    expect(decryptSecret(enc)).toBe("sk-super-secret");
  });

  it("passes legacy plaintext through unchanged", () => {
    process.env.MARINA_KEY_SECRET = SECRET;
    expect(isEncryptedValue("sk-plain")).toBe(false);
    expect(decryptSecret("sk-plain")).toBe("sk-plain");
  });

  it("returns empty when the secret can't decrypt the blob", () => {
    process.env.MARINA_KEY_SECRET = SECRET;
    const enc = encryptSecret("sk-secret");
    process.env.MARINA_KEY_SECRET = "a-different-secret-16chars";
    expect(decryptSecret(enc)).toBe("");
  });
});

describe("api_keys encryption at rest (DB)", () => {
  const TEST_DB = "test_key_crypto.db";
  const prev = process.env.MARINA_KEY_SECRET;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (prev === undefined) delete process.env.MARINA_KEY_SECRET;
    else process.env.MARINA_KEY_SECRET = prev;
  });

  it("stores a blob but reads back plaintext when the secret is set", () => {
    process.env.MARINA_KEY_SECRET = SECRET;
    db.saveApiKey({ name: "k1", provider: "openai", encryptedValue: "sk-live", setBy: "test" });
    // Reads decrypt transparently.
    expect(db.getApiKey("k1")?.encrypted_value).toBe("sk-live");

    // Drop the secret → the on-disk value is a blob we can no longer read,
    // proving it was encrypted at rest (not stored plaintext).
    delete process.env.MARINA_KEY_SECRET;
    expect(db.getApiKey("k1")?.encrypted_value).toBe("");
  });

  it("migrates pre-existing plaintext rows once a secret is configured", () => {
    // Saved with no secret → plaintext on disk.
    db.saveApiKey({ name: "k2", provider: "openai", encryptedValue: "sk-old", setBy: "test" });
    expect(db.getApiKey("k2")?.encrypted_value).toBe("sk-old");

    process.env.MARINA_KEY_SECRET = SECRET;
    expect(db.migrateApiKeysToEncrypted()).toBe(1);
    // Still reads plaintext with the secret…
    expect(db.getApiKey("k2")?.encrypted_value).toBe("sk-old");
    // …but is now a blob at rest (unreadable without the secret).
    delete process.env.MARINA_KEY_SECRET;
    expect(db.getApiKey("k2")?.encrypted_value).toBe("");
  });

  it("migration is a no-op when no secret is configured", () => {
    delete process.env.MARINA_KEY_SECRET;
    db.saveApiKey({ name: "k3", provider: "openai", encryptedValue: "sk-plain", setBy: "test" });
    expect(db.migrateApiKeysToEncrypted()).toBe(0);
    expect(db.getApiKey("k3")?.encrypted_value).toBe("sk-plain");
  });

  it("auditEncryptedKeys flags encrypted rows the current secret can't read", () => {
    process.env.MARINA_KEY_SECRET = SECRET;
    db.saveApiKey({ name: "k4", provider: "openai", encryptedValue: "sk-live", setBy: "test" });
    // Readable under the right secret.
    expect(db.auditEncryptedKeys()).toEqual({ encrypted: 1, unreadable: 0 });

    // Secret removed → the blob is now unreadable (the loud misconfig).
    delete process.env.MARINA_KEY_SECRET;
    expect(db.auditEncryptedKeys()).toEqual({ encrypted: 1, unreadable: 1 });

    // Wrong secret → also unreadable.
    process.env.MARINA_KEY_SECRET = "another-secret-16chars-min";
    expect(db.auditEncryptedKeys()).toEqual({ encrypted: 1, unreadable: 1 });
  });

  it("auditEncryptedKeys reports zero for plaintext rows", () => {
    delete process.env.MARINA_KEY_SECRET;
    db.saveApiKey({ name: "k5", provider: "openai", encryptedValue: "sk-plain", setBy: "test" });
    expect(db.auditEncryptedKeys()).toEqual({ encrypted: 0, unreadable: 0 });
  });
});
