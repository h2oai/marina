// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Import a `marina.learned.v1` bundle — opt-in (`MARINA_UPSTREAM=on`), signed
 * by a PINNED publisher key, and never trusted locally until local outcomes
 * confirm it.
 *
 *   verify     signature against pinned keys, file digests, item hashes
 *              (`bundle.ts`); signed revocation lists; no downgrade (a lower
 *              generation than one already imported is refused); the
 *              export scans again. Any refusal is loud and audited.
 *   lessons    → `upstream:lessons:<domain>` spaces owned by `marina:upstream`,
 *              trust `imported`, the original `resolved_at` kept (the leakage
 *              rule applies unchanged), the publisher's score kept as
 *              `publisher_rank`. Never written into `lessons:*`.
 *   conventions→ `upstream:conventions`, trust `imported`.
 *   defaults   → `upstream_default_seeds`, ONLY for a slot with no local
 *              `benchmark_defaults` row; `resolveDefault` reads them below
 *              every local layer (`upstream-seed.ts`).
 *   evidence   → `evidence_priors`, weight PRIOR_WEIGHT and at most
 *              PRIOR_N_CAP items per cell; never `benchmark_runs`/`_items`.
 *   roles      → created under the `upstream.` prefix (traits too), create-only,
 *              never bound to an agent; changing one takes `role.edit`.
 *   world      → `upstream:worlds` (the data-only world document), trust `imported`.
 *   room_source→ `upstream:room-sources` as inert text flagged `world.code`:
 *              never compiled, registered or executed here.
 *
 * Access (`entitlement.ts`): an item is written only when it is in an `open`
 * slice, or in a `token`/`private` slice that the caller's entitlement grant
 * covers (`private` also accepts the operator's `own` grant, `token` never
 * does). `opts.slices` limits the import to those slices. A withheld or
 * unselected item is neither written nor retired.
 *
 * Items absent from a newer generation are retired locally; revoked ones are
 * retired with status `revoked`. Every action is an `upstream_events` row.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { importRoleBundle, type RoleBundle } from "../agent/role-bundle";
import { getErrorMessage } from "../engine/errors";
import { LESSONS_ACCOUNT } from "../learning/service";
import { lessonFromRecord } from "../learning/store";
import { residentMemoryOperation } from "../memory/resident-service";
import type { MarinaDB } from "../persistence/database";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import {
  REVOCATIONS_FILE,
  readRevocationsFile,
  type VerifiedBundle,
  verifyBundle,
  verifyRevocations,
} from "./bundle";
import { type EntitlementGrant, OWN_VERIFIER } from "./entitlement";
import {
  type ConventionItem,
  type DefaultItem,
  type EvidenceItem,
  type LearnedItem,
  type LessonItem,
  type Manifest,
  type RoleItem,
  type RoomSourceItem,
  type Slice,
  sha256Hex,
  type WorldItem,
} from "./format";
import { type BenchmarkTextIndex, Scanner, stringsOf } from "./scan";
import { type PinnedKey, pinnedPublisherKeys } from "./sign";
import { validateRoomSource, validateWorldDocument } from "./world";

export const UPSTREAM_ACCOUNT = "marina:upstream";
/** The trust value of every imported record: below local `trusted`, never promoted by import. */
export const IMPORTED_TRUST = "imported";
/** Down-weighting of imported ledger aggregates. */
export const PRIOR_WEIGHT = 0.25;
/** At most this many items of an imported cell count as prior pseudo-counts. */
export const PRIOR_N_CAP = 50;
export const UPSTREAM_ROLE_PREFIX = "upstream.";
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export type UpstreamMode = "off" | "on";

/** `MARINA_UPSTREAM`: `off` (default) refuses every import; `on` allows operator imports. */
export function upstreamMode(env: NodeJS.ProcessEnv = process.env): UpstreamMode {
  const v = env.MARINA_UPSTREAM?.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1" ? "on" : "off";
}

