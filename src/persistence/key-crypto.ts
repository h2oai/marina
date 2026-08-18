// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * API-key encryption at rest.
 *
 * Stored provider keys (the `api_keys` table) are sensitive. When
 * `MARINA_KEY_SECRET` is set (>= 16 chars), this module encrypts key values with
 * AES-256-GCM before they touch the database and decrypts them transparently on
 * read, so every existing caller keeps seeing plaintext. Without the secret,
 * keys are stored as-is (plaintext) and `isKeyEncryptionEnabled()` reports false
 * so the Admin → Security panel tells the truth.
 *
 * Format of an encrypted value: `mk1:<ivB64>:<tagB64>:<ciphertextB64>`.
 * The 256-bit key is derived from the secret with scrypt (static app salt — the
 * secret is the entropy) and cached, so per-value decrypt is just AES-GCM.
 *
 * NOTE: the secret is the only thing that can decrypt stored keys. Lose or
 * change it and previously-encrypted values become unreadable (decrypt returns
 * "" — treated as a missing key) and must be re-entered.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ENV_SECRET = "MARINA_KEY_SECRET";
const MIN_SECRET_LEN = 16;
const PREFIX = "mk1:";
const SCRYPT_SALT = "marina-key-encryption-v1";

let cachedKey: { secret: string; key: Buffer } | null = null;

/** True when key-at-rest encryption is configured and active. */
export function isKeyEncryptionEnabled(): boolean {
  const s = process.env[ENV_SECRET];
  return !!s && s.length >= MIN_SECRET_LEN;
}

function deriveKey(secret: string): Buffer {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = scryptSync(secret, SCRYPT_SALT, 32);
  cachedKey = { secret, key };
  return key;
}

/** Whether a stored value is one of our AES-GCM blobs (vs. legacy plaintext). */
export function isEncryptedValue(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

/** Encrypt a plaintext secret. Throws if encryption isn't enabled. */
export function encryptSecret(plaintext: string): string {
  const secret = process.env[ENV_SECRET];
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error(
      `${ENV_SECRET} must be set (>= ${MIN_SECRET_LEN} chars) to encrypt API keys at rest`,
    );
  }
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a stored value. Legacy plaintext (no prefix) passes through unchanged,
 * so reads work whether or not a given row was ever encrypted. Returns "" when
 * the blob can't be decrypted (secret missing/changed) — callers then treat the
 * key as absent rather than sending garbage upstream.
 */
export function decryptSecret(stored: string): string {
  if (!isEncryptedValue(stored)) return stored;
  const secret = process.env[ENV_SECRET];
  if (!secret) return "";
  try {
    const parts = stored.slice(PREFIX.length).split(":");
    if (parts.length !== 3) return "";
    const [ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(secret),
      Buffer.from(ivB64!, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}
