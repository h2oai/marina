// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { createPrivateKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaData } from "../src/arena/data";
import { loadPrivateKey, openSshEd25519Seed, publicKeyBase64 } from "../src/arena/protocol";
import { arenaRegistrationCheck } from "../src/arena/service";

/** An `openssh-key-v1` container for an Ed25519 key, as `ssh-keygen -t ed25519 -N ''` writes it. */
function openSshKey(seed: Buffer, pub: Buffer, cipher = "none"): string {
  const str = (b: Buffer | string) => {
    const v = typeof b === "string" ? Buffer.from(b) : b;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(v.length);
    return Buffer.concat([len, v]);
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const pubBlob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
  let priv = Buffer.concat([
    u32(0x1234abcd),
    u32(0x1234abcd),
    str("ssh-ed25519"),
    str(pub),
    str(Buffer.concat([seed, pub])),
    str(""),
  ]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    str(cipher),
    str(cipher === "none" ? "none" : "bcrypt"),
    str(""),
    u32(1),
    str(pubBlob),
    str(priv),
  ]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function freshKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(der.subarray(der.length - 32));
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { privateKey, seed, pub };
}

describe("arena key formats", () => {
  it("loads an unencrypted OpenSSH Ed25519 key and signs as the same key", () => {
    const { privateKey, seed, pub } = freshKey();
    const loaded = loadPrivateKey(openSshKey(seed, pub));
    expect(publicKeyBase64(loaded)).toBe(pub.toString("base64"));
    const msg = Buffer.from("round");
    const sig = sign(null, msg, loaded);
    expect(
      verify(null, msg, createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })), sig),
    ).toBe(true);
    expect(openSshEd25519Seed(openSshKey(seed, pub)).equals(seed)).toBe(true);
  });

  it("refuses a passphrase-protected OpenSSH key with instructions, and non-keys", () => {
    const { seed, pub } = freshKey();
    expect(() => loadPrivateKey(openSshKey(seed, pub, "aes256-ctr"))).toThrow(
      "passphrase-protected",
    );
    expect(() =>
      openSshEd25519Seed(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      ),
    ).toThrow();
  });
});

describe("registration check", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-arena-key-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const { seed, pub } = freshKey();
  const keyFile = join(dir, "k");
  writeFileSync(keyFile, openSshKey(seed, pub));
  chmodSync(keyFile, 0o600);
  const ours = pub.toString("base64");
  const env = (keyId: string) => ({
    MARINA_ARENA_ENTRANT: "acme-test",
    MARINA_ARENA_KEY_FILE: keyFile,
    MARINA_ARENA_KEY_ID: keyId,
  });
  const dataWith = (entrant: unknown) =>
    new ArenaData("https://example.test", async (url) =>
      url.endsWith("entrants/acme-test.json") && entrant
        ? Response.json(entrant)
        : new Response("", { status: 404 }),
    );

  it("reports OK only when the key id and public key both match, unrevoked", async () => {
    const reg = { entrant_id: "acme-test", keys: [{ id: "k9", alg: "ed25519", public: ours }] };
    expect((await arenaRegistrationCheck(env("k9"), dataWith(reg))).ok).toBe(true);
    const wrongId = await arenaRegistrationCheck(env("k1"), dataWith(reg));
    expect(wrongId.ok).toBe(false);
    expect(wrongId.message).toContain("set MARINA_ARENA_KEY_ID=k9");
    const other = { entrant_id: "acme-test", keys: [{ id: "k9", public: "c29tZW90aGVya2V5" }] };
    expect((await arenaRegistrationCheck(env("k9"), dataWith(other))).message).toContain(
      "different public key",
    );
    const revoked = { entrant_id: "acme-test", keys: [{ id: "k9", public: ours, revoked: true }] };
    expect((await arenaRegistrationCheck(env("k9"), dataWith(revoked))).ok).toBe(false);
    expect((await arenaRegistrationCheck(env("k9"), dataWith(undefined))).message).toContain(
      "not registered yet",
    );
  });
});
