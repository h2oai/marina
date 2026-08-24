// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

export interface FederationSignature {
  algorithm: "Ed25519";
  publicKey: string;
  keyId: string;
  value: string;
}

type SignedDocument = Record<string, unknown> & { signature?: FederationSignature };

/** Deterministic JSON for signed protocol documents. Values must be JSON-compatible. */
export function canonicalFederationJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFederationJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalFederationJson(record[key])}`)
    .join(",")}}`;
}

function unsignedDocument(document: SignedDocument): Record<string, unknown> {
  const { signature: _signature, ...unsigned } = document;
  return unsigned;
}

function decodePrivateKey(value: string) {
  const trimmed = value.trim().replace(/\\n/g, "\n");
  return trimmed.includes("BEGIN PRIVATE KEY")
    ? createPrivateKey(trimmed)
    : createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
}

export function federationSigningAvailable(): boolean {
  return Boolean(process.env.MARINA_FEDERATION_SIGNING_KEY?.trim());
}

export function signFederationDocument<T extends Record<string, unknown>>(
  document: T,
): T & {
  signature: FederationSignature;
} {
  const encoded = process.env.MARINA_FEDERATION_SIGNING_KEY?.trim();
  if (!encoded) throw new Error("MARINA_FEDERATION_SIGNING_KEY is not configured");
  const privateKey = decodePrivateKey(encoded);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("MARINA_FEDERATION_SIGNING_KEY must be an Ed25519 PKCS#8 private key");
  }
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(publicDer).toString("base64");
  const keyId = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
  const value = cryptoSign(
    null,
    Buffer.from(canonicalFederationJson(unsignedDocument(document)), "utf8"),
    privateKey,
  ).toString("base64");
  return { ...document, signature: { algorithm: "Ed25519", publicKey, keyId, value } };
}

export function verifyFederationDocument(document: SignedDocument): {
  valid: boolean;
  keyId: string | null;
  error?: string;
} {
  const signature = document.signature;
  if (!signature) return { valid: false, keyId: null, error: "Document is unsigned" };
  if (signature.algorithm !== "Ed25519") {
    return { valid: false, keyId: null, error: "Unsupported signature algorithm" };
  }
  try {
    const publicDer = Buffer.from(signature.publicKey, "base64");
    const expectedKeyId = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
    if (signature.keyId !== expectedKeyId) {
      return { valid: false, keyId: signature.keyId, error: "Public-key fingerprint mismatch" };
    }
    const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return { valid: false, keyId: signature.keyId, error: "Public key is not Ed25519" };
    }
    const valid = cryptoVerify(
      null,
      Buffer.from(canonicalFederationJson(unsignedDocument(document)), "utf8"),
      publicKey,
      Buffer.from(signature.value, "base64"),
    );
    return valid
      ? { valid: true, keyId: signature.keyId }
      : { valid: false, keyId: signature.keyId, error: "Signature verification failed" };
  } catch {
    return { valid: false, keyId: signature.keyId, error: "Malformed signature material" };
  }
}
