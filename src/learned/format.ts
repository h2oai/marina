// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina.learned.v1` — the signed bundle of what a Marina learned
 * (docs/guides/learned-bundles.md). This module is pure: the envelope and item
 * types, stable item keys, content hashes, semver and the diff between two
 * versions. Export, import, signing and scanning live beside it.
 *
 * A bundle is a directory:
 *
 *   manifest.json     identity, version + generation, parent + lineage,
 *                     publisher, licence and terms, access, slices, counts,
 *                     the sha256 of every other file
 *   signature.json    Ed25519 over the canonical manifest (federation-crypto)
 *   spec.json         the spec sheet (counts, ranks, confirmations, evidence)
 *   diff.jsonl        per item_key: added / changed / retired / re-ranked
 *   lessons.jsonl     served (trusted) lessons and meta-lessons
 *   conventions.jsonl ratified institutional records
 *   defaults.jsonl    promoted defaults with evidence summaries
 *   evidence.jsonl    ledger aggregates, cells of at least K_MIN items only
 *   roles.jsonl       adopted roles (RoleBundle v1)
 *   world.jsonl       the data-only world document (content profile `marina.world.v1`)
 *   room-sources.jsonl room source as inert text: never compiled on import;
 *                     installing it is the `world.code`-gated path
 *
 * A revocation list (`revocations.json`, schema REVOCATIONS_SCHEMA) is a
 * separately signed document, shipped beside a bundle or on its own.
 */

import { createHash } from "node:crypto";
import type { RoleBundle } from "../agent/role-bundle";
import { canonicalFederationJson } from "../net/federation-crypto";

export const LEARNED_SCHEMA = "marina.learned.v1";
/** Content profile of a bundle that carries a whole world (`world` + `room_source` items). */
export const WORLD_PROFILE = "marina.world.v1";
export const SPEC_SCHEMA = "marina.learned.spec.v1";
export const REVOCATIONS_SCHEMA = "marina.learned.revocations.v1";

/** Smallest ledger cell (items) an aggregate may describe — k-anonymity. */
export const K_MIN = 20;
/** Rendered bytes of the `core` tier (small-model budget). */
export const CORE_TIER_BYTES = 8 * 1024;
/** Licence of an explicitly opened bundle or slice: knowledge content, attribution travels. */
export const OPEN_LICENSE = "CC-BY-4.0";

export const ITEM_FILES = {
  lesson: "lessons.jsonl",
  convention: "conventions.jsonl",
  default: "defaults.jsonl",
  evidence: "evidence.jsonl",
  role: "roles.jsonl",
  world: "world.jsonl",
  room_source: "room-sources.jsonl",
} as const;

export type ItemKind = keyof typeof ITEM_FILES;
export const ITEM_KINDS = Object.keys(ITEM_FILES) as ItemKind[];
export type Tier = "core" | "standard" | "full";
export const TIERS: readonly Tier[] = ["core", "standard", "full"];
export type Profile = "internal" | "public";

/** One hop of a record's provenance chain. Never a human name: roles only. */
export interface ProvenanceHop {
  producer: "outcome" | "ledger" | "promotion" | "adoption" | "ratification" | "curator" | "import";
  /** Opaque instance id of the Marina that produced the hop. */
  origin: string;
  /** Hashed outcome references (bench runs, lessons) — never ids in clear. */
  outcome_refs?: string[];
  judge?: string;
  calibrated?: boolean;
  rank_method?: string;
  /** A role label (`ratifier`, `operator`), never a person. */
  ratified_by?: string;
  imported_from?: string;
  at?: string;
}

interface ItemBase {
  /** Stable identity across versions (an edit keeps it). */
  item_key: string;
  /** sha256 of this version's content (rank, tier and provenance excluded). */
  content_hash: string;
  kind: ItemKind;
  /** Domain slice the item belongs to (a lesson's domain, else the kind's plural). */
  domain: string;
  tier: Tier;
  /** The publisher's rank (lessons: the judge score), stored as `publisher_rank` on import. */
  rank?: number;
  /** Per-item licence override (contributed items). */
  license?: string;
  provenance: ProvenanceHop[];
}

