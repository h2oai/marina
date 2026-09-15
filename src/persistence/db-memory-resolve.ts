// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Contradiction resolution: typed write-time operators over the review queue.
 *
 * `review` reports competing assertions (same subject/predicate, different
 * objects, overlapping half-open validity) but never picks a winner. `resolve`
 * is the explicit, audited decision. Four policies (TOKI-style):
 *
 *  - last_writer_wins   — the most recently revised assertion stays current; the
 *                         others have `valid_time.until` closed at the winner's
 *                         `valid_from` (or now) through an ordinary revision.
 *  - evidence_weighted  — the assertion with the most *independent* supporting
 *                         evidence wins. Independence is counted over WRITERS,
 *                         not rows (Phase 3.6): distinct (content hash, author
 *                         principal) pairs, excluding self-derived/twin sources,
 *                         and excluding sources captured by the record's own
 *                         author whenever another author supports it. Each
 *                         ESTABLISHED writer (standing ≥ `SYBIL_STANDING_FLOOR`)
 *                         adds its civic reliability linearly
 *                         (`RELIABILITY_FLOOR + (1 - floor) * clamp(standing/100)`);
 *                         every LOW-standing writer contributes through one
 *                         shared, sublinear, bounded pool
 *                         (`min(SYBIL_POOL_CAP, RELIABILITY_FLOOR * sqrt(n))`),
 *                         so N fresh accounts corroborating one claim never
 *                         outweigh one established writer with an independent
 *                         source — for ANY N (the Sybil rule). Ties fall back
 *                         to raw pair count, then recency.
 *  - await_confirmation — nothing changes; the set is listed under review kind
 *                         `pending` until a later `resolve` or `reaffirm`.
 *  - keep_both          — the conflict is irreducible (TANGLE-style): every
 *                         member stays current and is annotated `qualified_by`;
 *                         review stops flagging the pair.
 *
 * Nothing is deleted. Losers keep their history and stay readable by id and
 * by `valid_at`; they are marked *superseded* in the review index. Every call
 * writes one append-only `memory_resolutions` row (who, when, policy, inputs,
 * outputs, rationale) and is idempotent per Idempotency-Key through `mutation`.
 * Authorization is the ordinary writer check; an assistance helper never
 * reaches this operator because the lease allows read operations only. */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { MemoryError, resolveInput } from "../memory/service-types";
import type {
  MemoryRecord,
  MemoryResolutionMembership,
  MemoryResolveResult,
  MemoryValidity,
} from "../sdk/memory-types";
import {
  principalStandingFromCache,
  REPUTATION_STANDING_CEILING,
  recordAuthors,
  sourceAuthors,
} from "./db-memory-ranking";
import {
  authorizeMemorySpace,
  event,
  hash,
  mutation,
  readCurrentMemoryRecords,
  reviseRecord,
} from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

/** Sources that mirror memory itself are provenance, not independent evidence:
 * legacy-note twins, assistance request envelopes and anything citing a
 * `marina-memory://` identity. */
const SELF_DERIVED_SESSION = "legacy-notes";
const SELF_DERIVED_MARKERS = ["marina-memory://", "marina.memory.assistance.request.v1"];

/**
 * Reliability floor for an independent writer with zero (or unknown)
 * standing. Kept strictly positive so a single genuine fresh account still
 * counts as evidence (one fresh writer = 0.05, well under one writer at
 * standing 40 = 0.05 + 0.95 * 0.40 = 0.43). Standing is read from the same
 * durable-principal rollup cache the shared-ranking term uses.
 */
export const RELIABILITY_FLOOR = 0.05;

/**
 * Sybil aggregation. Writers whose standing is below this floor (= below
 * rank 1, the same line `LOW_STANDING_WRITE_THRESHOLD` draws for shared-write
 * review) are "fresh": individually they are indistinguishable from throwaway
 * accounts, so they never add linearly. All fresh writers on one record share
 * ONE pool:
 *
 *     pool(n) = min(SYBIL_POOL_CAP, RELIABILITY_FLOOR * sqrt(n))
 *
 * sublinear (the 2nd fresh account is worth less than the 1st, the 100th
 * almost nothing) and bounded (10, 50 or 10 000 fresh accounts together are
 * worth at most 0.15 — less than a single writer at standing 11:
 * 0.05 + 0.95 * 0.11 = 0.1545). One fresh writer alone is unchanged (0.05).
 * Established writers (standing ≥ floor) still add `writerReliability`
 * linearly, so two established writers beat one:
 *
 *     weight = Σ_established writerReliability(standing) + pool(n_fresh)
 */
export const SYBIL_STANDING_FLOOR = 5;
export const SYBIL_POOL_CAP = 0.15;

