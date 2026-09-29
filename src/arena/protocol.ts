// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Social Simulation Arena signed-forecast wire protocol (`ssa-signed-forecast-v1`,
 * Route B): the entrant signs each forecast with its own Ed25519 key and POSTs it.
 * A byte-for-byte port of the arena's `ssa/signed_forecasts.py` signing input —
 * `test/arena.test.ts` pins it against a vector produced by the arena's own code.
 * Pure: no I/O. The private key never leaves this process; only the public half
 * is ever published (in the arena registration).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";

export const PROTOCOL_VERSION = "ssa-signed-forecast-v1";
export const FORECAST_PATH = "/api/v1/forecasts";
export const DEFAULT_ORIGIN = "https://social-simulation-arena.com";
/** Domain separation, not a secret: must equal the deployment's SSA_INTAKE_AUDIENCE. */
export const DEFAULT_AUDIENCE = "ssa-production-v1";
export const MAX_BODY_BYTES = 65_536;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export interface SignedMeta {
  entrant: string;
  "key-id": string;
  "request-id": string;
  timestamp: string;
}

/**
 * Python `json.dumps(v, sort_keys=True, separators=(',', ':'))` — keys sorted,
 * no whitespace, non-ASCII escaped as `\uXXXX` (Python's default ensure_ascii).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number");
    }
    return asciiJson(JSON.stringify(value));
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${asciiJson(JSON.stringify(k))}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    );
  return `{${entries.join(",")}}`;
}

function asciiJson(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping every non-ASCII code unit
  return s.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The exact bytes the entrant signs (`ssa.signed_forecasts.signing_bytes`). */
export function signingBytes(meta: SignedMeta, body: Uint8Array, audience: string): Buffer {
  return Buffer.from(
    canonicalJson({
      protocol: PROTOCOL_VERSION,
      audience,
      method: "POST",
      path: FORECAST_PATH,
      entrant: meta.entrant,
      key_id: meta["key-id"],
      request_id: meta["request-id"],
      signed_at: meta.timestamp,
      body_sha256: sha256Hex(body),
    }),
  );
}

export function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} "${value}" is not a valid arena identifier`);
}

// ─── Keys ────────────────────────────────────────────────────────────────────

// PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A private key from PKCS#8 PEM (what `arena keygen` writes) or the raw 32-byte seed. */
/**
 * The 32-byte Ed25519 seed from an unencrypted OpenSSH private key
 * (`-----BEGIN OPENSSH PRIVATE KEY-----`, what `ssh-keygen -t ed25519` writes
 * and the arena's registration guide asks for). Node's crypto cannot read this
 * container, so it is unpacked here: magic, cipher/kdf `none`, one key, and the
 * private section's `ssh-ed25519` entry, whose 64-byte private field is the
 * seed followed by the public key (cross-checked against the embedded one).
 */
export function openSshEd25519Seed(text: string): Buffer {
  const body = text
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/, "")
    .replace(/-----END OPENSSH PRIVATE KEY-----[\s\S]*$/, "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(body, "base64");
  const magic = Buffer.from("openssh-key-v1\0");
  if (!buf.subarray(0, magic.length).equals(magic)) throw new Error("not an OpenSSH private key");
  let at = magic.length;
  const u32 = () => {
    if (at + 4 > buf.length) throw new Error("truncated OpenSSH private key");
    const v = buf.readUInt32BE(at);
    at += 4;
    return v;
  };
  const bytes = () => {
    const n = u32();
    if (at + n > buf.length) throw new Error("truncated OpenSSH private key");
    const out = buf.subarray(at, at + n);
    at += n;
    return out;
  };
  const cipher = bytes().toString();
  const kdf = bytes().toString();
  bytes(); // kdf options
  if (cipher !== "none" || kdf !== "none") {
    throw new Error(
      "the OpenSSH arena key is passphrase-protected; remove the passphrase on a copy (ssh-keygen -p -N '' -f <copy>) or use an unencrypted key file",
    );
  }
  if (u32() !== 1) throw new Error("OpenSSH key file must hold exactly one key");
  bytes(); // public key blob
  const priv = bytes();
  let p = 0;
  const pu32 = () => {
    const v = priv.readUInt32BE(p);
    p += 4;
    return v;
  };
  const pbytes = () => {
    const n = pu32();
    const out = priv.subarray(p, p + n);
    p += n;
    return out;
  };
  if (pu32() !== pu32()) throw new Error("corrupt OpenSSH private key (check bytes differ)");
  if (pbytes().toString() !== "ssh-ed25519") throw new Error("arena key must be Ed25519");
  const pub = pbytes();
  const secret = pbytes();
  if (pub.length !== 32 || secret.length !== 64 || !secret.subarray(32).equals(pub)) {
    throw new Error("corrupt OpenSSH Ed25519 key");
  }
  return Buffer.from(secret.subarray(0, 32));
}

export function loadPrivateKey(data: Buffer | string) {
  let bytes = typeof data === "string" ? Buffer.from(data) : data;
  if (bytes.subarray(0, 40).toString().includes("BEGIN OPENSSH PRIVATE KEY")) {
    bytes = openSshEd25519Seed(bytes.toString());
  }
  if (bytes.length === 32) {
    return createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, bytes]),
      format: "der",
      type: "pkcs8",
    });
  }
  const key = createPrivateKey(bytes);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("arena key must be Ed25519");
  return key;
}

/** Base64 of the raw 32-byte public key — the `public` field of a registration key. */
export function publicKeyBase64(privateKey: ReturnType<typeof loadPrivateKey>): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("could not derive the public key");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** A fresh keypair as PKCS#8 PEM (keep private) plus the public base64 (publish). */
export function generateArenaKey(): { privatePem: string; publicBase64: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicBase64: publicKeyBase64(privateKey),
  };
}

export function signRequest(
  meta: Omit<SignedMeta, never>,
  body: Uint8Array,
  audience: string,
  privateKey: ReturnType<typeof loadPrivateKey>,
): string {
  return sign(null, signingBytes(meta, body, audience), privateKey).toString("base64");
}

/** UTC ISO timestamp in the arena's format (microsecond precision, `Z`). */
export function arenaTimestamp(now: Date): string {
  return now.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}
