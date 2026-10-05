// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `marina.learned.v1` artifact envelope, as documented for Phase 1 part C
 * (manifest fields: identity, lineage, publisher, licence and terms, access,
 * slices, file digests; `signature.json` = Ed25519 over the canonical manifest
 * via `src/net/federation-crypto.ts`, verified ONLY against a pinned key).
 *
 * INTEGRATION NOTE: part C had not landed on origin/main when this extension
 * was written. This module codes against its documented interface and reuses
 * the core canonicaliser and verifier, so there is still exactly one format.
 * When part C lands, replace the bodies below with re-exports of the core
 * envelope module; the field names here follow the documented manifest.
 *
 * A world artifact is NOT a second format: it is a `marina.learned.v1`
 * envelope whose `content_profile` is `marina.world.v1` (see `world.ts`).
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalFederationJson,
  type FederationSignature,
  verifyFederationDocument,
} from "../../../src/net/federation-crypto";

export const LEARNED_SCHEMA = "marina.learned.v1";

export type AccessModel = "open" | "token" | "private";
export type Redistribution = "allowed" | "licensee-only" | "none";
export type CommercialUse = "allowed" | "licensed" | "none";

export interface Publisher {
  name: string;
  /** `sha256:<hex>` of the SPKI DER, the same fingerprint federation keys use. */
  key_id: string;
  /** Base64 SPKI. Informational: verification never trusts it, only the pin list. */
  public_key: string;
  url?: string;
}

/** One slice (tier). A slice selects files; tiers `core|standard|full` are slices. */
export interface Slice {
  id: string;
  /** Free-form selector metadata (domains, families, scopes, tier). */
  selector?: Record<string, unknown>;
  files: string[];
  /**
   * Access for THIS slice. `open` slices import with no entitlement check and no
   * network call; `token` slices need an entitlement. Absent ⇒ the manifest-level
   * `access.model`.
   */
  access?: AccessModel;
}

export interface LearnedManifest {
  schema: typeof LEARNED_SCHEMA;
  /** Content profile carried by this envelope (`marina.world.v1` for worlds). */
  content_profile?: string;
  /** Stable URN: `marina-memory:<key id>/<name>` or `marina-world:<key id>/<name>`. */
  artifact_id: string;
  name: string;
  description: string;
  /** Semver. */
  version: string;
  /** Monotonic integer; an importer refuses a downgrade. */
  generation: number;
  parent: { version: string; manifest_digest: string } | null;
  lineage: Array<{ version: string; manifest_digest: string; forked_from?: string }>;
  created_at: string;
  min_marina_version: string;
  profile: "internal" | "public" | "personal";
  publisher: Publisher;
  /** SPDX id or `LicenseRef-<publisher>-commercial`. Proprietary is the default for worlds. */
  license: string;
  terms?: { url: string; sha256: string };
  attribution_required: boolean;
  redistribution: Redistribution;
  commercial_use: CommercialUse;
  access: {
    model: AccessModel;
    /** Key ids (beyond the publisher's) allowed to sign entitlements for this artifact. */
    entitlement_issuers?: string[];
    /** Chains on which the publisher sells on-chain licences (names from operator config). */
    chains?: Array<{ family: string; chain_id: number | string; license_contract: string }>;
  };
  slices: Slice[];
  /** Every payload file and its sha256 hex digest. Nothing outside this map is read. */
  files: Record<string, string>;
  counts: Record<string, number>;
}

export interface Bundle {
  dir: string;
  manifest: LearnedManifest;
  signature: FederationSignature;
  /** sha256 hex of the canonical manifest: the artifact's provenance anchor. */
  manifestDigest: string;
}

/** A pinned publisher key. Only keys in this list can make a bundle or entitlement valid. */
export interface PinnedKey {
  name: string;
  public_key: string;
}

export function keyIdOf(publicKeyB64: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex")}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function manifestDigest(manifest: LearnedManifest): string {
  return sha256Hex(canonicalFederationJson(manifest));
}

/**
 * Sign a document with an explicit Ed25519 PKCS#8 key, producing the same
 * `FederationSignature` shape and canonical bytes as `signFederationDocument`
 * (which reads its key from the federation env var; artifacts use a dedicated
 * publisher key per decision D-11, held by the operator, never by Marina).
 */
export function signWithKey<T extends Record<string, unknown>>(
  document: T,
  privateKeyPem: string,
): FederationSignature {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Publisher key must be Ed25519");
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(spki).toString("base64");
  const { signature: _ignored, ...unsigned } = document as T & { signature?: unknown };
  return {
    algorithm: "Ed25519",
    publicKey,
    keyId: keyIdOf(publicKey),
    value: cryptoSign(null, Buffer.from(canonicalFederationJson(unsigned), "utf8"), key).toString(
      "base64",
    ),
  };
}

export type VerifyResult =
  | { ok: true; keyId: string; publisher: string }
  | { ok: false; error: string };

/**
 * Verify a signed document against the PINNED key list. The embedded public key
 * is never trusted on its own: its fingerprint must match a pinned entry and the
 * bytes must equal that pinned key.
 */
