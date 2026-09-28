// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A key-encryption secret by default. When `MARINA_KEY_SECRET` is unset,
 * Marina keeps a random secret in `<DB_PATH>.key-secret` (mode 0600, reused on
 * every restart) so provider keys saved in the database are encrypted at rest
 * without any configuration — a copied database alone no longer exposes them.
 * An explicit `MARINA_KEY_SECRET` always wins (the desktop app does the same
 * with its own file).
 *
 * Never loses a key:
 *  - existing plaintext rows are left as they are (reads pass plaintext
 *    through); only keys saved from now on are encrypted. An explicit
 *    `MARINA_KEY_SECRET` still migrates them in place as before;
 *  - a database that already holds encrypted keys but has no secret file is
 *    NOT given a fresh secret (that would strand those keys behind the wrong
 *    secret) — the caller warns and the operator restores the original.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const MIN_SECRET_LEN = 16;

/** The secret in `process.env` came from this process's own secret file. */
let automatic = false;

/**
 * True when `MARINA_KEY_SECRET` was filled from `<DB_PATH>.key-secret` by this
 * process. A child process with its own database (a child world) must not
 * inherit it: its keys would then depend on a file next to the PARENT's
 * database. Strip it from such a child's environment so it keeps its own.
 */
export function keySecretIsAutomatic(): boolean {
  return automatic;
}

export function resetKeySecretForTests(): void {
  automatic = false;
}

export function keySecretPath(dbPath: string): string {
  return `${dbPath}.key-secret`;
}

export type KeySecretSource =
  /** `MARINA_KEY_SECRET` was already set: nothing to do. */
  | { source: "env" }
  /** Loaded from the existing file. */
  | { source: "file"; path: string }
  /** Created the file just now. */
  | { source: "created"; path: string }
  /** In-memory database: nothing on disk to protect. */
  | { source: "none"; reason: "memory" }
  /** Encrypted keys exist but no file: refused to mint a secret that cannot read them. */
  | { source: "none"; reason: "orphaned"; path: string; encrypted: number };

/**
 * Make sure `env.MARINA_KEY_SECRET` is set for an on-disk database, from the
 * secret file next to it (created when absent). `encryptedKeyCount` is the
 * number of already-encrypted rows, read before any secret is chosen.
 */
export function ensureKeySecret(
  dbPath: string,
  encryptedKeyCount: () => number,
  env: NodeJS.ProcessEnv = process.env,
): KeySecretSource {
  const configured = env.MARINA_KEY_SECRET;
  if (configured && configured.length >= MIN_SECRET_LEN) return { source: "env" };
  if (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file::memory:")) {
    return { source: "none", reason: "memory" };
  }
  const path = keySecretPath(dbPath);
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) chmodSync(path, 0o600);
    const secret = readFileSync(path, "utf8").trim();
    if (secret.length < MIN_SECRET_LEN) {
      throw new Error(`${path} does not hold a valid key-encryption secret; restore or remove it`);
    }
    env.MARINA_KEY_SECRET = secret;
    automatic = env === process.env;
    return { source: "file", path };
  }
  const encrypted = encryptedKeyCount();
  if (encrypted > 0) return { source: "none", reason: "orphaned", path, encrypted };
  writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  env.MARINA_KEY_SECRET = readFileSync(path, "utf8").trim();
  automatic = env === process.env;
  return { source: "created", path };
}
