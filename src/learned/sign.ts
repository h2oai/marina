// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Publisher signatures for learned bundles and revocation lists — Ed25519
 * through `src/net/federation-crypto.ts`, with a DEDICATED key (never the
 * federation or arena key). Verification is ONLY against pinned publisher
 * keys: the key embedded in a signature proves possession, never provenance,
 * so a document signed by any key that is not pinned is refused.
 *
 * Pinned keys come from `BUILTIN_PUBLISHER_KEYS` (shipped in source) and the
 * operator's `MARINA_LEARNED_PUBLISHER_KEYS` (comma-separated `label=<base64
 * SPKI>` or bare base64). The built-in list is empty until a publisher key is
 * created and pinned by its owner (docs/guides/learned-bundles.md).
 */

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  type FederationSignature,
  keyIdOfPublicKey,
  signFederationDocument,
  verifyFederationDocument,
} from "../net/federation-crypto";

export interface PinnedKey {
  label: string;
  publicKey: string;
  keyId: string;
}

/**
 * Publisher keys pinned in source. Empty on purpose: the H2O.ai publisher key
 * is created offline by its owner and added here in its own reviewed change.
 */
export const BUILTIN_PUBLISHER_KEYS: readonly { label: string; publicKey: string }[] = [];

/** Parse `label=<base64 SPKI>` / `<base64 SPKI>` entries (comma or whitespace separated). */
export function parsePinnedKeys(raw: string | undefined): PinnedKey[] {
  const out: PinnedKey[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    const e = entry.trim();
    if (!e) continue;
    const eq = e.indexOf("=");
    // base64 ends in '=' padding only: an '=' followed by more key material
    // separates a label.
    const labelled = eq > 0 && e.length - eq - 1 > 2;
    const label = labelled ? e.slice(0, eq) : "";
    const publicKey = labelled ? e.slice(eq + 1) : e;
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      if (key.asymmetricKeyType !== "ed25519") continue;
      const keyId = keyIdOfPublicKey(publicKey);
      out.push({ label: label || keyId.slice(0, 19), publicKey, keyId });
    } catch {
      // allow-empty-catch: an unparsable entry pins nothing (it can never verify)
    }
  }
  return out;
}

/** Every pinned key: the built-in list plus the operator's env list. */
export function pinnedPublisherKeys(env: NodeJS.ProcessEnv = process.env): PinnedKey[] {
  const builtin = BUILTIN_PUBLISHER_KEYS.map((k) => ({
    label: k.label,
    publicKey: k.publicKey,
    keyId: keyIdOfPublicKey(k.publicKey),
  }));
  return [...builtin, ...parsePinnedKeys(env.MARINA_LEARNED_PUBLISHER_KEYS)];
}

/** Sign a document with the dedicated learned-bundle key. */
export function signLearned(
  document: Record<string, unknown>,
  signingKey: string,
): FederationSignature {
  return signFederationDocument(document, {
    signingKey,
    keyName: "MARINA_LEARNED_SIGNING_KEY",
  }).signature;
}

export type VerifyResult =
  | { ok: true; keyId: string; label: string }
  | { ok: false; keyId: string | null; error: string };

/** Verify `document` + `signature` against the pinned keys only. */
export function verifyAgainstPinned(
  document: Record<string, unknown>,
  signature: FederationSignature | undefined,
  pinned: readonly PinnedKey[],
): VerifyResult {
  if (!signature || typeof signature !== "object")
    return { ok: false, keyId: null, error: "unsigned" };
  const pin = pinned.find((k) => k.keyId === signature.keyId);
  if (!pin) {
    return {
      ok: false,
      keyId: signature.keyId ?? null,
      error: `publisher key ${signature.keyId ?? "?"} is not pinned (MARINA_LEARNED_PUBLISHER_KEYS)`,
    };
  }
  const v = verifyFederationDocument(
    { ...document, signature },
    { pinnedPublicKey: pin.publicKey },
  );
  return v.valid
    ? { ok: true, keyId: pin.keyId, label: pin.label }
    : { ok: false, keyId: v.keyId, error: v.error ?? "signature verification failed" };
}

/**
 * A fresh Ed25519 key pair as `{ privateKey: base64 PKCS#8 DER, publicKey:
 * base64 SPKI DER }` — for tests and for an operator creating their own
 * instance key (`bun run learned keygen`). Never the H2O.ai publisher key.
 */
export function generateLearnedKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64"),
    publicKey: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64"),
  };
}