export function verifyPinned(
  document: Record<string, unknown>,
  signature: FederationSignature | undefined,
  pinned: readonly PinnedKey[],
): VerifyResult {
  if (!signature) return { ok: false, error: "unsigned" };
  const pin = pinned.find((key) => keyIdOf(key.public_key) === signature.keyId);
  if (!pin) return { ok: false, error: `signing key ${signature.keyId} is not pinned` };
  const result = verifyFederationDocument(
    { ...document, signature },
    { pinnedPublicKey: pin.public_key },
  );
  return result.valid
    ? { ok: true, keyId: signature.keyId, publisher: pin.name }
    : { ok: false, error: result.error ?? "signature invalid" };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Structural validation of the manifest; returns problems (empty = valid). */
export function validateManifest(manifest: LearnedManifest): string[] {
  const problems: string[] = [];
  if (manifest.schema !== LEARNED_SCHEMA) problems.push(`schema must be ${LEARNED_SCHEMA}`);
  if (
    !/^marina-(memory|world):sha256:[0-9a-f]{64}\/[a-z0-9][a-z0-9-]{0,63}$/.test(
      manifest.artifact_id,
    )
  )
    problems.push("artifact_id must be marina-(memory|world):<publisher key id>/<name>");
  else if (!manifest.artifact_id.includes(manifest.publisher?.key_id ?? "\u0000"))
    problems.push("artifact_id must name the publisher key id");
  if (!SEMVER.test(manifest.version)) problems.push("version must be semver");
  if (!Number.isInteger(manifest.generation) || manifest.generation < 1)
    problems.push("generation must be a positive integer");
  if (typeof manifest.license !== "string" || !manifest.license) problems.push("license required");
  if (!["allowed", "licensee-only", "none"].includes(manifest.redistribution))
    problems.push("redistribution invalid");
  if (!["allowed", "licensed", "none"].includes(manifest.commercial_use))
    problems.push("commercial_use invalid");
  if (!["open", "token", "private"].includes(manifest.access?.model))
    problems.push("access.model invalid");
  const ids = new Set<string>();
  for (const slice of manifest.slices ?? []) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(slice.id) || ids.has(slice.id))
      problems.push(`slice id invalid or duplicate: ${slice.id}`);
    ids.add(slice.id);
    if (slice.access && !["open", "token", "private"].includes(slice.access))
      problems.push(`slice ${slice.id} access invalid`);
    for (const file of slice.files ?? [])
      if (!Object.hasOwn(manifest.files ?? {}, file))
        problems.push(`slice ${slice.id} names unlisted file ${file}`);
  }
  for (const [path, digest] of Object.entries(manifest.files ?? {})) {
    if (!FILE_PATH.test(path) || path.split("/").some((part) => part === ".." || part === "."))
      problems.push(`unsafe file path: ${path}`);
    if (!/^[0-9a-f]{64}$/.test(digest)) problems.push(`bad digest for ${path}`);
    if (path === "manifest.json" || path === "signature.json")
      problems.push(`reserved file name in payload: ${path}`);
  }
  return problems;
}

/** Access model of one slice (slice override, else the manifest's). */
export function sliceAccess(manifest: LearnedManifest, sliceId: string): AccessModel | undefined {
  const slice = manifest.slices.find((s) => s.id === sliceId);
  if (!slice) return undefined;
  return slice.access ?? manifest.access.model;
}

/** Resolve a payload path strictly inside the bundle directory (no symlink escapes). */
function payloadPath(dir: string, file: string): string {
  const root = realpathSync(dir);
  const full = resolve(root, file);
  const rel = relative(root, full);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`path escapes bundle: ${file}`);
  const stat = lstatSync(full);
  if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file too large: ${file}`);
  return full;
}

/** Read one payload file after checking it against its manifest digest. */
export function readPayload(bundle: Bundle, file: string): Buffer {
  const digest = bundle.manifest.files[file];
  if (!digest) throw new Error(`file not in manifest: ${file}`);
  const bytes = readFileSync(payloadPath(bundle.dir, file));
  if (sha256Hex(bytes) !== digest) throw new Error(`digest mismatch: ${file}`);
  return bytes;
}

/**
 * Open and fully verify a bundle directory: schema, structure, pinned-key
 * signature over the canonical manifest, and every file digest. Nothing is
 * imported here; a failure throws and is never downgraded to "unsigned".
 */
export function openBundle(dir: string, pinned: readonly PinnedKey[]): Bundle {
  const manifestText = readFileSync(join(dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as LearnedManifest;
  const signature = JSON.parse(
    readFileSync(join(dir, "signature.json"), "utf8"),
  ) as FederationSignature;
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`invalid manifest: ${problems.join("; ")}`);
  const verified = verifyPinned(manifest as unknown as Record<string, unknown>, signature, pinned);
  if (!verified.ok) throw new Error(`signature refused: ${verified.error}`);
  if (verified.keyId !== manifest.publisher.key_id)
    throw new Error("manifest publisher key id does not match the signing key");
  const bundle: Bundle = { dir, manifest, signature, manifestDigest: manifestDigest(manifest) };
  for (const file of Object.keys(manifest.files)) readPayload(bundle, file);
  return bundle;
}