export interface LessonItem extends ItemBase {
  kind: "lesson";
  text: string;
  lesson_kind: "success" | "failure";
  category?: string;
  rule?: string;
  trust_at_source: "trusted";
  judgement?: Record<string, number>;
  judge?: string;
  /** The outcome's time: the leakage rule (`visibleAt`) keeps applying with it. */
  resolved_at: string;
  refs?: string[];
  /** Producer label (`benchmark:<name>`), internal profile only. */
  source?: string;
}

export interface ConventionItem extends ItemBase {
  kind: "convention";
  pool: string;
  text: string;
  ratified: { basis: string; by: "ratifier" };
}

export interface DefaultEvidence {
  outcome: "seeded" | "promoted";
  split?: string;
  n?: number;
  delta?: number;
  low?: number;
  high?: number;
  replicates?: number;
  margin?: number;
  tried?: number;
  holdout_fraction?: number;
}

export interface DefaultItem extends ItemBase {
  kind: "default";
  slot: string;
  value: unknown;
  evidence: DefaultEvidence | null;
}

export interface EvidenceItem extends ItemBase {
  kind: "evidence";
  descriptor: string;
  family: string;
  /** Present in `internal` packs only; `public` packs are family-level. */
  benchmark?: string;
  n: number;
  successes: number;
  rate: number;
  wilson_low: number;
  runs: number;
  replicate_groups: number;
  mean_cost_usd?: number;
}

export interface RoleItem extends ItemBase {
  kind: "role";
  role: RoleBundle;
}

/** One room of a world document: data only (text, exits, layout), never handlers. */
export interface WorldRoom {
  id: string;
  short: string;
  long?: string;
  exits?: Record<string, string>;
  grid?: { row: number; col: number };
}

/**
 * The data-only world document. It never carries a seed, lifecycle hook or
 * bootstrap command: `validateWorldDocument` (world.ts) refuses unknown keys.
 */
export interface WorldDocument {
  name: string;
  description: string;
  start_room: string;
  rooms: WorldRoom[];
  guide_notes?: Array<{ content: string; importance: number; type: string }>;
  quests?: Array<{ id: string; name: string; description: string }>;
}

export interface WorldItem extends ItemBase {
  kind: "world";
  world: WorldDocument;
}

/**
 * Room source as inert text. Import stores it for review and NEVER compiles,
 * registers or executes it; installing it is the existing `world.code`-gated
 * path, taken by someone who read it.
 */
export interface RoomSourceItem extends ItemBase {
  kind: "room_source";
  room_id: string;
  language: "typescript";
  source: string;
  requires_gate: "world.code";
}

export type LearnedItem =
  | LessonItem
  | ConventionItem
  | DefaultItem
  | EvidenceItem
  | RoleItem
  | WorldItem
  | RoomSourceItem;

export interface Publisher {
  name: string;
  key_id: string;
  public_key: string;
  url?: string;
}

/** A chain on which the publisher sells licences (verified by an optional chain adapter). */
export interface LicenceChain {
  family: string;
  chain_id: number | string;
  license_contract: string;
}

export interface Access {
  /**
   * `open`: importable by anyone with no check. `token`: paid, so every item
   * needs an entitlement grant. `private`: the publisher's own pack, so it
   * needs a grant or the importing operator's explicit `own` assertion
   * (`entitlement.ts`).
   */
  model: "open" | "token" | "private";
  /** Key ids (besides the publisher's) allowed to sign entitlements for this artifact. */
  entitlement_issuers: string[];
  audience: string | null;
  /** Chains on which on-chain licences are sold (an optional extension verifies them). */
  chains?: LicenceChain[];
  /** Reserved: an embedded entitlement (always null; grants are passed at import). */
  entitlement: null;
  /** Reserved: per-slice encryption with wrapped keys. */
  encryption: null;
}

