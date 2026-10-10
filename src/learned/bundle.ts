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
 *      `content_hash` recomputes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FederationSignature } from "../net/federation-crypto";
import {
  contentHash,
  type DiffEntry,
  ITEM_FILES,
  ITEM_KINDS,
  LEARNED_SCHEMA,
  type LearnedItem,
  type Manifest,
  manifestDigest,
  REVOCATIONS_SCHEMA,
  type Revocations,
  sha256Hex,
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

/** Write files, digest them into the manifest, sign the manifest. */
export function writeBundle(
  dir: string,
  manifest: Omit<Manifest, "files">,
  files: Record<string, string>,
  signingKey: string,
): Manifest {
  mkdirSync(dir, { recursive: true });
  const digests: Record<string, string> = {};
  for (const [name, body] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    writeFileSync(join(dir, name), body);
    digests[name] = sha256Hex(body);
  }
  const full: Manifest = { ...manifest, files: digests };
  const signature = signLearned(full as unknown as Record<string, unknown>, signingKey);
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(full, null, 2)}\n`);
  writeFileSync(join(dir, SIGNATURE_FILE), `${JSON.stringify(signature, null, 2)}\n`);
  return full;
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

/** Verify a bundle directory against the pinned keys (see the module comment). */
export function verifyBundle(dir: string, pinned: readonly PinnedKey[]): VerifyOutcome {
  let manifest: Manifest;
  let signature: FederationSignature;
  try {
    manifest = JSON.parse(readText(join(dir, MANIFEST_FILE))) as Manifest;
    signature = JSON.parse(readText(join(dir, SIGNATURE_FILE))) as FederationSignature;
  } catch (err) {
    return { ok: false, error: `unreadable manifest or signature (${(err as Error).message})` };
  }
  if (manifest?.schema !== LEARNED_SCHEMA)
    return { ok: false, error: `not a ${LEARNED_SCHEMA} bundle` };
  const v = verifyAgainstPinned(manifest as unknown as Record<string, unknown>, signature, pinned);
  if (!v.ok) return { ok: false, error: `signature refused: ${v.error}` };
  if (manifest.publisher?.key_id !== v.keyId)
    return { ok: false, error: "the signing key is not the manifest's publisher key" };
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
      keyId: v.keyId,
      publisherLabel: v.label,
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