export function writerReliability(standing: number): number {
  const unit = Math.min(1, Math.max(0, standing / REPUTATION_STANDING_CEILING));
  return RELIABILITY_FLOOR + (1 - RELIABILITY_FLOOR) * unit;
}

/** Pooled contribution of `n` fresh (below-floor) writers — see SYBIL_STANDING_FLOOR. */
export function sybilPoolWeight(n: number): number {
  if (n <= 0) return 0;
  return Math.min(SYBIL_POOL_CAP, RELIABILITY_FLOOR * Math.sqrt(n));
}

export interface IndependentEvidence {
  /** Distinct (content hash, author principal) pairs after every exclusion. */
  count: number;
  /** Σ established writer reliability + the fresh-writer pool (see SYBIL_STANDING_FLOOR). */
  weight: number;
  /** Independent authors (principal ids; `null` = author unknown) with their standing. */
  authors: { author: string | null; standing: number; pairs: number }[];
  /** Pairs dropped because the record's own author captured them while another author supports it. */
  self_excluded: number;
  /** Independent authors below SYBIL_STANDING_FLOOR — they share `sybil_pool`. */
  sybil_writers: number;
  /** The bounded pooled weight those fresh writers contributed together. */
  sybil_pool: number;
}

/**
 * Independent evidence for one record — writers, not rows. A source counts
 * only once per (hash, author); the record author's own captures are ignored
 * whenever at least one OTHER author supports the record (a writer cannot
 * corroborate itself against a peer); twins, assistance envelopes and any
 * body citing the record itself are provenance, never evidence.
 */
export function independentEvidence(db: Database, record: MemoryRecord): IndependentEvidence {
  const empty: IndependentEvidence = {
    count: 0,
    weight: 0,
    authors: [],
    self_excluded: 0,
    sybil_writers: 0,
    sybil_pool: 0,
  };
  if (!record.source_ids.length) return empty;
  const rows = db
    .query(
      `SELECT id,content_hash,session_id,body FROM memory_sources
       WHERE space_id=? AND id IN (SELECT value FROM json_each(?))`,
    )
    .all(record.space_id, JSON.stringify(record.source_ids)) as {
    id: string;
    content_hash: string;
    session_id: string | null;
    body: string;
  }[];
  const captured = sourceAuthors(
    db,
    rows.map((row) => row.id),
  );
  const recordAuthor = recordAuthors(db, [record.id]).get(record.id) ?? null;
  const pairs = new Map<string, { hash: string; author: string | null }>();
  for (const row of rows) {
    if (row.session_id === SELF_DERIVED_SESSION) continue;
    if (SELF_DERIVED_MARKERS.some((marker) => row.body.includes(marker))) continue;
    if (row.body.includes(record.id)) continue;
    const author = captured.get(row.id) ?? null;
    pairs.set(`${row.content_hash}\u0000${author ?? ""}`, { hash: row.content_hash, author });
  }
  const others = [...pairs.values()].filter((pair) => pair.author !== recordAuthor);
  const selfPairs = pairs.size - others.length;
  // Self-captured evidence stands only when nobody else vouches for the claim.
  const kept = others.length > 0 ? others : [...pairs.values()];
  const byAuthor = new Map<string | null, number>();
  for (const pair of kept) byAuthor.set(pair.author, (byAuthor.get(pair.author) ?? 0) + 1);
  const authors = [...byAuthor.entries()]
    .map(([author, count]) => ({
      author,
      standing: principalStandingFromCache(db, author),
      pairs: count,
    }))
    .sort((a, b) => (a.author ?? "").localeCompare(b.author ?? ""));
  // Established writers add linearly; fresh writers share one bounded pool.
  const established = authors.filter((entry) => entry.standing >= SYBIL_STANDING_FLOOR);
  const fresh = authors.length - established.length;
  const pool = sybilPoolWeight(fresh);
  return {
    count: kept.length,
    weight: established.reduce((sum, entry) => sum + writerReliability(entry.standing), 0) + pool,
    authors,
    self_excluded: others.length > 0 ? selfPairs : 0,
    sybil_writers: fresh,
    sybil_pool: pool,
  };
}

/** Backwards-compatible count — the independent (hash, author) pairs. */
export function independentEvidenceCount(db: Database, record: MemoryRecord): number {
  return independentEvidence(db, record).count;
}

/**
 * Most recently revised first. `created_at` is the CURRENT version's note
 * timestamp (millisecond resolution), so two writes in the same millisecond
 * tie; the tie is broken by write order — the current version's `notes.id`
 * (autoincrement, one row per remember/revise) — via `writeOrder`. Comparing
 * `version` on a tie was wrong (a twice-revised older record beat a fresh
 * newer one) and falling through to the UUID was random: both surfaced as
 * intermittent `last_writer_wins` failures under CI load.
 */