export interface Slice {
  id: string;
  selector: { tiers?: Tier[]; domains?: string[] };
  item_keys: string[];
  /** sha256 over the sorted `item_key:content_hash` lines of the slice. */
  digest: string;
  open: boolean;
  license: string;
  access: Access["model"];
}

export interface ParentRef {
  version: string;
  generation: number;
  manifest_digest: string;
}

export interface Manifest {
  schema: typeof LEARNED_SCHEMA;
  /** Absent for a memory bundle; `marina.world.v1` for a world artifact. */
  content_profile?: typeof WORLD_PROFILE;
  artifact_id: string;
  name: string;
  description: string;
  version: string;
  generation: number;
  parent: ParentRef | null;
  /** Ancestors, oldest first. */
  lineage: ParentRef[];
  created_at: string;
  min_marina_version: string;
  /** Opaque id of the exporting instance. */
  origin: string;
  profile: Profile;
  publisher: Publisher;
  license: string;
  terms: { url: string | null; sha256: string | null };
  attribution_required: boolean;
  redistribution: "allowed" | "licensee-only" | "none";
  commercial_use: "allowed" | "licensed" | "none";
  access: Access;
  slices: Slice[];
  counts: Record<ItemKind, number>;
  export_policy: { allow_list: string[]; scans: string[]; k_min: number };
  /** sha256 hex of every other file in the bundle. */
  files: Record<string, string>;
}

export type DiffChange = "added" | "changed" | "retired" | "re-ranked";

export interface DiffEntry {
  item_key: string;
  kind: ItemKind;
  change: DiffChange;
  old_hash?: string;
  new_hash?: string;
  old_rank?: number;
  new_rank?: number;
  reason: string;
}

export interface RevocationEntry {
  artifact_id: string;
  /** Absent: every version of the artifact. */
  version?: string;
  /** Present: revokes one item, not the version. */
  item_key?: string;
  /** Present: revokes one entitlement token (its `nonce`), not content. */
  entitlement_nonce?: string;
  reason: string;
  severity: "advisory" | "retire" | "critical";
}

export interface Revocations {
  schema: typeof REVOCATIONS_SCHEMA;
  publisher_key_id: string;
  issued_at: string;
  entries: RevocationEntry[];
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Digest of a manifest as signed (the identity a child names as its parent). */
export function manifestDigest(manifest: Manifest): string {
  return `sha256:${sha256Hex(canonicalFederationJson(manifest))}`;
}

const NON_CONTENT = new Set(["item_key", "content_hash", "tier", "rank", "provenance", "license"]);

/** The content hash of an item: its substance only (rank, tier, provenance excluded). */
export function contentHash(item: Omit<LearnedItem, "content_hash"> | LearnedItem): string {
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!NON_CONTENT.has(k)) content[k] = v;
  return `sha256:${sha256Hex(canonicalFederationJson(content))}`;
}

/**
 * A stable, opaque key: `<kind>:<hash of salt + local identity>`. The salt is
 * the publisher key id, so the same record keeps its key across versions and
 * one publisher's keys reveal nothing about its local ids.
 */
export function itemKey(kind: ItemKind, salt: string, localIdentity: string): string {
  return `${kind}:${sha256Hex(`${salt}\u0000${kind}\u0000${localIdentity}`).slice(0, 32)}`;
}

/** Hash a reference (`bench:<runId>` → `bench:<hash>`), keeping its kind prefix. */
export function hashRef(salt: string, ref: string): string {
  const at = ref.indexOf(":");
  const kind =
    at > 0 && at <= 24 && /^[a-z][a-z0-9_-]*$/.test(ref.slice(0, at)) ? ref.slice(0, at) : "ref";
  return `${kind}:${sha256Hex(`${salt}\u0000${ref}`).slice(0, 24)}`;
}

/** Slice digest over its items. */
export function sliceDigest(
  items: readonly Pick<LearnedItem, "item_key" | "content_hash">[],
): string {
  const lines = items.map((i) => `${i.item_key}:${i.content_hash}`).sort();
  return `sha256:${sha256Hex(lines.join("\n"))}`;
}