export interface ImportOptions {
  pinned?: readonly PinnedKey[];
  /** Signed revocation lists (parsed JSON) besides one shipped in the bundle directory. */
  revocations?: readonly unknown[];
  benchmarkIndex?: BenchmarkTextIndex;
  /** Who ran the import (an operator label, recorded in the audit). */
  actor?: string;
  env?: NodeJS.ProcessEnv;
  /** Import only these slices (ids from `manifest.slices`). Absent: every slice. */
  slices?: readonly string[];
  /**
   * A grant from an entitlement verifier (`entitlement.ts`), or `ownBundleGrant`
   * for the operator's own private pack. Without one, only open items are written.
   */
  entitlement?: EntitlementGrant;
}

export interface ImportReport {
  artifactId: string;
  version: string;
  generation: number;
  added: number;
  changed: number;
  unchanged: number;
  retired: number;
  revoked: number;
  dropped: { item_key: string; reason: string }[];
  seeded: string[];
  skipped: { item_key: string; reason: string }[];
  priors: number;
  rolesCreated: string[];
  /** Items not written for lack of an entitlement covering them (never retired). */
  withheld: { item_key: string; reason: string }[];
}

export type ImportOutcome = { ok: true; report: ImportReport } | { ok: false; error: string };

type Run = (request: MemoryOperationRequest) => Promise<{ ok: true; result: unknown }>;

function upstreamRun(db: MarinaDB): Run {
  if (!db.getUserByName(UPSTREAM_ACCOUNT))
    db.createUser({ id: crypto.randomUUID(), name: UPSTREAM_ACCOUNT });
  return (request) =>
    residentMemoryOperation(db, UPSTREAM_ACCOUNT, request) as Promise<{
      ok: true;
      result: unknown;
    }>;
}

function spaceResolver(run: Run) {
  const cache = new Map<string, Promise<string>>();
  return (name: string) => {
    let p = cache.get(name);
    if (!p) {
      p = (async () => {
        const listed = (await run({ operation: "spaces" })).result as {
          spaces?: Array<{ id: string; name: string }>;
        };
        const found = listed.spaces?.find((s) => s.name === name)?.id;
        if (found) return found;
        const made = (await run({ operation: "create_space", input: { name } })).result as {
          id?: string;
        };
        if (!made.id) throw new Error(`could not create space ${name}`);
        return made.id;
      })();
      p.catch(() => cache.delete(name));
      cache.set(name, p);
    }
    return p;
  };
}

function recordId(result: unknown): string | undefined {
  const r = (result as { id?: unknown; record?: { id?: unknown } } | undefined) ?? {};
  return typeof r.id === "string"
    ? r.id
    : typeof r.record?.id === "string"
      ? r.record.id
      : undefined;
}

/** Close a record's validity (the `retire` shape lessons use); nothing is erased. */
async function retireRecord(run: Run, localRef: string, reason: string): Promise<void> {
  const [spaceId, id] = localRef.split("/");
  if (!spaceId || !id) return;
  const record = (await run({ operation: "get", space_id: spaceId, id })).result as {
    content?: string;
    version?: number;
    metadata?: Record<string, unknown>;
    valid_time?: { from: number | null; until: number | null } | null;
  };
  const until = record.valid_time?.until;
  if (typeof until === "number" && until <= Date.now()) return;
  if (typeof record.version !== "number" || typeof record.content !== "string") return;
  await run({
    operation: "revise",
    space_id: spaceId,
    id,
    key: `learned-retire:${id}:${record.version}`,
    input: {
      expected_version: record.version,
      content: record.content,
      metadata: {
        ...record.metadata,
        retired_reason: reason,
        retired_at: new Date().toISOString(),
        retired_by: UPSTREAM_ACCOUNT,
      },
      valid_time: { from: record.valid_time?.from ?? null, until: Date.now() },
    },
  });
}

