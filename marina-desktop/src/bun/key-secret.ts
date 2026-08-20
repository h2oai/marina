// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Provide config-free encryption for the desktop database. The secret lives in
 * a separate owner-readable file, so a copied database does not expose keys.
 * An explicitly supplied MARINA_KEY_SECRET always wins.
 */
export function ensureDesktopKeySecret(
  secretFile: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.MARINA_KEY_SECRET;
  if (configured && configured.length >= 16) return configured;

  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, `${randomBytes(32).toString("hex")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  chmodSync(secretFile, 0o600);
  const secret = readFileSync(secretFile, "utf8").trim();
  if (secret.length < 16) throw new Error("Desktop key-encryption secret is invalid");
  env.MARINA_KEY_SECRET = secret;
  return secret;
}