// ─── Semver ──────────────────────────────────────────────────────────────────

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(v: string): [number, number, number] | undefined {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`not a semver version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  return 0;
}

/**
 * The next version after `parent`: major when the profile (scope) changed,
 * minor when items were added, patch for changes, re-ranks and retirements.
 */
export function nextVersion(
  parent: string,
  diff: readonly DiffEntry[],
  scopeChanged: boolean,
): string {
  const p = parseSemver(parent);
  if (!p) throw new Error(`parent version is not semver: ${parent}`);
  if (scopeChanged) return `${p[0] + 1}.0.0`;
  if (diff.some((d) => d.change === "added")) return `${p[0]}.${p[1] + 1}.0`;
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

/** What changed between two item sets, keyed by `item_key`. Deterministic order. */
export function diffItems(
  before: readonly LearnedItem[],
  after: readonly LearnedItem[],
): DiffEntry[] {
  const old = new Map(before.map((i) => [i.item_key, i]));
  const now = new Map(after.map((i) => [i.item_key, i]));
  const out: DiffEntry[] = [];
  for (const item of after) {
    const prior = old.get(item.item_key);
    if (!prior) {
      out.push({
        item_key: item.item_key,
        kind: item.kind,
        change: "added",
        new_hash: item.content_hash,
        ...(item.rank !== undefined ? { new_rank: item.rank } : {}),
        reason: "new item",
      });
    } else if (prior.content_hash !== item.content_hash) {
      out.push({
        item_key: item.item_key,
        kind: item.kind,
        change: "changed",
        old_hash: prior.content_hash,
        new_hash: item.content_hash,
        ...(prior.rank !== undefined ? { old_rank: prior.rank } : {}),
        ...(item.rank !== undefined ? { new_rank: item.rank } : {}),
        reason: "content changed",
      });
    } else if (prior.rank !== item.rank) {
      out.push({
        item_key: item.item_key,
        kind: item.kind,
        change: "re-ranked",
        old_hash: prior.content_hash,
        new_hash: item.content_hash,
        ...(prior.rank !== undefined ? { old_rank: prior.rank } : {}),
        ...(item.rank !== undefined ? { new_rank: item.rank } : {}),
        reason: "rank changed",
      });
    }
  }
  for (const item of before) {
    if (!now.has(item.item_key)) {
      out.push({
        item_key: item.item_key,
        kind: item.kind,
        change: "retired",
        old_hash: item.content_hash,
        reason: "no longer exported (retired, superseded or no longer passes export policy)",
      });
    }
  }
  const order: Record<DiffChange, number> = { added: 0, changed: 1, "re-ranked": 2, retired: 3 };
  return out.sort(
    (a, b) => order[a.change] - order[b.change] || a.item_key.localeCompare(b.item_key),
  );
}

/** A terse, human rendering of a diff (`learned diff`). */
export function renderDiff(entries: readonly DiffEntry[], from?: string, to?: string): string {
  const count = (c: DiffChange) => entries.filter((e) => e.change === c).length;
  const head = `${from && to ? `${from} → ${to}: ` : ""}${count("added")} added, ${count("changed")} changed, ${count("re-ranked")} re-ranked, ${count("retired")} retired`;
  const lines = entries.map((e) => {
    const rank =
      e.old_rank !== undefined || e.new_rank !== undefined
        ? ` rank ${e.old_rank ?? "-"}→${e.new_rank ?? "-"}`
        : "";
    return `${e.change.padEnd(9)} ${e.kind.padEnd(10)} ${e.item_key}${rank}`;
  });
  return [head, ...lines].join("\n");
}

/** Wilson lower bound (95%) of a success rate. */
export function wilsonLow(successes: number, n: number, z = 1.959963984540054): number {
  if (n <= 0 || successes <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return Math.max(0, centre - half);
}

export function proprietaryLicense(publisherName: string): string {
  const slug =
    publisherName.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "publisher";
  return `LicenseRef-${slug}-proprietary`;
}