function upstreamMetadata(b: VerifiedBundle, item: LearnedItem): Record<string, unknown> {
  const m = b.manifest;
  return {
    trust: IMPORTED_TRUST,
    source: `upstream:${m.artifact_id}@${m.version}`,
    item_key: item.item_key,
    content_hash: item.content_hash,
    artifact_id: m.artifact_id,
    artifact_version: m.version,
    generation: m.generation,
    publisher: m.publisher.name,
    publisher_key_id: m.publisher.key_id,
    license: item.license ?? m.license,
    ...(item.rank !== undefined ? { publisher_rank: item.rank } : {}),
    upstream_provenance: [
      ...(item.provenance ?? []),
      { producer: "import", origin: "local", imported_from: `${m.artifact_id}@${m.version}` },
    ],
  };
}

/** Can `grant` unlock `slice`? `open` always; `token` only by a verified grant naming it. */
function sliceUnlocked(slice: Slice, grant: EntitlementGrant | undefined): boolean {
  if (slice.open || slice.access === "open") return true;
  if (!grant) return false;
  if (slice.access === "private" && grant.verifier === OWN_VERIFIER) return true;
  return grant.verifier !== OWN_VERIFIER && grant.tiers.includes(slice.id);
}

/** Item keys this import may write, and why each other one is withheld. */
export function accessPlan(
  m: Manifest,
  itemKeys: readonly string[],
  opts: { slices?: readonly string[]; entitlement?: EntitlementGrant },
):
  | { ok: true; allowed: Set<string>; withheld: Map<string, string> }
  | { ok: false; error: string } {
  const slices = m.slices ?? [];
  const byId = new Map(slices.map((s) => [s.id, s]));
  const grant = opts.entitlement;
  let selected: Set<string>;
  if (opts.slices?.length) {
    selected = new Set();
    for (const id of opts.slices) {
      const slice = byId.get(id);
      if (!slice) return { ok: false, error: `no slice ${id} in ${m.artifact_id}@${m.version}` };
      if (!sliceUnlocked(slice, grant))
        return {
          ok: false,
          error: `slice ${id} is ${slice.access}: an entitlement covering it is required`,
        };
      for (const k of slice.item_keys) selected.add(k);
    }
  } else selected = new Set(itemKeys);
  const membership = new Map<string, Slice[]>();
  for (const slice of slices)
    for (const k of slice.item_keys) membership.set(k, [...(membership.get(k) ?? []), slice]);
  const allowed = new Set<string>();
  const withheld = new Map<string, string>();
  for (const key of itemKeys) {
    if (!selected.has(key)) continue;
    const of = membership.get(key);
    const unlocked = of?.length
      ? of.some((s) => sliceUnlocked(s, grant))
      : m.access?.model === "open" ||
        (m.access?.model === "private" && grant?.verifier === OWN_VERIFIER);
    if (unlocked) allowed.add(key);
    else withheld.set(key, "entitlement required");
  }
  return { ok: true, allowed, withheld };
}