export function byRecency(
  a: MemoryRecord,
  b: MemoryRecord,
  writeOrder?: ReadonlyMap<string, number>,
): number {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  const seqA = writeOrder?.get(a.id);
  const seqB = writeOrder?.get(b.id);
  if (seqA !== undefined && seqB !== undefined && seqA !== seqB) return seqB - seqA;
  return a.id.localeCompare(b.id);
}

/** `record id → current version's notes.id` — the strict write order for a set of records. */
export function currentWriteOrder(
  db: Database,
  space: string,
  ids: readonly string[],
): Map<string, number> {
  if (ids.length === 0) return new Map();
  const rows = db
    .query(
      `SELECT id,current_note_id FROM memory_records
       WHERE space_id=? AND id IN (SELECT value FROM json_each(?))`,
    )
    .all(space, JSON.stringify(ids)) as { id: string; current_note_id: number | null }[];
  return new Map(
    rows.filter((r) => r.current_note_id !== null).map((r) => [r.id, r.current_note_id!]),
  );
}

/** Close a loser's interval at `cutoff` without ever extending it or producing
 * an empty interval. Returns undefined when it is already closed no later. */
export function closedValidity(
  current: MemoryValidity | null | undefined,
  cutoff: number,
): MemoryValidity | undefined {
  const from = current?.from ?? null;
  const until = current?.until ?? null;
  let close = cutoff;
  if (from !== null && from >= close) close = from + 1;
  if (until !== null && until <= close) return undefined;
  return { from, until: close };
}

/** Live membership shown by `review` — the newest non-retired row of an
 * applied or pending resolution. */
export function resolutionMembership(
  db: Database,
  record: string,
): MemoryResolutionMembership | undefined {
  const row = db
    .query(
      `SELECT x.id,x.policy,x.status,m.role,x.rationale,x.deadline,x.created_at
       FROM memory_resolution_members m JOIN memory_resolutions x ON x.id=m.resolution_id
       WHERE m.record_id=? AND m.retired_at IS NULL AND x.status IN ('applied','pending')
       ORDER BY x.created_at DESC,x.id DESC LIMIT 1`,
    )
    .get(record) as MemoryResolutionMembership | null;
  return row ?? undefined;
}

/** `reaffirm` on a pending member confirms the set: nothing else changes. */
export function confirmPendingResolutions(db: Database, space: string, record: string): number {
  return db.run(
    `UPDATE memory_resolutions SET status='confirmed',updated_at=? WHERE space_id=? AND status='pending'
     AND id IN (SELECT resolution_id FROM memory_resolution_members WHERE record_id=?)`,
    [Date.now(), space, record],
  ).changes;
}

