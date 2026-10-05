// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Export what this Marina learned as a signed `marina.learned.v1` bundle.
 *
 * ALLOW-LIST ONLY — nothing else is ever read for export:
 *   lessons      current records with trust `trusted` in the lessons account's
 *                `lessons:*` spaces (meta-lessons included); never unverified,
 *                rejected or retired ones; `public` packs hold back `arena`
 *   conventions  current ratified records in institutional spaces
 *   defaults     promoted benchmark defaults with a numeric evidence summary
 *                (never run ids in clear)
 *   evidence     ledger aggregates of completed runs, cells of ≥ K_MIN items;
 *                `public` packs only at the family level, declared families only
 *   roles        roles adopted through `world adopt` (RoleBundle v1)
 *
 * Never: private, process or core memory, `memory kv`, pool notes, transcripts,
 * traces, answer hashes, item-level outcomes, human names, secrets.
 *
 * Every candidate item is then scanned (`scan.ts`); a failing item is DROPPED,
 * never redacted, and only its key, kind and reason are reported.
 */

import { hostname } from "node:os";
import { decodeRoleBundle, exportRoleBundle } from "../agent/role-bundle";
import { getPromotedDefault } from "../engine/benchmark-promotion";
import { LESSONS_ACCOUNT } from "../learning/service";
import { lessonFromRecord } from "../learning/store";
import { publicKeyOfSigningKey } from "../net/federation-crypto";
import type { MarinaDB } from "../persistence/database";
import { adoptionLog } from "../world/adoption";
import { DIFF_FILE, jsonl, SPEC_FILE, verifyBundle, writeBundle } from "./bundle";
import {
  type Access,
  CORE_TIER_BYTES,
  type ConventionItem,
  compareSemver,
  contentHash,
  type DefaultEvidence,
  type DefaultItem,
  type DiffEntry,
  diffItems,
  type EvidenceItem,
  hashRef,
  ITEM_FILES,
  ITEM_KINDS,
  type ItemKind,
  itemKey,
  K_MIN,
  LEARNED_SCHEMA,
  type LearnedItem,
  type LessonItem,
  type Manifest,
  nextVersion,
  OPEN_LICENSE,
  type ParentRef,
  type Profile,
  parseSemver,
  proprietaryLicense,
  type RoleItem,
  type Slice,
  sha256Hex,
  sliceDigest,
  type Tier,
  wilsonLow,
} from "./format";
import { type BenchmarkTextIndex, Scanner, type ScanReason, stringsOf } from "./scan";
import { buildSpec, type SpecSheet } from "./spec";