/** Import a verified-on-the-spot bundle directory. Refusals change nothing but the audit. */
export async function importLearnedBundle(
  db: MarinaDB,
  dir: string,
  opts: ImportOptions = {},
): Promise<ImportOutcome> {
  const env = opts.env ?? process.env;
  if (upstreamMode(env) === "off") {
    return {
      ok: false,
      error: "imports are off: set MARINA_UPSTREAM=on to import learned bundles",
    };
  }
  const actor = opts.actor ?? "operator";
  const pinned = opts.pinned ?? pinnedPublisherKeys(env);
  const refuse = (error: string, extra: Record<string, unknown> = {}): ImportOutcome => {
    db.recordUpstreamEvent({
      action: "import",
      outcome: "refused",
      actor,
      detail: { error, ...extra },
    });
    return { ok: false, error };
  };
  const verified = verifyBundle(dir, pinned);
  if (!verified.ok) return refuse(verified.error);
  const b = verified.bundle;
  const m = b.manifest;
  const at = { artifactId: m.artifact_id, version: m.version, generation: m.generation, actor };

  // Revocations: every list must verify; only the artifact's own publisher may revoke it.
  const docs = [...(opts.revocations ?? [])];
  const shipped = join(dir, REVOCATIONS_FILE);
  if (existsSync(shipped)) {
    try {
      docs.push(readRevocationsFile(shipped));
    } catch (err) {
      return refuse(`unreadable ${REVOCATIONS_FILE}: ${getErrorMessage(err)}`);
    }
  }
  const revokedItems = new Map<string, string>();
  const revokedTokens = new Set<string>();
  for (const raw of docs) {
    const v = verifyRevocations(raw, pinned);
    if (!v.ok) return refuse(v.error);
    if (v.keyId !== m.publisher.key_id) continue;
    for (const e of v.revocations.entries) {
      if (e.artifact_id !== m.artifact_id) continue;
      if (e.entitlement_nonce) {
        revokedTokens.add(e.entitlement_nonce);
        continue;
      }
      if (e.item_key) revokedItems.set(e.item_key, e.reason);
      else if (!e.version || e.version === m.version) {
        return refuse(`${m.artifact_id}@${m.version} is revoked by its publisher: ${e.reason}`);
      }
    }
  }

  // Entitlement: a grant must be live and not revoked by the publisher; then the
  // access plan decides item by item. A paid item is never written without one.
  const grant = opts.entitlement;
  if (grant) {
    const expires = grant.expires_at ? Date.parse(grant.expires_at) : Number.POSITIVE_INFINITY;
    if (!(expires >= Date.now())) return refuse("the entitlement grant has expired");
    if (grant.nonce && revokedTokens.has(grant.nonce))
      return refuse("the entitlement token is revoked by its publisher");
  }
  const plan = accessPlan(
    m,
    b.items.map((i) => i.item_key),
    { ...(opts.slices ? { slices: opts.slices } : {}), ...(grant ? { entitlement: grant } : {}) },
  );
  if (!plan.ok) return refuse(plan.error, { slices: opts.slices ?? [] });
  if (plan.allowed.size === 0 && plan.withheld.size > 0)
    return refuse(
      `every selected item needs an entitlement (${plan.withheld.size} withheld; access ${m.access?.model ?? "private"})`,
    );
  if (grant) {
    db.recordUpstreamEvent({
      ...at,
      action: "entitlement",
      outcome: "ok",
      detail: {
        verifier: grant.verifier,
        licensee: grant.licensee,
        tiers: grant.tiers,
        ...(grant.nonce ? { nonce: sha256Hex(grant.nonce).slice(0, 16) } : {}),
      },
    });
  }

  const latest = db.latestLearnedArtifact(m.artifact_id);
  if (latest && m.generation < latest.generation) {
    return refuse(
      `downgrade refused: generation ${m.generation} (${m.version}) is older than imported generation ${latest.generation} (${latest.version})`,
    );
  }
  if (latest && m.generation === latest.generation && latest.manifest_digest !== b.digest) {
    return refuse(
      `generation ${m.generation} was already imported with different content (${latest.manifest_digest})`,
    );
  }

  const report: ImportReport = {
    artifactId: m.artifact_id,
    version: m.version,
    generation: m.generation,
    added: 0,
    changed: 0,
    unchanged: 0,
    retired: 0,
    revoked: 0,
    dropped: [],
    seeded: [],
    skipped: [],
    priors: 0,
    rolesCreated: [],
    withheld: [...plan.withheld].map(([item_key, reason]) => ({ item_key, reason })),
  };
  const scanner = new Scanner({
    ...(opts.benchmarkIndex ? { benchmarkIndex: opts.benchmarkIndex } : {}),
  });
  const run = upstreamRun(db);
  const spaceFor = spaceResolver(run);
  const present = new Set<string>();
  const carried = new Set(b.items.map((i) => i.item_key));

  for (const item of b.items) {
    // Unselected or withheld (no entitlement): not written, and not retired below.
    if (!plan.allowed.has(item.item_key)) continue;
    const prior = db.getLearnedItem(m.artifact_id, item.item_key);
    if (revokedItems.has(item.item_key)) {
      // Never applied; an earlier import of it is retired as `revoked` below.
      report.dropped.push({ item_key: item.item_key, reason: "revoked" });
      if (prior?.status !== "active") {
        db.recordUpstreamEvent({
          ...at,
          action: "item",
          outcome: "dropped",
          itemKey: item.item_key,
          detail: { reason: "revoked" },
        });
      }
      continue;
    }
    if (item.kind === "lesson" && (item as LessonItem).trust_at_source !== "trusted") {
      report.dropped.push({ item_key: item.item_key, reason: "not a served lesson" });
      db.recordUpstreamEvent({
        ...at,
        action: "item",
        outcome: "dropped",
        itemKey: item.item_key,
        detail: { reason: "trust_at_source" },
      });
      continue;
    }
    const { item_key: _k, content_hash: _h, provenance: _p, ...body } = item;
    const reason = scanner.scan(
      stringsOf(item.kind === "lesson" ? { ...body, refs: undefined } : body),
    );
    if (reason) {
      report.dropped.push({ item_key: item.item_key, reason });
      db.recordUpstreamEvent({
        ...at,
        action: "item",
        outcome: "dropped",
        itemKey: item.item_key,
        detail: { reason },
      });
      continue;
    }
    // Only an item that passed every check stays: a dropped one is retired below.
    present.add(item.item_key);
    if (prior && prior.status === "active" && prior.content_hash === item.content_hash) {
      report.unchanged++;
      continue;
    }
    try {
      const localRef = await applyItem(db, run, spaceFor, b, item, report);
      if (localRef === undefined) continue; // skipped (reason recorded)
      if (prior?.status === "active" && prior.local_ref && prior.local_ref !== localRef) {
        await retireOld(run, prior.kind, prior.local_ref, "superseded by a newer upstream version");
      }
      db.upsertLearnedItem({
        artifact_id: m.artifact_id,
        item_key: item.item_key,
        kind: item.kind,
        content_hash: item.content_hash,
        generation: m.generation,
        local_ref: localRef,
        status: "active",
      });
      const changed = prior !== undefined;
      if (changed) report.changed++;
      else report.added++;
      db.recordUpstreamEvent({
        ...at,
        action: changed ? "item_changed" : "item_added",
        outcome: "ok",
        itemKey: item.item_key,
        detail: { kind: item.kind, content_hash: item.content_hash },
      });
    } catch (err) {
      report.skipped.push({ item_key: item.item_key, reason: getErrorMessage(err) });
      db.recordUpstreamEvent({
        ...at,
        action: "item",
        outcome: "skipped",
        itemKey: item.item_key,
        detail: { reason: getErrorMessage(err) },
      });
    }
  }

  // Retire what this generation no longer carries, and what the publisher revoked.
  for (const row of db.listLearnedItems({ artifactId: m.artifact_id, status: "active" })) {
    const revoked = revokedItems.get(row.item_key);
    if (present.has(row.item_key) && revoked === undefined) continue;
    // An item still carried by the bundle but outside this import's selection or
    // entitlement is untouched: limiting an import never retires what it skips.
    if (revoked === undefined && carried.has(row.item_key) && !plan.allowed.has(row.item_key))
      continue;
    if (row.local_ref) {
      await retireOld(run, row.kind, row.local_ref, revoked ?? "retired upstream");
    }
    db.setLearnedItemStatus(
      m.artifact_id,
      row.item_key,
      revoked !== undefined ? "revoked" : "retired",
    );
    if (revoked !== undefined) report.revoked++;
    else report.retired++;
    db.recordUpstreamEvent({
      ...at,
      action: revoked !== undefined ? "item_revoked" : "item_retired",
      outcome: "ok",
      itemKey: row.item_key,
      ...(revoked !== undefined ? { detail: { reason: revoked } } : {}),
    });
  }

  if (!latest || latest.generation !== m.generation) {
    db.recordLearnedArtifact({
      artifact_id: m.artifact_id,
      generation: m.generation,
      version: m.version,
      manifest_digest: b.digest,
      publisher_key_id: m.publisher.key_id,
      license: m.license,
      access_model: m.access?.model ?? "private",
      manifest_json: JSON.stringify(m),
      actor,
    });
  }
  db.recordUpstreamEvent({
    ...at,
    action: "import",
    outcome: "ok",
    detail: {
      publisher: m.publisher.name,
      license: m.license,
      added: report.added,
      changed: report.changed,
      unchanged: report.unchanged,
      retired: report.retired,
      revoked: report.revoked,
      dropped: report.dropped.length,
      skipped: report.skipped.length,
      withheld: report.withheld.length,
      ...(opts.slices?.length ? { slices: opts.slices } : {}),
    },
  });
  return { ok: true, report };
}

