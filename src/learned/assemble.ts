// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Assemble and sign a `marina.learned.v1` bundle from items the caller already
 * holds: a world publisher (content profile `marina.world.v1`), a curated pack
 * built outside a Marina database, or a test fixture. It shares every format
 * rule with `exportLearnedBundle` (content hashes, slice digests, counts, file
 * digests, signature), so there is one format and one canonicaliser. It does
 * not collect, scan or tier: the caller owns its allow-list.
 */

import { publicKeyOfSigningKey } from "../net/federation-crypto";
import { DIFF_FILE, jsonl, SPEC_FILE, writeBundle } from "./bundle";
import {
  type Access,
  contentHash,
  ITEM_FILES,
  ITEM_KINDS,
  type ItemKind,
  K_MIN,
  LEARNED_SCHEMA,
  type LearnedItem,
  type Manifest,
  OPEN_LICENSE,
  type ParentRef,
  type Profile,
  parseSemver,
  proprietaryLicense,
  type Slice,
  sliceDigest,
  WORLD_PROFILE,
} from "./format";
import { validateRoomSource, validateWorldDocument } from "./world";

const ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** An item before hashing: everything but `content_hash`. */
export type UnhashedItem = LearnedItem extends infer T
  ? T extends LearnedItem
    ? Omit<T, "content_hash">
    : never
  : never;

export interface AssembleSlice {
  id: string;
  selector?: Slice["selector"];
  item_keys: string[];
  access: Access["model"];
  /** Default: OPEN_LICENSE for an open slice, else the bundle's licence. */
  license?: string;
}

export interface AssembleInput {
  outDir: string;
  signingKey: string;
  name: string;
  description?: string;
  version: string;
  generation: number;
  parent?: ParentRef | null;
  lineage?: ParentRef[];
  publisher: { name: string; url?: string };
  profile?: Profile;
  contentProfile?: typeof WORLD_PROFILE;
  /** Default: `LicenseRef-<publisher>-proprietary`. */
  license?: string;
  terms?: { url: string | null; sha256: string | null };
  redistribution?: Manifest["redistribution"];
  commercial_use?: Manifest["commercial_use"];
  access: Pick<Access, "model"> &
    Partial<Pick<Access, "entitlement_issuers" | "chains" | "audience">>;
  items: UnhashedItem[];
  slices: AssembleSlice[];
  /** Extra non-item files (flat names), e.g. a spec sheet. */
  spec?: unknown;
  minMarinaVersion: string;
  origin?: string;
  now?: number;
}

/** Hash, validate, slice, sign and write. Throws on any invalid input; writes nothing then. */
export function assembleBundle(input: AssembleInput): Manifest {
  if (!ARTIFACT_NAME.test(input.name)) throw new Error("name must match [a-z0-9][a-z0-9._-]{0,63}");
  if (!parseSemver(input.version)) throw new Error("version must be X.Y.Z");
  if (!Number.isInteger(input.generation) || input.generation < 1)
    throw new Error("generation must be a positive integer");
  const items: LearnedItem[] = input.items.map(
    (i) => ({ ...i, content_hash: contentHash(i as LearnedItem) }) as LearnedItem,
  );
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.item_key.startsWith(`${item.kind}:`))
      throw new Error(`item key ${item.item_key} must start with ${item.kind}:`);
    if (keys.has(item.item_key)) throw new Error(`duplicate item key ${item.item_key}`);
    keys.add(item.item_key);
    const problems =
      item.kind === "world"
        ? validateWorldDocument(item.world)
        : item.kind === "room_source"
          ? validateRoomSource(item)
          : [];
    if (problems.length) throw new Error(`${item.item_key}: ${problems.join("; ")}`);
  }
  const license = input.license ?? proprietaryLicense(input.publisher.name);
  const byKey = new Map(items.map((i) => [i.item_key, i]));
  const sliceIds = new Set<string>();
  const slices: Slice[] = input.slices.map((s) => {
    if (sliceIds.has(s.id)) throw new Error(`duplicate slice ${s.id}`);
    sliceIds.add(s.id);
    const members = s.item_keys.map((k) => {
      const item = byKey.get(k);
      if (!item) throw new Error(`slice ${s.id} names unknown item ${k}`);
      return item;
    });
    const open = s.access === "open";
    return {
      id: s.id,
      selector: s.selector ?? {},
      item_keys: [...s.item_keys].sort(),
      digest: sliceDigest(members),
      open,
      license: s.license ?? (open ? OPEN_LICENSE : license),
      access: s.access,
    };
  });
  const { publicKey, keyId } = publicKeyOfSigningKey(input.signingKey);
  const prefix = input.contentProfile === WORLD_PROFILE ? "marina-world" : "marina-memory";
  const counts = Object.fromEntries(
    ITEM_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length]),
  ) as Record<ItemKind, number>;
  const manifest: Omit<Manifest, "files"> = {
    schema: LEARNED_SCHEMA,
    ...(input.contentProfile ? { content_profile: input.contentProfile } : {}),
    artifact_id: `${prefix}:${keyId.slice("sha256:".length, "sha256:".length + 16)}/${input.name}`,
    name: input.name,
    description: input.description ?? "",
    version: input.version,
    generation: input.generation,
    parent: input.parent ?? null,
    lineage: input.lineage ?? (input.parent ? [input.parent] : []),
    created_at: new Date(input.now ?? Date.now()).toISOString(),
    min_marina_version: input.minMarinaVersion,
    origin: input.origin ?? "publisher",
    profile: input.profile ?? "public",
    publisher: {
      name: input.publisher.name.trim(),
      key_id: keyId,
      public_key: publicKey,
      ...(input.publisher.url ? { url: input.publisher.url } : {}),
    },
    license,
    terms: input.terms ?? { url: null, sha256: null },
    attribution_required: true,
    redistribution: input.redistribution ?? "none",
    commercial_use: input.commercial_use ?? "none",
    access: {
      model: input.access.model,
      entitlement_issuers: input.access.entitlement_issuers ?? [],
      audience: input.access.audience ?? null,
      ...(input.access.chains?.length ? { chains: input.access.chains } : {}),
      entitlement: null,
      encryption: null,
    },
    slices,
    counts,
    export_policy: { allow_list: ["publisher-curated"], scans: [], k_min: K_MIN },
  };
  const files: Record<string, string> = {};
  for (const kind of ITEM_KINDS) {
    const of = items.filter((i) => i.kind === kind);
    if (of.length) files[ITEM_FILES[kind]] = jsonl(of);
  }
  files[DIFF_FILE] = "";
  if (input.spec !== undefined) files[SPEC_FILE] = `${JSON.stringify(input.spec, null, 2)}\n`;
  return writeBundle(input.outDir, manifest, files, input.signingKey);
}