export function resolveMemory(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  raw: unknown,
  key: string,
  model?: string,
): MemoryResolveResult {
  authorizeMemorySpace(db, actor, space, "memory:write");
  const input = resolveInput(raw);
  if (input.competing.includes(id))
    throw new MemoryError(400, "invalid_input", "competing must not repeat the target record");
  return mutation(db, actor, space, key, "memory.resolve", { id, input }, () => {
    const now = Date.now();
    const ids = [id, ...input.competing];
    const records = new Map(
      readCurrentMemoryRecords(db, actor, space, ids).map((record) => [record.id, record]),
    );
    const set = ids.map((member) => {
      const record = records.get(member);
      if (!record) throw new MemoryError(404, "memory_not_found", `Memory not found: ${member}`);
      return record;
    });
    const head = set[0]!;
    if (
      !head.claim ||
      set.some(
        (record) =>
          !record.claim ||
          record.claim.subject !== head.claim!.subject ||
          record.claim.predicate !== head.claim!.predicate,
      )
    )
      throw new MemoryError(
        409,
        "not_competing",
        "All records must assert the same subject and predicate",
      );
    const resolution = randomUUID();
    const subKey = (step: string, record: string) =>
      `res-${hash({ key, step, record }).slice(0, 48)}`;
    const memberIds = JSON.stringify(ids);
    // A newer decision governs: earlier pending sets over these records are
    // superseded and earlier index rows stop steering the review queue. The
    // ledger rows themselves stay untouched.
    db.run(
      `UPDATE memory_resolutions SET status='superseded',updated_at=? WHERE space_id=? AND status='pending'
       AND id IN (SELECT resolution_id FROM memory_resolution_members WHERE record_id IN (SELECT value FROM json_each(?)))`,
      [now, space, memberIds],
    );
    const result: MemoryResolveResult = {
      id: resolution,
      record_id: id,
      policy: input.policy,
      status: input.policy === "await_confirmation" ? "pending" : "applied",
      winner: null,
      superseded: [],
      peers: [],
      pending: [],
      evidence_counts: null,
      deadline: null,
    };
    const members: { record: string; role: MemoryResolutionMembership["role"] }[] = [];
    if (input.policy === "await_confirmation") {
      result.deadline = input.deadline_ms === undefined ? null : now + input.deadline_ms;
      result.pending = ids;
      for (const member of ids) members.push({ record: member, role: "pending" });
    } else {
      db.run(
        `UPDATE memory_resolution_members SET retired_at=? WHERE retired_at IS NULL
         AND record_id IN (SELECT value FROM json_each(?))
         AND resolution_id IN (SELECT id FROM memory_resolutions WHERE space_id=?)`,
        [now, memberIds, space],
      );
      const annotate = (record: MemoryRecord, field: string, value: unknown) =>
        reviseRecord(
          db,
          actor,
          space,
          record.id,
          record.version,
          { content: record.content, metadata: { ...record.metadata, [field]: value } },
          subKey(field, record.id),
          model,
        );
      if (input.policy === "keep_both") {
        result.peers = ids;
        for (const record of set) {
          annotate(record, "qualified_by", {
            resolution,
            records: ids.filter((member) => member !== record.id),
            rationale: input.rationale,
          });
          members.push({ record: record.id, role: "peer" });
        }
      } else {
        const writeOrder = currentWriteOrder(
          db,
          space,
          set.map((record) => record.id),
        );
        let ordered = [...set].sort((a, b) => byRecency(a, b, writeOrder));
        let evidence: Record<string, IndependentEvidence> | undefined;
        if (input.policy === "evidence_weighted") {
          evidence = Object.fromEntries(
            set.map((record) => [record.id, independentEvidence(db, record)]),
          );
          const found = evidence;
          result.evidence_counts = Object.fromEntries(
            set.map((record) => [record.id, found[record.id]!.count]),
          );
          // Reliability-weighted writers first; raw pair count breaks weight
          // ties (equal-standing writers), recency breaks the rest.
          ordered = ordered.sort(
            (a, b) =>
              found[b.id]!.weight - found[a.id]!.weight ||
              found[b.id]!.count - found[a.id]!.count ||
              byRecency(a, b, writeOrder),
          );
        }
        const winner = ordered[0]!;
        const losers = ordered.slice(1);
        const cutoff = input.valid_time?.from ?? winner.valid_time?.from ?? now;
        for (const loser of losers) {
          const closed = closedValidity(loser.valid_time, cutoff);
          const receipt = reviseRecord(
            db,
            actor,
            space,
            loser.id,
            loser.version,
            {
              content: loser.content,
              ...(closed ? { valid_time: closed } : {}),
              metadata: {
                ...loser.metadata,
                resolution: {
                  id: resolution,
                  policy: input.policy,
                  status: "superseded",
                  winner: winner.id,
                },
              },
            },
            subKey("close", loser.id),
            model,
          );
          result.superseded.push({
            id: loser.id,
            version: receipt.version ?? loser.version + 1,
            valid_time: closed ?? loser.valid_time ?? null,
          });
          members.push({ record: loser.id, role: "superseded" });
        }
        result.winner = winner.id;
        annotate(winner, "resolution", {
          id: resolution,
          policy: input.policy,
          status: "winner",
          competitors: losers.map((loser) => loser.id),
          ...(result.evidence_counts ? { evidence_counts: result.evidence_counts } : {}),
          ...(evidence
            ? {
                evidence_weights: Object.fromEntries(
                  Object.entries(evidence).map(([id, found]) => [
                    id,
                    {
                      weight: Number(found.weight.toFixed(4)),
                      independent_authors: found.authors.length,
                      self_excluded: found.self_excluded,
                      // Sybil aggregation: how many fresh writers were pooled
                      // and what the whole pool was worth (≤ sybil_pool_cap).
                      sybil_writers: found.sybil_writers,
                      sybil_pool: Number(found.sybil_pool.toFixed(4)),
                    },
                  ]),
                ),
                reliability_floor: RELIABILITY_FLOOR,
                // weight = Σ established writerReliability + min(cap, floor·√n_fresh)
                sybil_standing_floor: SYBIL_STANDING_FLOOR,
                sybil_pool_cap: SYBIL_POOL_CAP,
              }
            : {}),
        });
        members.push({ record: winner.id, role: "winner" });
      }
    }
    result.seq = event(db, actor, space, "memory.resolved", resolution);
    db.run(
      `INSERT INTO memory_resolutions(id,space_id,record_id,policy,status,actor_id,request_key,rationale,input,output,deadline,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        resolution,
        space,
        id,
        input.policy,
        result.status,
        actor.principalId,
        key,
        input.rationale,
        JSON.stringify({ id, ...input }),
        JSON.stringify(result),
        result.deadline,
        now,
        now,
      ],
    );
    for (const member of members)
      db.run("INSERT INTO memory_resolution_members(resolution_id,record_id,role) VALUES (?,?,?)", [
        resolution,
        member.record,
        member.role,
      ]);
    return result;
  });
}