async function retireOld(run: Run, kind: string, localRef: string, reason: string): Promise<void> {
  if (kind === "lesson" || kind === "convention" || kind === "world" || kind === "room_source")
    await retireRecord(run, localRef, reason);
  // Seeds, priors and roles need no action here: a seed or prior counts only
  // while its item is active (`latestUpstreamDefaultSeed`, `listEvidencePriors`),
  // and an upstream role stays until an operator deletes it.
}

/** Apply one item; returns its local reference, or undefined when it was skipped. */
async function applyItem(
  db: MarinaDB,
  run: Run,
  spaceFor: (name: string) => Promise<string>,
  b: VerifiedBundle,
  item: LearnedItem,
  report: ImportReport,
): Promise<string | undefined> {
  const m = b.manifest;
  const at = { artifactId: m.artifact_id, version: m.version, generation: m.generation };
  // Idempotency keys are ≤ 128 characters: a digest of what makes the write unique.
  const key = `learned:${sha256Hex(`${m.artifact_id}\u0000${item.item_key}\u0000${item.content_hash}`).slice(0, 48)}`;
  const skip = (reason: string) => {
    report.skipped.push({ item_key: item.item_key, reason });
    db.recordUpstreamEvent({
      ...at,
      action: "item",
      outcome: "skipped",
      itemKey: item.item_key,
      detail: { kind: item.kind, reason },
    });
    return undefined;
  };
  switch (item.kind) {
    case "lesson": {
      const l = item as LessonItem;
      const from = Date.parse(l.resolved_at);
      if (!Number.isFinite(from)) return skip("resolved_at is not a time");
      const spaceId = await spaceFor(`upstream:lessons:${l.domain}`);
      const reply = await run({
        operation: "remember",
        space_id: spaceId,
        key,
        input: {
          content: l.text,
          type: "inference",
          tier: "reflection",
          subject: "lesson",
          metadata: {
            kind: "lesson",
            domain: l.domain,
            lesson_kind: l.lesson_kind,
            resolved_at: l.resolved_at,
            ...(l.category ? { category: l.category } : {}),
            ...(l.rule ? { rule: l.rule } : {}),
            ...(l.judgement ? { judgement: l.judgement } : {}),
            ...(l.judge ? { judge: l.judge } : {}),
            ...(l.refs?.length ? { refs: l.refs } : {}),
            ...upstreamMetadata(b, item),
          },
          valid_time: { from, until: null },
        },
      });
      const id = recordId(reply.result);
      if (!id) throw new Error("the memory service returned no record id");
      return `${spaceId}/${id}`;
    }
    case "convention": {
      const c = item as ConventionItem;
      const spaceId = await spaceFor("upstream:conventions");
      const reply = await run({
        operation: "remember",
        space_id: spaceId,
        key,
        input: {
          content: c.text,
          type: "inference",
          tier: "reflection",
          subject: "convention",
          metadata: { kind: "convention", pool: c.pool, ...upstreamMetadata(b, item) },
        },
      });
      const id = recordId(reply.result);
      if (!id) throw new Error("the memory service returned no record id");
      return `${spaceId}/${id}`;
    }
    case "default": {
      const d = item as DefaultItem;
      if (db.getBenchmarkDefault(d.slot)) return skip(`local slot ${d.slot} is set`);
      const id = db.recordUpstreamDefaultSeed({
        slot: d.slot,
        value_json: JSON.stringify(d.value),
        evidence_json: d.evidence ? JSON.stringify(d.evidence) : null,
        artifact_id: m.artifact_id,
        version: m.version,
        generation: m.generation,
        item_key: d.item_key,
      });
      report.seeded.push(d.slot);
      return `seed:${id}`;
    }
    case "evidence": {
      const e = item as EvidenceItem;
      if (
        !(
          Number.isInteger(e.n) &&
          Number.isInteger(e.successes) &&
          e.successes >= 0 &&
          e.successes <= e.n &&
          e.n > 0
        )
      )
        return skip("malformed counts");
      const priorN = Math.min(e.n, PRIOR_N_CAP) * PRIOR_WEIGHT;
      const id = db.recordEvidencePrior({
        artifact_id: m.artifact_id,
        version: m.version,
        generation: m.generation,
        item_key: e.item_key,
        descriptor: e.descriptor,
        family: e.family,
        benchmark: e.benchmark ?? null,
        n: e.n,
        successes: e.successes,
        weight: PRIOR_WEIGHT,
        prior_n: priorN,
        prior_successes: priorN * (e.successes / e.n),
      });
      report.priors++;
      return `prior:${id}`;
    }
    case "role": {
      const r = item as RoleItem;
      const renamed = prefixRole(r.role);
      if (typeof renamed === "string") return skip(renamed);
      if (db.getRole(renamed.role.name))
        return skip(
          `role ${renamed.role.name} exists — import only creates (changing it takes role.edit)`,
        );
      const result = importRoleBundle(db, renamed, UPSTREAM_ACCOUNT);
      if (!result.ok) return skip(result.reason);
      report.rolesCreated.push(result.role);
      db.recordUpstreamEvent({
        ...at,
        action: "role_created",
        outcome: "ok",
        itemKey: item.item_key,
        detail: { role: result.role, traits: result.traitsCreated },
      });
      return `role:${result.role}`;
    }
    case "world": {
      const w = item as WorldItem;
      const problems = validateWorldDocument(w.world);
      if (problems.length) return skip(problems.slice(0, 3).join("; "));
      const spaceId = await spaceFor("upstream:worlds");
      const reply = await run({
        operation: "remember",
        space_id: spaceId,
        key,
        input: {
          content: JSON.stringify(w.world),
          type: "inference",
          tier: "reflection",
          subject: "world",
          metadata: {
            kind: "world",
            world_name: w.world.name,
            rooms: w.world.rooms.length,
            ...upstreamMetadata(b, item),
          },
        },
      });
      const id = recordId(reply.result);
      if (!id) throw new Error("the memory service returned no record id");
      return `${spaceId}/${id}`;
    }
    case "room_source": {
      // Inert text for review. Nothing here parses, compiles, registers or runs it.
      const r = item as RoomSourceItem;
      const problems = validateRoomSource(r);
      if (problems.length) return skip(problems.join("; "));
      const spaceId = await spaceFor("upstream:room-sources");
      const reply = await run({
        operation: "remember",
        space_id: spaceId,
        key,
        input: {
          content: r.source,
          type: "inference",
          tier: "reflection",
          subject: "room_source",
          metadata: {
            kind: "room_source",
            room_id: r.room_id,
            language: r.language,
            requires_gate: "world.code",
            executable: false,
            ...upstreamMetadata(b, item),
          },
        },
      });
      const id = recordId(reply.result);
      if (!id) throw new Error("the memory service returned no record id");
      return `${spaceId}/${id}`;
    }
  }
}

