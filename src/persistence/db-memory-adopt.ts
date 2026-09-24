// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Adoption — the moment a helper's cited proposal becomes the requester's
 * knowledge — and ratification, its shared-space form.
 *
 * `adopt` reads an `answered` assistance job's proposal record and writes the
 * answer as a versioned record in a target space (default: the job's own
 * space). Record citations the caller can read become `depends_on` +
 * `dependency_versions`, source citations become `source_ids`, and the
 * proposal record itself is `metadata.derived_from`. Same-space only for the
 * pinned forms (dependencies and sources must belong to the target space); a
 * cross-space adoption keeps the full citation list in `metadata.citations`.
 *
 * Adopting INTO an *institutional* space (`memory_spaces.metadata.institutional`)
 * is a ratification: the caller must pass the `AdoptPolicy` (standing ≥
 * `INSTITUTIONAL_RATIFY_MIN_STANDING`, sovereign, or the ungated local
 * operator — decided in `src/memory/institutional.ts`, which also supplies the
 * owning system principal as the writer). The record carries
 * `metadata.ratified_by` so it answers "why is this shared?".
 *
 * Standing (all idempotent per `(helper, kind, ref)`):
 *   - `assistance_adopted` (1.0) → the helper(s), ref `assistance:<jobId>`.
 *     Delegated trees split it: root worker 0.6, every other distinct
 *     *answered* worker in the tree shares 0.4 evenly (`contributionShares`).
 *   - `assistance_abstained_confirmed` (0.25) → `confirm_abstention: true` on
 *     an abstained job (requester only; no record is written).
 *   - `assistance_superseded` (−0.5, same split) → `debitSuperseded(recordId)`
 *     when an adopted record loses a `resolve`; called from
 *     `MemoryService.resolve`.
 *
 * Idempotency: the same job adopted twice into the same space returns the
 * existing record (looked up by `metadata.adopted_from_job`, so it also finds
 * records written by the older `reflect adopt` path) regardless of key. */

import type { Database } from "bun:sqlite";
import { STANDING_AMOUNTS, type StandingKind } from "../agent/standing";
import { adoptInput, MemoryError } from "../memory/service-types";
import type { MemoryAnswer, MemoryCitation } from "../sdk/memory-answer";
import type {
  MemoryAdoptInput,
  MemoryAdoptResult,
  MemoryRatifiedBy,
  MemoryRecordInput,
  MemorySpace,
  MemoryStandingCredit,
} from "../sdk/memory-types";
import {
  authorizeMemorySpace,
  event,
  hydrateSpace,
  readMemoryRecord,
  rememberRecord,
  requireActor,
} from "./db-memory-service";
import type { MemoryActor } from "./db-principals";
import { appendStandingEvent, hasStandingEvent } from "./db-standing";

interface JobRow {
  id: string;
  space_id: string;
  requester_id: string;
  credential_id: string;
  worker_id: string;
  role: string;
  parent_id: string | null;
  root_id: string;
  state: string;
  result_record_id: string | null;
}

/** Who wrote a ratified record and why they were allowed to. Supplied by the
 * policy layer (`src/memory/institutional.ts`); the repository never decides
 * standing on its own. */
export interface AdoptPolicy {
  ratify(
    actor: MemoryActor,
    space: MemorySpace,
    rationale: string | undefined,
  ): { ratified_by: MemoryRatifiedBy; writer: MemoryActor };
}

export const ADOPTED_RECORD_TYPE = "episode";
export const ADOPTED_RECORD_TIER = "reflection";
export const ADOPTED_RECORD_IMPORTANCE = 8;

function fail(status: number, code: string, message: string): never {
  throw new MemoryError(status, code, message);
}

/** Per-helper share of one adoption credit for the tree the job belongs to. */
export function contributionShares(db: Database, job: JobRow): Map<string, number> {
  const root = (db.query("SELECT * FROM memory_assistance_jobs WHERE id=?").get(job.root_id) ??
    job) as JobRow;
  const others = (
    db
      .query(
        "SELECT DISTINCT worker_id FROM memory_assistance_jobs WHERE root_id=? AND id<>? AND state='answered' AND worker_id<>? ORDER BY worker_id",
      )
      .all(job.root_id, root.id, root.worker_id) as { worker_id: string }[]
  ).map((row) => row.worker_id);
  const shares = new Map<string, number>();
  if (others.length === 0) {
    shares.set(root.worker_id, 1);
    return shares;
  }
  shares.set(root.worker_id, 0.6);
  for (const worker of others) shares.set(worker, 0.4 / others.length);
  return shares;
}

