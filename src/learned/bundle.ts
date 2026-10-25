// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading, writing and verifying a `marina.learned.v1` bundle directory.
 *
 * `verifyBundle` checks, in order, and refuses on the first failure:
 *   1. the manifest parses and names the v1 schema;
 *   2. the signature verifies against a PINNED publisher key (never the
 *      embedded one) and that key is the manifest's publisher;
 *   3. every file the manifest lists exists and matches its sha256, and no
 *      item file is present that the manifest does not list;
 *   4. every item line parses, sits in the file of its kind, and its
 *      `content_hash` recomputes;
 *   5. the contents stay inside the manifest (`manifestOverreach`): only
 *      format files, item counts as declared, an allow-list of known classes,
 *      every `excludes` entry declared, and no item field from an excluded
 *      layer (accounts, standing, grants, holds, secrets, journals, note ids).
 *
 * An UNSIGNED bundle (`manifest.unsigned`, no `signature.json`, written when
 * no publisher key is configured) passes step 2 only with `allowUnsigned`,
 * only under a `marina-memory:unsigned-…` artifact id, and is labelled
 * `UNSIGNED` (`publisherLabel`) wherever it is reported.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FederationSignature } from "../net/federation-crypto";
import { sha256Hex } from "../security/hash";
import {
  ALLOW_LIST_PREFIXES,
  BUNDLE_EXCLUDES,
  contentHash,
  type DiffEntry,
  EXCLUDED_ITEM_FIELDS,
  ITEM_FILES,
  ITEM_KINDS,
  LEARNED_SCHEMA,
  type LearnedItem,
  type Manifest,
  manifestDigest,
  REVOCATIONS_SCHEMA,
  type Revocations,
  UNSIGNED_ARTIFACT_PREFIX,
  UNSIGNED_KEY_ID,
} from "./format";
import { type PinnedKey, signLearned, verifyAgainstPinned } from "./sign";

export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "signature.json";
export const SPEC_FILE = "spec.json";
export const DIFF_FILE = "diff.jsonl";
export const REVOCATIONS_FILE = "revocations.json";

/** Largest file a bundle may carry (a guard against hostile input). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function jsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

function parseJsonl<T>(text: string, file: string): T[] {
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`${file}:${i + 1} is not JSON`);
    }
  }
  return out;
}

/**
 * Write files, digest them into the manifest, sign the manifest. With a null
 * key the bundle is written UNSIGNED: no `signature.json`, and the manifest
 * must say so (`unsigned: true`, publisher key id `unsigned`).
 */
