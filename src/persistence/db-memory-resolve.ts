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
 *                         sources wins (distinct content hashes, excluding
 *                         self-derived/twin sources); ties fall back to recency.
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

export function independentEvidenceCount(db: Database, record: MemoryRecord): number {
  if (!record.source_ids.length) return 0;
  const rows = db
    .query(
      `SELECT content_hash,session_id,body FROM memory_sources
       WHERE space_id=? AND id IN (SELECT value FROM json_each(?))`,
    )
    .all(record.space_id, JSON.stringify(record.source_ids)) as {
    content_hash: string;
    session_id: string | null;
    body: string;
  }[];
  const hashes = new Set<string>();
  for (const row of rows) {
    if (row.session_id === SELF_DERIVED_SESSION) continue;
    if (SELF_DERIVED_MARKERS.some((marker) => row.body.includes(marker))) continue;
    if (row.body.includes(record.id)) continue;
    hashes.add(row.content_hash);
  }
  return hashes.size;
}

/** Most recently revised first; deterministic on ties. */
export function byRecency(a: MemoryRecord, b: MemoryRecord): number {
  return b.created_at - a.created_at || b.version - a.version || a.id.localeCompare(b.id);
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
        let ordered = [...set].sort(byRecency);
        if (input.policy === "evidence_weighted") {
          const counts = Object.fromEntries(
            set.map((record) => [record.id, independentEvidenceCount(db, record)]),
          );
          result.evidence_counts = counts;
          ordered = ordered.sort((a, b) => counts[b.id]! - counts[a.id]! || byRecency(a, b));
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