function isSameSpaceCitation(citation: MemoryCitation, space: string) {
  return citation.space_id === space;
}

export function memoryAdoptRepository(db: Database) {
  const jobRow = (id: string): JobRow =>
    (db.query("SELECT * FROM memory_assistance_jobs WHERE id=?").get(id) as JobRow | null) ??
    fail(404, "assistance_not_found", "Assistance request not found");
  const spaceRow = (id: string): MemorySpace => {
    const row = db.query("SELECT * FROM memory_spaces WHERE id=?").get(id) as
      | (Omit<MemorySpace, "metadata"> & { metadata: string | null })
      | null;
    if (!row) fail(404, "space_not_found", "Memory space not found");
    const space = hydrateSpace(row);
    if (space.status === "forgotten")
      fail(410, "space_forgotten", "Memory space has been forgotten");
    return space;
  };
  const principalName = (id: string): string =>
    (
      db.query("SELECT display_name FROM principals WHERE principal_id=?").get(id) as {
        display_name: string;
      } | null
    )?.display_name ?? id;
  /** Owner-authority reader for the job's space (the requester's credential
   * that filed the job) — how a delegated worker sees the proposal. */
  const delegator = (job: JobRow): MemoryActor => ({
    principalId: job.requester_id,
    credentialId: job.credential_id,
    scopes: ["memory:read", "memory:write", "memory:share"],
  });
  /** Requester, worker, or parent worker may see the job at all. */
  function visible(actor: MemoryActor, job: JobRow): void {
    const parent = job.parent_id ? jobRow(job.parent_id) : undefined;
    if (![job.requester_id, job.worker_id, parent?.worker_id].includes(actor.principalId))
      fail(404, "assistance_not_found", "Assistance request not found");
  }
  function credit(
    kind: StandingKind,
    ref: string,
    shares: Map<string, number>,
  ): MemoryStandingCredit[] {
    const credited: MemoryStandingCredit[] = [];
    const base = STANDING_AMOUNTS[kind];
    for (const [principal, share] of shares) {
      if (hasStandingEvent(db, principal, kind, ref)) continue;
      const amount = Number((base * share).toFixed(4));
      if (amount === 0) continue;
      appendStandingEvent(db, {
        entityId: principal,
        entityName: principalName(principal),
        kind,
        ref,
        amount,
      });
      credited.push({ principal_id: principal, kind, ref, amount });
    }
    return credited;
  }
  function findAdoption(jobId: string, space: string) {
    return db
      .query(
        `SELECT r.id,r.version,r.metadata FROM memory_records r
         WHERE r.space_id=? AND r.status='active' AND json_extract(r.metadata,'$.adopted_from_job')=?
         ORDER BY r.created_at,r.id LIMIT 1`,
      )
      .get(space, jobId) as { id: string; version: number; metadata: string } | null;
  }
  function confirmAbstention(actor: MemoryActor, job: JobRow): MemoryAdoptResult {
    if (actor.principalId !== job.requester_id)
      fail(403, "assistance_owner_required", "Only the requester may confirm an abstention");
    if (job.state !== "abstained")
      fail(
        409,
        "assistance_not_abstained",
        `Job ${job.id} is ${job.state}; only an abstained job can have its abstention confirmed`,
      );
    const ref = `assistance:${job.id}:abstention`;
    const already = hasStandingEvent(db, job.worker_id, "assistance_abstained_confirmed", ref);
    const credited = credit("assistance_abstained_confirmed", ref, new Map([[job.worker_id, 1]]));
    if (!already) event(db, actor, job.space_id, "assistance.abstention_confirmed", job.id);
    return {
      id: job.result_record_id ?? job.id,
      job_id: job.id,
      space_id: job.space_id,
      state: "abstention_confirmed",
      existing: already,
      ratified_by: null,
      credited,
    };
  }
  function run(
    actor: MemoryActor,
    raw: unknown,
    key: string,
    policy?: AdoptPolicy,
  ): MemoryAdoptResult {
    requireActor(db, actor, "memory:write");
    const input: MemoryAdoptInput = adoptInput(raw);
    if (!key || key.length > 128)
      fail(400, "idempotency_required", "An Idempotency-Key of 1–128 characters is required");
    return db.transaction((): MemoryAdoptResult => {
      const job = jobRow(input.job_id);
      visible(actor, job);
      if (input.confirm_abstention) return confirmAbstention(actor, job);
      const targetId = input.target_space_id ?? job.space_id;
      const requester = actor.principalId === job.requester_id;
      if (!requester && targetId === job.space_id)
        fail(
          403,
          "assistance_owner_required",
          "Only the requester adopts into the job's own space; name a shared target_space_id you can write",
        );
      if (job.state !== "answered")
        fail(
          409,
          "assistance_not_adoptable",
          job.state === "abstained"
            ? `Job ${job.id} abstained; nothing to adopt (use confirm_abstention to credit the honest abstention)`
            : `Job ${job.id} is ${job.state}; only an answered job can be adopted`,
        );
      const target = spaceRow(targetId);
      const institutional = target.metadata.institutional === true;

      // Same job + same space ⇒ same record, whatever the key.
      const existing = findAdoption(job.id, targetId);
      if (existing) {
        const meta = JSON.parse(existing.metadata) as { ratified_by?: MemoryRatifiedBy };
        return {
          id: existing.id,
          version: existing.version,
          job_id: job.id,
          space_id: targetId,
          state: "adopted",
          existing: true,
          ratified_by: meta.ratified_by ?? null,
          credited: [],
        };
      }

      let writer = actor;
      let ratifiedBy: MemoryRatifiedBy | null = null;
      if (institutional) {
        if (!policy)
          fail(
            403,
            "ratification_required",
            "Adopting into an institutional space is a ratification; use the memory service (not the raw repository)",
          );
        const decision = policy.ratify(actor, target, input.rationale);
        writer = decision.writer;
        ratifiedBy = decision.ratified_by;
      } else {
        authorizeMemorySpace(db, actor, targetId, "memory:write");
      }

      // The proposal is read with owner authority in the job's space.
      if (!job.result_record_id)
        fail(409, "assistance_not_adoptable", "The job has no proposal record");
      const reader = requester ? actor : delegator(job);
      const proposal = readMemoryRecord(db, reader, job.space_id, job.result_record_id);
      if (proposal.freshness !== "current" || proposal.version !== 1)
        fail(
          409,
          "assistance_stale",
          "The proposal or its evidence changed; inspect the record directly or request a new review",
        );
      const result = JSON.parse(proposal.content) as MemoryAnswer;
      if (result.status !== "answered")
        fail(409, "assistance_not_adoptable", "The proposal did not answer");
      const answer =
        typeof result.answer === "string" ? result.answer : JSON.stringify(result.answer);
      if (!answer.trim())
        fail(409, "assistance_not_adoptable", "The proposal answered with empty content");

      // Citations become pinned provenance only where the caller can read them
      // AND they live in the target space; everything else stays descriptive
      // in metadata. Unreadable citations are dropped, never guessed.
      const sourceIds: string[] = [];
      const dependsOn: string[] = [];
      const dependencyVersions: Record<string, number> = {};
      const sameSpace = targetId === job.space_id;
      for (const citation of result.citations ?? []) {
        if (!isSameSpaceCitation(citation, job.space_id)) continue;
        try {
          if (citation.kind === "record") {
            if (dependsOn.includes(citation.id)) continue;
            const record = readMemoryRecord(db, actor, job.space_id, citation.id);
            if (record.freshness !== "current") continue;
            if (sameSpace) {
              dependsOn.push(citation.id);
              dependencyVersions[citation.id] = record.version;
            }
          } else {
            if (sourceIds.includes(citation.id)) continue;
            authorizeMemorySpace(db, actor, job.space_id);
            const present = db
              .query("SELECT 1 FROM memory_sources WHERE id=? AND space_id=?")
              .get(citation.id, job.space_id);
            if (present && sameSpace) sourceIds.push(citation.id);
          }
        } catch (error) {
          if (!(error instanceof MemoryError)) throw error;
        }
      }

      const record: MemoryRecordInput = {
        content: answer,
        type: ADOPTED_RECORD_TYPE,
        tier: ADOPTED_RECORD_TIER,
        importance: ADOPTED_RECORD_IMPORTANCE,
        metadata: {
          adopted_from_job: job.id,
          helper_id: job.worker_id,
          proposal_record_id: job.result_record_id,
          derived_from: [job.result_record_id],
          adopted_by: actor.principalId,
          role: job.role,
          source_space_id: job.space_id,
          citations: result.citations ?? [],
          ...(input.rationale ? { rationale: input.rationale } : {}),
          ...(ratifiedBy ? { ratified_by: ratifiedBy } : {}),
        },
        ...(sourceIds.length ? { source_ids: sourceIds } : {}),
        ...(dependsOn.length
          ? { depends_on: dependsOn, dependency_versions: dependencyVersions }
          : {}),
        ...(input.valid_time === undefined ? {} : { valid_time: input.valid_time }),
      };
      // A ratified write runs under the owning system principal; key it by job
      // so two ratifiers of the same job converge instead of conflicting.
      const receipt = rememberRecord(
        db,
        writer,
        targetId,
        record,
        writer === actor ? key : `adopt:${job.id}`,
      );
      const credited = credit(
        "assistance_adopted",
        `assistance:${job.id}`,
        contributionShares(db, job),
      );
      event(db, actor, job.space_id, "assistance.adopted", job.id, receipt.version);
      return {
        ...receipt,
        job_id: job.id,
        space_id: targetId,
        state: "adopted",
        existing: false,
        ratified_by: ratifiedBy,
        credited,
      };
    })();
  }
  return {
    run,
    /** Adoption already recorded for this job in this space, if any. */
    findAdoption,
    contributionShares: (jobId: string) => contributionShares(db, jobRow(jobId)),
    /** Debit the helpers of an adopted record that a `resolve` superseded.
     * Returns the credits written (empty when the record is not an adoption or
     * was already debited for this supersession). */
    debitSuperseded(recordId: string): MemoryStandingCredit[] {
      const row = db.query("SELECT metadata FROM memory_records WHERE id=?").get(recordId) as {
        metadata: string;
      } | null;
      if (!row) return [];
      const jobId = (JSON.parse(row.metadata) as { adopted_from_job?: unknown }).adopted_from_job;
      if (typeof jobId !== "string") return [];
      const job = db
        .query("SELECT * FROM memory_assistance_jobs WHERE id=?")
        .get(jobId) as JobRow | null;
      if (!job) return [];
      return credit(
        "assistance_superseded",
        `assistance:${jobId}:superseded:${recordId}`,
        contributionShares(db, job),
      );
    },
    /** The institutional space mirroring a pool, by pool name. */
    institutionalSpace(name: string): MemorySpace | undefined {
      const row = db
        .query(
          "SELECT * FROM memory_spaces WHERE name=? AND status='active' AND json_extract(metadata,'$.institutional')=1 ORDER BY created_at,id LIMIT 1",
        )
        .get(name) as (Omit<MemorySpace, "metadata"> & { metadata: string | null }) | null;
      return row ? hydrateSpace(row) : undefined;
    },
    /** Create the institutional space for a pool (idempotent by name). Only
     * seed/ratification code reaches this; HTTP `create_space` cannot set the
     * flags. */
    ensureInstitutionalSpace(owner: MemoryActor, name: string): MemorySpace {
      requireActor(db, owner, "memory:write");
      return db.transaction(() => {
        const existing = db
          .query(
            "SELECT * FROM memory_spaces WHERE name=? AND status='active' AND json_extract(metadata,'$.institutional')=1 ORDER BY created_at,id LIMIT 1",
          )
          .get(name) as (Omit<MemorySpace, "metadata"> & { metadata: string | null }) | null;
        if (existing) return hydrateSpace(existing);
        const id = crypto.randomUUID();
        db.run(
          "INSERT INTO memory_spaces(id,owner_id,name,created_at,metadata) VALUES (?,?,?,?,?)",
          [
            id,
            owner.principalId,
            name,
            Date.now(),
            JSON.stringify({ institutional: true, read_public: true, pool: name }),
          ],
        );
        event(db, owner, id, "space.created", id);
        return spaceRow(id);
      })();
    },
    /** Ratification lifts the proposal cap a shared-profile `pool add` applied. */
    setPoolNoteImportance(noteId: number, importance: number): boolean {
      return (
        db.run(
          "UPDATE notes SET importance=? WHERE id=? AND pool_id IS NOT NULL AND verification_status!='superseded'",
          [Math.max(1, Math.min(10, Math.round(importance))), noteId],
        ).changes > 0
      );
    },
  };
}