/** The bundle under the `upstream.` prefix (role and traits), or why it cannot be. */
export function prefixRole(bundle: RoleBundle): RoleBundle | string {
  const p = (n: string) => (n.startsWith(UPSTREAM_ROLE_PREFIX) ? n : `${UPSTREAM_ROLE_PREFIX}${n}`);
  const out: RoleBundle = {
    v: 1,
    role: { ...bundle.role, name: p(bundle.role.name), traits: bundle.role.traits.map(p) },
    traits: bundle.traits.map((t) => ({ ...t, name: p(t.name) })),
  };
  for (const n of [out.role.name, ...out.traits.map((t) => t.name)]) {
    if (!ROLE_NAME.test(n)) return `name ${n} is not valid under the upstream. prefix`;
  }
  return out;
}

/**
 * Record that a LOCAL outcome confirmed an imported lesson. The confirming
 * lesson must be a current, `trusted` lesson written by this Marina's own
 * judged loop (a `lessons:*` space) that cites the imported item
 * (`upstream:<item_key>` in its refs). The imported record itself stays
 * `imported`: the trusted knowledge is the local lesson, and provenance
 * keeps `confirmed_locally_by`.
 */
export async function confirmImportedLesson(
  db: MarinaDB,
  input: { artifactId: string; itemKey: string; localLessonId: string; actor?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = db.getLearnedItem(input.artifactId, input.itemKey);
  if (row?.kind !== "lesson") return { ok: false, error: "no imported lesson with that key" };
  if (row.status !== "active") return { ok: false, error: `the imported lesson is ${row.status}` };
  const local = db
    .listOwnedSpaceRecords(LESSONS_ACCOUNT, "lessons:")
    .find((r) => r.id === input.localLessonId);
  if (!local) return { ok: false, error: "no current local lesson with that id" };
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(local.metadata) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "the local lesson has unreadable metadata" };
  }
  const lesson = lessonFromRecord({
    id: local.id,
    content: local.content,
    metadata,
    valid_time: { from: local.valid_from, until: null },
  });
  if (lesson?.trust !== "trusted")
    return { ok: false, error: "the confirming lesson is not a trusted local lesson" };
  if (!(lesson.refs ?? []).includes(`upstream:${input.itemKey}`))
    return { ok: false, error: `the confirming lesson does not cite upstream:${input.itemKey}` };
  if (!db.confirmLearnedItem(input.artifactId, input.itemKey, input.localLessonId))
    return { ok: false, error: "the imported lesson could not be marked confirmed" };
  if (row.local_ref) {
    const [spaceId, id] = row.local_ref.split("/");
    const run = upstreamRun(db);
    const record = (await run({ operation: "get", space_id: spaceId, id })).result as {
      content?: string;
      version?: number;
      metadata?: Record<string, unknown>;
      valid_time?: { from: number | null; until: number | null } | null;
    };
    if (typeof record.version === "number" && typeof record.content === "string") {
      await run({
        operation: "revise",
        space_id: spaceId,
        id,
        key: `learned-confirm:${id}:${record.version}`,
        input: {
          expected_version: record.version,
          content: record.content,
          metadata: { ...record.metadata, confirmed_locally_by: input.localLessonId },
          valid_time: record.valid_time ?? { from: null, until: null },
        },
      });
    }
  }
  db.recordUpstreamEvent({
    action: "confirmed",
    outcome: "ok",
    artifactId: input.artifactId,
    itemKey: input.itemKey,
    actor: input.actor ?? "outcome-loop",
    detail: { local_lesson: input.localLessonId },
  });
  return { ok: true };
}
