// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalFederationJson,
  signFederationDocument,
  verifyFederationDocument,
} from "../src/net/federation-crypto";

const previousKey = process.env.MARINA_FEDERATION_SIGNING_KEY;

afterEach(() => {
  if (previousKey === undefined) delete process.env.MARINA_FEDERATION_SIGNING_KEY;
  else process.env.MARINA_FEDERATION_SIGNING_KEY = previousKey;
});

function configureSigningKey(): void {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
}

describe("federation cryptography", () => {
  test("canonicalizes object keys while preserving array order", () => {
    expect(canonicalFederationJson({ z: 1, a: { y: 2, x: [3, 4] } })).toBe(
      '{"a":{"x":[3,4],"y":2},"z":1}',
    );
  });

  test("signs and verifies an Ed25519 envelope", () => {
    configureSigningKey();
    const signed = signFederationDocument({
      schema: "marina.federation.manifest.v2",
      worldId: "world-a",
      evidenceCheckpoint: { entries: 3, headHash: "abc" },
    });
    expect(signed.signature.keyId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyFederationDocument(signed)).toEqual({
      valid: true,
      keyId: signed.signature.keyId,
    });
  });

  test("rejects mutation and a forged key fingerprint", () => {
    configureSigningKey();
    const signed = signFederationDocument({ worldId: "world-a", entries: 3 });
    expect(verifyFederationDocument({ ...signed, entries: 4 }).valid).toBe(false);
    expect(
      verifyFederationDocument({
        ...signed,
        signature: { ...signed.signature, keyId: `sha256:${"0".repeat(64)}` },
      }).error,
    ).toBe("Public-key fingerprint mismatch");
  });
});