export function writeBundle(
  dir: string,
  manifest: Omit<Manifest, "files">,
  files: Record<string, string>,
  signingKey: string | null,
): Manifest {
  if ((signingKey === null) !== (manifest.unsigned === true))
    throw new Error("an unsigned bundle needs `unsigned: true` and no signing key");
  mkdirSync(dir, { recursive: true });
  const digests: Record<string, string> = {};
  for (const [name, body] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    writeFileSync(join(dir, name), body);
    digests[name] = sha256Hex(body);
  }
  const full: Manifest = { ...manifest, files: digests };
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(full, null, 2)}\n`);
  if (signingKey !== null) {
    const signature = signLearned(full as unknown as Record<string, unknown>, signingKey);
    writeFileSync(join(dir, SIGNATURE_FILE), `${JSON.stringify(signature, null, 2)}\n`);
  }
  return full;
}

/** Field names under `value` (any depth) that belong to an excluded layer. */
function excludedFields(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) excludedFields(v, path, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (EXCLUDED_ITEM_FIELDS.has(k.toLowerCase())) out.push(`${path}.${k}`);
    excludedFields(v, `${path}.${k}`, out);
  }
}

/**
 * Why a bundle's contents reach beyond what its manifest allows, or undefined.
 * Pure; `verifyBundle` runs it on every bundle, signed or not.
 */
export function manifestOverreach(
  manifest: Manifest,
  items: readonly LearnedItem[],
): string | undefined {
  const known = new Set<string>([SPEC_FILE, DIFF_FILE, ...Object.values(ITEM_FILES)]);
  for (const name of Object.keys(manifest.files ?? {}))
    if (!known.has(name)) return `file ${name} is not part of the format`;
  if (manifest.excludes !== undefined) {
    if (!Array.isArray(manifest.excludes)) return "excludes must be a list";
    const declared = new Set(manifest.excludes);
    const missing = BUNDLE_EXCLUDES.filter((e) => !declared.has(e));
    if (missing.length) return `the manifest does not exclude ${missing.join(", ")}`;
  }
  for (const entry of manifest.export_policy?.allow_list ?? []) {
    const prefix = String(entry).split(":")[0] ?? "";
    if (!ALLOW_LIST_PREFIXES.has(prefix)) return `allow-list entry ${entry} is not a known class`;
  }
  if (manifest.counts) {
    for (const kind of ITEM_KINDS) {
      const n = items.filter((i) => i.kind === kind).length;
      const declared = manifest.counts[kind] ?? 0;
      if (n > declared) return `${n} ${kind} item(s) but the manifest declares ${declared}`;
    }
  }
  for (const item of items) {
    const found: string[] = [];
    excludedFields(item, item.item_key, found);
    if (found.length) return `${found[0]} belongs to an excluded layer`;
  }
  return undefined;
}

function readText(path: string): string {
  const data = readFileSync(path);
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`${path} exceeds ${MAX_FILE_BYTES} bytes`);
  return data.toString("utf8");
}

export interface VerifiedBundle {
  manifest: Manifest;
  digest: string;
  keyId: string;
  publisherLabel: string;
  items: LearnedItem[];
  diff: DiffEntry[];
}

export type VerifyOutcome = { ok: true; bundle: VerifiedBundle } | { ok: false; error: string };

/** The label every report shows for an unsigned bundle's publisher. */
export const UNSIGNED_LABEL = "UNSIGNED";

export interface VerifyOptions {
  /** Accept a bundle written with no publisher key (labelled `UNSIGNED`). */
  allowUnsigned?: boolean;
}

/** Verify a bundle directory against the pinned keys (see the module comment). */
export function verifyBundle(
  dir: string,
  pinned: readonly PinnedKey[],
  opts: VerifyOptions = {},
): VerifyOutcome {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readText(join(dir, MANIFEST_FILE))) as Manifest;
  } catch (err) {
    return { ok: false, error: `unreadable manifest or signature (${(err as Error).message})` };
  }
  if (manifest?.schema !== LEARNED_SCHEMA)
    return { ok: false, error: `not a ${LEARNED_SCHEMA} bundle` };
  let signer: { keyId: string; label: string };
  if (manifest.unsigned === true) {
    if (existsSync(join(dir, SIGNATURE_FILE)))
      return { ok: false, error: "a bundle marked unsigned must not carry a signature" };
    if (!opts.allowUnsigned)
      return {
        ok: false,
        error:
          "unsigned bundle: it has no publisher signature (import it only with --allow-unsigned)",
      };
    if (manifest.publisher?.key_id !== UNSIGNED_KEY_ID)
      return { ok: false, error: "an unsigned bundle must name publisher key `unsigned`" };
    if (
      typeof manifest.artifact_id !== "string" ||
      !manifest.artifact_id.startsWith(UNSIGNED_ARTIFACT_PREFIX)
    )
      return { ok: false, error: `an unsigned bundle's id must start ${UNSIGNED_ARTIFACT_PREFIX}` };
    signer = { keyId: UNSIGNED_KEY_ID, label: UNSIGNED_LABEL };
  } else {
    let signature: FederationSignature;
    try {
      signature = JSON.parse(readText(join(dir, SIGNATURE_FILE))) as FederationSignature;
    } catch (err) {
      return { ok: false, error: `unreadable manifest or signature (${(err as Error).message})` };
    }
    const v = verifyAgainstPinned(
      manifest as unknown as Record<string, unknown>,
      signature,
      pinned,
    );
    if (!v.ok) return { ok: false, error: `signature refused: ${v.error}` };
    if (manifest.publisher?.key_id !== v.keyId)
      return { ok: false, error: "the signing key is not the manifest's publisher key" };
    if (String(manifest.artifact_id).startsWith(UNSIGNED_ARTIFACT_PREFIX))
      return { ok: false, error: "a signed bundle cannot use the unsigned artifact namespace" };
    signer = { keyId: v.keyId, label: v.label };
  }
  if (!Number.isInteger(manifest.generation) || manifest.generation < 1)
    return { ok: false, error: "generation must be a positive integer" };
  const files = manifest.files ?? {};
  const contents = new Map<string, string>();
  for (const [name, digest] of Object.entries(files)) {
    if (name.includes("/") || name.includes("\\") || name.startsWith("."))
      return { ok: false, error: `illegal file name ${name}` };
    const path = join(dir, name);
    if (!existsSync(path)) return { ok: false, error: `missing file ${name}` };
    const body = readText(path);
    if (sha256Hex(body) !== digest) return { ok: false, error: `digest mismatch: ${name}` };
    contents.set(name, body);
  }
  for (const kind of ITEM_KINDS) {
    const file = ITEM_FILES[kind];
    if (existsSync(join(dir, file)) && !(file in files))
      return { ok: false, error: `unlisted item file ${file}` };
  }
  const items: LearnedItem[] = [];
  try {
    for (const kind of ITEM_KINDS) {
      const body = contents.get(ITEM_FILES[kind]);
      if (body === undefined) continue;
      for (const item of parseJsonl<LearnedItem>(body, ITEM_FILES[kind])) {
        if (item.kind !== kind) throw new Error(`${ITEM_FILES[kind]} holds a ${item.kind} item`);
        if (typeof item.item_key !== "string" || !item.item_key.startsWith(`${kind}:`))
          throw new Error(`${ITEM_FILES[kind]} has an item without a ${kind}: key`);
        if (contentHash(item) !== item.content_hash)
          throw new Error(`content hash mismatch for ${item.item_key}`);
        items.push(item);
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const keys = new Set<string>();
  for (const i of items) {
    if (keys.has(i.item_key)) return { ok: false, error: `duplicate item key ${i.item_key}` };
    keys.add(i.item_key);
  }
  const overreach = manifestOverreach(manifest, items);
  if (overreach) return { ok: false, error: `contents overreach the manifest: ${overreach}` };
  let diff: DiffEntry[] = [];
  const diffBody = contents.get(DIFF_FILE);
  if (diffBody !== undefined) {
    try {
      diff = parseJsonl<DiffEntry>(diffBody, DIFF_FILE);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return {
    ok: true,
    bundle: {
      manifest,
      digest: manifestDigest(manifest),
      keyId: signer.keyId,
      publisherLabel: signer.label,
      items,
      diff,
    },
  };
}

// ─── Revocations ─────────────────────────────────────────────────────────────

export interface SignedRevocations extends Revocations {
  signature: FederationSignature;
}

export function signRevocations(doc: Revocations, signingKey: string): SignedRevocations {
  return { ...doc, signature: signLearned(doc as unknown as Record<string, unknown>, signingKey) };
}

export type RevocationsOutcome =
  | { ok: true; revocations: Revocations; keyId: string }
  | { ok: false; error: string };

/** Verify a revocation list against the pinned keys; its signer must be its stated publisher. */
export function verifyRevocations(raw: unknown, pinned: readonly PinnedKey[]): RevocationsOutcome {
  const doc = raw as Partial<SignedRevocations> | null;
  if (!doc || doc.schema !== REVOCATIONS_SCHEMA || !Array.isArray(doc.entries))
    return { ok: false, error: `not a ${REVOCATIONS_SCHEMA} document` };
  const { signature, ...unsigned } = doc as SignedRevocations;
  const v = verifyAgainstPinned(unsigned as unknown as Record<string, unknown>, signature, pinned);
  if (!v.ok) return { ok: false, error: `revocations signature refused: ${v.error}` };
  if (unsigned.publisher_key_id !== v.keyId)
    return { ok: false, error: "revocations signed by a key other than their publisher" };
  return { ok: true, revocations: unsigned as Revocations, keyId: v.keyId };
}

export function readRevocationsFile(path: string): unknown {
  return JSON.parse(readText(path)) as unknown;
}