export const ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ExportOptions {
  outDir: string;
  name: string;
  description?: string;
  /** Explicit semver; default 1.0.0, or the next version after the parent. */
  version?: string;
  profile?: Profile;
  publisher: { name: string; url?: string };
  /** The dedicated Ed25519 key (MARINA_LEARNED_SIGNING_KEY), base64 PKCS#8 or PEM. */
  signingKey: string;
  /** The previous version's directory: generation, parent, lineage and diff follow from it. */
  parentDir?: string;
  /** Open the whole bundle (CC-BY-4.0, redistribution and commercial use allowed). */
  open?: boolean;
  /** Open only these slices (e.g. `tier:core`); the rest stays proprietary. */
  openSlices?: readonly string[];
  terms?: { url?: string | null; sha256?: string | null };
  benchmarkIndex?: BenchmarkTextIndex;
  /** Literal identifiers of this instance; host name and MARINA_NAME are always added. */
  instanceTokens?: readonly string[];
  /** family → benchmarks, for evidence aggregation (public packs need a declared family). */
  families?: Record<string, readonly string[]>;
  marinaVersion: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DroppedItem {
  item_key: string;
  kind: ItemKind;
  reason: ScanReason | "below-k" | "no-family";
}

export interface ExportResult {
  manifest: Manifest;
  items: LearnedItem[];
  dropped: DroppedItem[];
  diff: DiffEntry[];
  spec: SpecSheet;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A run target as a descriptor (`model:<id>`, `crew:<name>/<formation>`), or undefined. */
export function targetDescriptor(
  kind: string | null,
  targetJson: string | null,
): string | undefined {
  const t = parseJson(targetJson);
  let name: string | undefined;
  if (typeof t === "string") name = t;
  else if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    const base = o.model ?? o.crew ?? o.name;
    if (typeof base === "string")
      name = typeof o.formation === "string" ? `${base}/${o.formation}` : base;
  }
  if (!name) return undefined;
  return `${kind ?? "target"}:${name}`;
}

const NUMERIC_EVIDENCE: readonly (keyof DefaultEvidence)[] = [
  "n",
  "delta",
  "low",
  "high",
  "replicates",
  "margin",
];

function defaultEvidence(db: MarinaDB, slot: string, holdout: number): DefaultEvidence | null {
  const rows = db.listBenchmarkPromotions(slot).filter((r) => r.outcome !== "refused");
  const last = rows.at(-1);
  if (!last || last.outcome === "refused") return null;
  const out: DefaultEvidence = { outcome: last.outcome, holdout_fraction: holdout };
  const stats = parseJson(last.stats_json) as Record<string, unknown> | undefined;
  if (stats) {
    for (const k of NUMERIC_EVIDENCE) {
      const v = stats[k];
      if (typeof v === "number" && Number.isFinite(v))
        (out as unknown as Record<string, number>)[k] = v;
    }
    if (typeof stats.triedBefore === "number") out.tried = stats.triedBefore;
    if (stats.split === "holdout" || stats.split === "selection") out.split = stats.split;
  }
  return out;
}

function withHash<T extends LearnedItem>(item: Omit<T, "content_hash">): T {
  return { ...item, content_hash: contentHash(item as unknown as LearnedItem) } as T;
}

/** Rendered size of an item for tier budgeting. */
function renderedBytes(item: LearnedItem): number {
  if (item.kind === "lesson" || item.kind === "convention") return Buffer.byteLength(item.text);
  if (item.kind === "default")
    return Buffer.byteLength(`${item.slot}=${JSON.stringify(item.value)}`);
  return Buffer.byteLength(JSON.stringify(item));
}

/** core: defaults, then the best-ranked lessons and conventions within CORE_TIER_BYTES. */
function assignTiers(items: LearnedItem[]): void {
  let used = 0;
  const fits = (i: LearnedItem) => {
    const b = renderedBytes(i);
    if (used + b > CORE_TIER_BYTES) return false;
    used += b;
    return true;
  };
  for (const i of items) i.tier = i.kind === "role" ? "full" : "standard";
  for (const i of items.filter((x) => x.kind === "default")) if (fits(i)) i.tier = "core";
  const ranked = items
    .filter((x) => x.kind === "lesson" || x.kind === "convention")
    .sort((a, b) => (b.rank ?? 0.5) - (a.rank ?? 0.5) || a.item_key.localeCompare(b.item_key));
  for (const i of ranked) if (fits(i)) i.tier = "core";
}

function buildSlices(
  items: readonly LearnedItem[],
  license: string,
  access: Access["model"],
  open: boolean,
  openSlices: ReadonlySet<string>,
): Slice[] {
  const tierRank: Record<Tier, number> = { core: 0, standard: 1, full: 2 };
  const slice = (id: string, selector: Slice["selector"], members: LearnedItem[]): Slice => {
    const isOpen = open || openSlices.has(id);
    return {
      id,
      selector,
      item_keys: members.map((m) => m.item_key).sort(),
      digest: sliceDigest(members),
      open: isOpen,
      license: isOpen ? OPEN_LICENSE : license,
      access: isOpen ? "open" : access,
    };
  };
  const out: Slice[] = [];
  const tiers: Tier[] = ["core", "standard", "full"];
  tiers.forEach((t, rank) => {
    const upTo = tiers.slice(0, rank + 1);
    out.push(
      slice(
        `tier:${t}`,
        { tiers: upTo },
        items.filter((i) => tierRank[i.tier] <= rank),
      ),
    );
  });
  for (const d of [...new Set(items.map((i) => i.domain))].sort()) {
    out.push(
      slice(
        `domain:${d}`,
        { domains: [d] },
        items.filter((i) => i.domain === d),
      ),
    );
  }
  return out;
}

/** Collect, scan, tier and sign. Throws on an invalid request (bad name, version, parent). */
export function exportLearnedBundle(db: MarinaDB, opts: ExportOptions): ExportResult {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const profile: Profile = opts.profile ?? "internal";
  if (!ARTIFACT_NAME.test(opts.name))
    throw new Error("name must be lower-case letters, digits, '.', '_' or '-' (≤ 64)");
  if (!opts.publisher.name.trim()) throw new Error("a publisher name is required");
  const { publicKey, keyId } = publicKeyOfSigningKey(opts.signingKey);
  const salt = keyId;
  const artifactId = `marina-memory:${keyId.slice("sha256:".length, "sha256:".length + 16)}/${opts.name}`;
  const instanceName = env.MARINA_NAME?.trim() || "";
  const origin = `inst:${sha256Hex(`${salt}\u0000${instanceName}\u0000${hostname()}`).slice(0, 16)}`;
  const scanner = new Scanner({
    instanceTokens: [hostname(), instanceName, ...(opts.instanceTokens ?? [])].filter(Boolean),
    humanNames: db.listUsers().map((u) => u.name),
    ...(opts.benchmarkIndex ? { benchmarkIndex: opts.benchmarkIndex } : {}),
  });
  const dropped: DroppedItem[] = [];
  const candidates: LearnedItem[] = [];

  // ── lessons (served = trusted, current) ──
  for (const r of db.listOwnedSpaceRecords(LESSONS_ACCOUNT, "lessons:", now)) {
    const lesson = lessonFromRecord({
      id: r.id,
      content: r.content,
      metadata: (parseJson(r.metadata) as Record<string, unknown>) ?? {},
      valid_time: { from: r.valid_from, until: null },
    });
    if (lesson?.trust !== "trusted") continue;
    if (profile === "public" && lesson.domain === "arena") continue;
    const refs = (lesson.refs ?? []).map((ref) => hashRef(salt, ref));
    const calibrated = lesson.judge ? !/uncalibrated/i.test(lesson.judge) : undefined;
    candidates.push(
      withHash<LessonItem>({
        item_key: itemKey("lesson", salt, r.id),
        kind: "lesson",
        domain: lesson.domain,
        tier: "standard",
        ...(lesson.score !== undefined ? { rank: lesson.score } : {}),
        text: lesson.text,
        lesson_kind: lesson.kind,
        ...(lesson.category ? { category: lesson.category } : {}),
        ...(lesson.rule ? { rule: lesson.rule } : {}),
        trust_at_source: "trusted",
        ...(lesson.judgement ? { judgement: lesson.judgement } : {}),
        ...(lesson.judge ? { judge: lesson.judge } : {}),
        resolved_at: lesson.resolvedAt,
        ...(refs.length ? { refs } : {}),
        ...(profile === "internal" && lesson.source ? { source: lesson.source } : {}),
        provenance: [
          {
            producer: "outcome",
            origin,
            ...(refs.length ? { outcome_refs: refs } : {}),
            ...(lesson.judge ? { judge: lesson.judge } : {}),
            ...(calibrated !== undefined ? { calibrated } : {}),
            rank_method: "judge-score",
            at: lesson.resolvedAt,
          },
        ],
      }),
    );
  }

  // ── ratified conventions ──
  for (const r of db.listRatifiedInstitutionalRecords(now)) {
    const meta = (parseJson(r.metadata) as Record<string, unknown>) ?? {};
    const ratified = meta.ratified_by as { basis?: unknown } | undefined;
    candidates.push(
      withHash<ConventionItem>({
        item_key: itemKey("convention", salt, r.id),
        kind: "convention",
        domain: "conventions",
        tier: "standard",
        pool: r.space,
        text: r.content,
        ratified: {
          basis: typeof ratified?.basis === "string" ? ratified.basis : "standing",
          by: "ratifier",
        },
        provenance: [{ producer: "ratification", origin, ratified_by: "ratifier" }],
      }),
    );
  }

  // ── promoted defaults with evidence summaries ──
  for (const row of db.listBenchmarkDefaults()) {
    const value = getPromotedDefault(db, row.slot);
    if (value === undefined) continue; // invalidated incumbent or unreadable value
    const refs = row.incumbent_run_id ? [hashRef(salt, `bench:${row.incumbent_run_id}`)] : [];
    candidates.push(
      withHash<DefaultItem>({
        item_key: itemKey("default", salt, row.slot),
        kind: "default",
        domain: "defaults",
        tier: "standard",
        slot: row.slot,
        value,
        evidence: defaultEvidence(db, row.slot, row.holdout_fraction),
        provenance: [
          { producer: "promotion", origin, ...(refs.length ? { outcome_refs: refs } : {}) },
        ],
      }),
    );
  }

  // ── ledger aggregates, k-anonymous ──
  const familyOf = new Map<string, string>();
  for (const [family, benches] of Object.entries(opts.families ?? {}))
    for (const b of benches) if (!familyOf.has(b)) familyOf.set(b, family);
  const cells = new Map<
    string,
    {
      descriptor: string;
      family: string;
      benchmark?: string;
      n: number;
      successes: number;
      runs: number;
      groups: number;
      costItems: number;
      cost: number;
    }
  >();
  for (const c of db.listLedgerCells()) {
    const descriptor = targetDescriptor(c.target_kind, c.target_json);
    if (!descriptor) continue;
    const declared = familyOf.get(c.benchmark);
    if (profile === "public" && !declared) {
      dropped.push({
        item_key: itemKey("evidence", salt, `${descriptor}\u0000${c.benchmark}`),
        kind: "evidence",
        reason: "no-family",
      });
      continue;
    }
    const family = declared ?? c.benchmark;
    const benchmark = profile === "internal" ? c.benchmark : undefined;
    const key = `${descriptor}\u0000${family}\u0000${benchmark ?? ""}`;
    const cell = cells.get(key) ?? {
      descriptor,
      family,
      ...(benchmark ? { benchmark } : {}),
      n: 0,
      successes: 0,
      runs: 0,
      groups: 0,
      costItems: 0,
      cost: 0,
    };
    cell.n += c.n;
    cell.successes += c.successes;
    cell.runs += c.runs;
    cell.groups += c.replicate_groups;
    cell.costItems += c.cost_items;
    cell.cost += c.cost_usd ?? 0;
    cells.set(key, cell);
  }
  for (const [key, cell] of cells) {
    const k = itemKey("evidence", salt, key);
    if (cell.n < K_MIN) {
      dropped.push({ item_key: k, kind: "evidence", reason: "below-k" });
      continue;
    }
    candidates.push(
      withHash<EvidenceItem>({
        item_key: k,
        kind: "evidence",
        domain: "evidence",
        tier: "standard",
        descriptor: cell.descriptor,
        family: cell.family,
        ...(cell.benchmark ? { benchmark: cell.benchmark } : {}),
        n: cell.n,
        successes: cell.successes,
        rate: Math.round((cell.successes / cell.n) * 1e6) / 1e6,
        wilson_low: Math.round(wilsonLow(cell.successes, cell.n) * 1e6) / 1e6,
        runs: cell.runs,
        replicate_groups: cell.groups,
        ...(cell.costItems >= K_MIN
          ? { mean_cost_usd: Math.round((cell.cost / cell.costItems) * 1e8) / 1e8 }
          : {}),
        provenance: [{ producer: "ledger", origin }],
      }),
    );
  }

  // ── adopted roles ──
  const adopted = new Set<string>();
  for (const a of adoptionLog(db)) {
    if (a.status !== "applied") continue;
    const name = a.into ?? decodeRoleName(a.offer?.bundle);
    if (name) adopted.add(name);
  }
  for (const name of [...adopted].sort()) {
    const bundle = exportRoleBundle(db, name);
    if (!bundle) continue;
    candidates.push(
      withHash<RoleItem>({
        item_key: itemKey("role", salt, name),
        kind: "role",
        domain: "roles",
        tier: "full",
        role: bundle,
        provenance: [{ producer: "adoption", origin, ratified_by: "approver" }],
      }),
    );
  }

  // ── scans: drop, never redact ──
  const items: LearnedItem[] = [];
  for (const item of candidates) {
    const { item_key: _k, content_hash: _h, provenance: _p, ...body } = item;
    const texts = stringsOf(item.kind === "lesson" ? { ...body, refs: undefined } : body);
    const reason = scanner.scan(texts);
    if (reason) {
      dropped.push({ item_key: item.item_key, kind: item.kind, reason });
      continue;
    }
    items.push(item);
  }
  assignTiers(items);
  items.sort(
    (a, b) =>
      ITEM_KINDS.indexOf(a.kind) - ITEM_KINDS.indexOf(b.kind) ||
      a.item_key.localeCompare(b.item_key),
  );

  // ── lineage ──
  let parentRef: ParentRef | null = null;
  let lineage: ParentRef[] = [];
  let parentItems: LearnedItem[] = [];
  let parentProfile: Profile = profile;
  let generation = 1;
  let version = opts.version ?? "1.0.0";
  if (opts.version && !parseSemver(opts.version))
    throw new Error(`version is not semver: ${opts.version}`);
  if (opts.parentDir) {
    const own = [{ label: "self", publicKey, keyId }];
    const parent = verifyBundle(opts.parentDir, own);
    if (!parent.ok) throw new Error(`parent bundle refused: ${parent.error}`);
    const pm = parent.bundle.manifest;
    if (pm.artifact_id !== artifactId)
      throw new Error(
        `parent is ${pm.artifact_id}, not ${artifactId} (same key and name required)`,
      );
    parentRef = {
      version: pm.version,
      generation: pm.generation,
      manifest_digest: parent.bundle.digest,
    };
    lineage = [...(pm.lineage ?? []), parentRef];
    parentItems = parent.bundle.items;
    parentProfile = pm.profile;
    generation = pm.generation + 1;
  }
  const diff = diffItems(parentItems, items);
  if (opts.parentDir && parentRef) {
    const parentVersion = parentRef.version;
    version = opts.version ?? nextVersion(parentVersion, diff, parentProfile !== profile);
    if (compareSemver(version, parentVersion) <= 0)
      throw new Error(`version ${version} must be greater than the parent's ${parentVersion}`);
  }

  const open = opts.open === true;
  const license = open ? OPEN_LICENSE : proprietaryLicense(opts.publisher.name);
  const accessModel: Access["model"] = open ? "open" : "private";
  const openSlices = new Set(opts.openSlices ?? []);
  const slices = buildSlices(items, license, accessModel, open, openSlices);
  for (const id of openSlices)
    if (!slices.some((s) => s.id === id)) throw new Error(`no slice ${id} to open`);
  const counts = Object.fromEntries(
    ITEM_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length]),
  ) as Record<ItemKind, number>;

  const spec = buildSpec({
    db,
    artifactId,
    version,
    generation,
    items,
    dropped,
    considered: candidates.length,
    benchmarkIndex: opts.benchmarkIndex,
    minMarinaVersion: opts.marinaVersion,
    renderedBytes,
  });

  const manifest: Omit<Manifest, "files"> = {
    schema: LEARNED_SCHEMA,
    artifact_id: artifactId,
    name: opts.name,
    description: opts.description ?? "",
    version,
    generation,
    parent: parentRef,
    lineage,
    created_at: new Date(now).toISOString(),
    min_marina_version: opts.marinaVersion,
    origin,
    profile,
    publisher: {
      name: opts.publisher.name.trim(),
      key_id: keyId,
      public_key: publicKey,
      ...(opts.publisher.url ? { url: opts.publisher.url } : {}),
    },
    license,
    terms: { url: opts.terms?.url ?? null, sha256: opts.terms?.sha256 ?? null },
    attribution_required: true,
    redistribution: open ? "allowed" : "none",
    commercial_use: open ? "allowed" : "none",
    access: {
      model: accessModel,
      entitlement_issuers: [],
      audience: null,
      entitlement: null,
      encryption: null,
    },
    slices,
    counts,
    export_policy: {
      allow_list: [
        "lessons:trusted",
        "conventions:ratified",
        "defaults:promoted",
        `evidence:k>=${K_MIN}`,
        "roles:adopted",
      ],
      scans: [
        "secret",
        "instance",
        "human-name",
        ...(opts.benchmarkIndex ? ["benchmark-text"] : []),
      ],
      k_min: K_MIN,
    },
  };

  const files: Record<string, string> = {};
  for (const kind of ITEM_KINDS)
    files[ITEM_FILES[kind]] = jsonl(items.filter((i) => i.kind === kind));
  files[DIFF_FILE] = jsonl(diff);
  files[SPEC_FILE] = `${JSON.stringify(spec, null, 2)}\n`;
  const written = writeBundle(opts.outDir, manifest, files, opts.signingKey);
  return { manifest: written, items, dropped, diff, spec };
}

function decodeRoleName(bundle: string | undefined): string | undefined {
  if (!bundle) return undefined;
  const decoded = decodeRoleBundle(bundle);
  return "error" in decoded ? undefined : decoded.role.name;
}
