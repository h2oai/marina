// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Institutional memory — the shared, standing-gated tier.
 *
 * A memory space is *institutional* when `memory_spaces.metadata.institutional`
 * is true (migration 114). Every institutional pool (`guide`,
 * `orchestration:<formation>`, `tradition:<name>`) gets one durable space,
 * owned by the `guide` system principal and marked `read_public` so every
 * active credential can read it without a grant. Writing INTO it is never a
 * plain write: it is a *ratification* — adoption of an assistance proposal
 * (`memory adopt <JOB> space <ID>`) or `pool <name> ratify <noteId>` — allowed
 * when the ratifier's standing (on their durable `users.id` key) is at least
 * `INSTITUTIONAL_RATIFY_MIN_STANDING`, or they are a sovereign (rank ≥ 9), or
 * this is the ungated local operator's own instance (`isLocalUngated()`).
 * Every ratified record carries `metadata.ratified_by` so it can answer
 * "why is this shared?" without a side ledger. Refusals name the exact
 * threshold and the caller's standing.
 *
 * Under a shared/public profile, `pool <institutional> add` becomes a
 * *proposal*: the legacy note is still written (nothing breaks) but its
 * importance is capped at `INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP` and it stays
 * `unverified` until ratified. Ratification lifts the cap, marks the note
 * `verified`, and mirrors it into the institutional space as a ratified record.
 *
 * Policy lives here (needs `MarinaDB`: standing cache, users, trust profile);
 * SQL lives in `src/persistence/db-memory-adopt.ts`.
 */

import { getStanding } from "../agent/standing";
import { isLocalUngated } from "../engine/trust-profile";
import type { MarinaDB, NoteRow } from "../persistence/database";
import type { AdoptPolicy } from "../persistence/db-memory-adopt";
import type { MemoryActor } from "../persistence/db-principals";
import type {
  MemoryRatifiedBy,
  MemoryReceipt,
  MemoryRecordInput,
  MemorySpace,
} from "../sdk/memory-types";
import { MemoryError } from "./service-types";

/** Standing needed to ratify into an institutional space (rank 2 threshold). */
export const INSTITUTIONAL_RATIFY_MIN_STANDING = 15;
/** Rank at and above which an account is a sovereign / operator. */
export const SOVEREIGN_RANK = 9;
/** `pool <institutional> add` importance ceiling under shared/public profiles. */
export const INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP = 4;
/** Importance a ratified pool note is lifted to when the ratifier names none. */
export const INSTITUTIONAL_RATIFIED_IMPORTANCE = 7;
/** Display name of the system principal that owns every institutional space. */
export const INSTITUTIONAL_OWNER_NAME = "guide";

/** Same shape as `isExportableInheritancePool` (engine/inheritance-bundle):
 * the pools whose notes are the Marina's shared institutional memory. */
export function isInstitutionalPoolName(name: string): boolean {
  return name === "guide" || name.startsWith("orchestration:") || name.startsWith("tradition:");
}

/** Proposal caps apply only where more than one person shares the instance;
 * the ungated local operator's `pool add` stays exactly as before. */
export function institutionalCapsApply(): boolean {
  return !isLocalUngated();
}

const owners = new WeakMap<MarinaDB, { actor: MemoryActor; expiresAt: number }>();

/** The `guide` system principal as a memory actor (credential cached per DB and
 * re-issued before expiry). It owns the institutional spaces and performs every
 * ratified write, so the record's author is the institution — the human or
 * agent who ratified is in `metadata.ratified_by`. */
export function institutionalOwnerActor(db: MarinaDB): MemoryActor {
  const cached = owners.get(db);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.actor;
  const principal = db.ensurePrincipal({ type: "system", displayName: INSTITUTIONAL_OWNER_NAME });
  const credential = db.issueMemoryCredential(principal.principal_id);
  const actor: MemoryActor = {
    principalId: principal.principal_id,
    credentialId: credential.credentialId,
    scopes: ["memory:read", "memory:write", "memory:share", "memory:export"],
  };
  owners.set(db, { actor, expiresAt: credential.expiresAt });
  return actor;
}

/** Idempotent: one institutional space per pool name. */
export function ensureInstitutionalSpace(db: MarinaDB, poolName: string): MemorySpace {
  const repo = db.memoryRepository().adopt;
  return (
    repo.institutionalSpace(poolName) ??
    repo.ensureInstitutionalSpace(institutionalOwnerActor(db), poolName)
  );
}

export function institutionalSpaceFor(db: MarinaDB, poolName: string): MemorySpace | undefined {
  return db.memoryRepository().adopt.institutionalSpace(poolName);
}

export type RatificationDecision =
  | { ok: true; basis: MemoryRatifiedBy["basis"]; standing: number; threshold: number }
  | { ok: false; reason: string; standing: number; threshold: number };

/** May this durable account ratify into an institutional space? `principalId`
 * is the durable key (`users.id` == the human principal id). `rank` defaults
 * to the account's stored rank. */
export function checkRatification(
  db: MarinaDB,
  principalId: string,
  opts: { rank?: number; now?: number } = {},
): RatificationDecision {
  const threshold = INSTITUTIONAL_RATIFY_MIN_STANDING;
  const standing = getStanding(db, principalId, opts.now);
  if (isLocalUngated()) return { ok: true, basis: "local-ungated", standing, threshold };
  const rank = opts.rank ?? db.getUser(principalId)?.rank ?? 0;
  if (rank >= SOVEREIGN_RANK) return { ok: true, basis: "sovereign", standing, threshold };
  if (standing >= threshold) return { ok: true, basis: "standing", standing, threshold };
  return {
    ok: false,
    standing,
    threshold,
    reason:
      `Ratifying into an institutional space requires standing ≥ ${threshold} (rank 2), ` +
      `a sovereign account, or the ungated local operator; your standing is ${standing.toFixed(1)}.`,
  };
}

function ratifiedBy(
  db: MarinaDB,
  principalId: string,
  decision: Extract<RatificationDecision, { ok: true }>,
  rationale: string | undefined,
): MemoryRatifiedBy {
  return {
    principal_id: principalId,
    name: db.getUser(principalId)?.name ?? principalId,
    standing: Number(decision.standing.toFixed(3)),
    at: Date.now(),
    rationale: rationale ?? null,
    basis: decision.basis,
  };
}

/** The `AdoptPolicy` the memory service hands the repository: decide, stamp,
 * and write as the institutional owner. */
export function ratificationPolicy(db: MarinaDB): AdoptPolicy {
  return {
    ratify(actor, space, rationale) {
      const decision = checkRatification(db, actor.principalId);
      if (!decision.ok)
        throw new MemoryError(
          403,
          "ratification_required",
          `${decision.reason} (target space "${space.name}")`,
        );
      return {
        ratified_by: ratifiedBy(db, actor.principalId, decision, rationale),
        writer: institutionalOwnerActor(db),
      };
    },
  };
}

/** Durable-record shape for a legacy pool note (type/tier vocabularies differ). */
function mirrorInput(note: NoteRow, importance: number, meta: Record<string, unknown>) {
  const types = ["fact", "observation", "decision", "inference", "skill", "episode"];
  const tier: MemoryRecordInput["tier"] =
    note.tier === "skill" ? "skill" : note.tier === "reflection" ? "reflection" : "fact";
  const type =
    tier === "skill"
      ? "skill"
      : types.includes(note.note_type)
        ? (note.note_type as MemoryRecordInput["type"])
        : tier === "reflection"
          ? "inference"
          : "fact";
  return {
    content: note.content,
    type,
    tier,
    importance,
    metadata: meta,
  } satisfies MemoryRecordInput;
}

export type RatifyPoolNoteResult =
  | {
      ok: true;
      note: NoteRow;
      space: MemorySpace;
      record: MemoryReceipt;
      importance: number;
      ratified_by: MemoryRatifiedBy;
      existing: boolean;
    }
  | { ok: false; code: string; reason: string; standing?: number; threshold?: number };

/** `pool <name> ratify <noteId>`: lift the proposal cap, mark the legacy note
 * verified, and mirror it into the institutional space as a ratified record
 * (idempotent per note; the legacy twin row is the caller's — see pool.ts). */
export function ratifyPoolNote(
  db: MarinaDB,
  poolName: string,
  noteId: number,
  ratifier: { name: string; rank?: number },
  opts: { importance?: number; rationale?: string } = {},
): RatifyPoolNoteResult {
  if (!isInstitutionalPoolName(poolName))
    return {
      ok: false,
      code: "not_institutional",
      reason: `Pool "${poolName}" is not institutional; ratification applies to guide, orchestration:* and tradition:* pools.`,
    };
  const pool = db.getMemoryPool(poolName);
  const note = db.getNote(noteId);
  if (!pool || !note || note.pool_id !== pool.id || note.verification_status === "superseded")
    return {
      ok: false,
      code: "note_not_found",
      reason: `Note #${noteId} is not an active note in pool "${poolName}".`,
    };
  const principalId = db.durableKeyForName(ratifier.name);
  if (!principalId)
    return {
      ok: false,
      code: "world_identity_required",
      reason: "An active durable world account is required to ratify.",
    };
  const decision = checkRatification(db, principalId, { rank: ratifier.rank });
  if (!decision.ok)
    return {
      ok: false,
      code: "ratification_required",
      reason: decision.reason,
      standing: decision.standing,
      threshold: decision.threshold,
    };
  const space = ensureInstitutionalSpace(db, poolName);
  const importance = Math.max(
    note.importance,
    Math.min(10, Math.max(1, opts.importance ?? INSTITUTIONAL_RATIFIED_IMPORTANCE)),
  );
  const stamp = ratifiedBy(db, principalId, decision, opts.rationale);
  const repo = db.memoryRepository();
  // Mirror first (idempotent per note through the key); lift only on success.
  const key = `pool-ratify:${poolName}:${noteId}`;
  const owner = institutionalOwnerActor(db);
  const existing = db.memoryRepository().adopt.findAdoption(`pool-note:${noteId}`, space.id);
  const record = existing
    ? { id: existing.id, version: existing.version }
    : repo.remember(
        owner,
        space.id,
        mirrorInput(note, importance, {
          format: "marina.memory.pool-ratification.v1",
          adopted_from_job: `pool-note:${noteId}`,
          pool: poolName,
          note_id: noteId,
          author: note.entity_name,
          ratified_by: stamp,
        }),
        key,
      );
  repo.adopt.setPoolNoteImportance(noteId, importance);
  if (note.verification_status !== "verified")
    db.recordNoteVerification(
      noteId,
      ratifier.name,
      "verified",
      0.9,
      opts.rationale ?? `ratified into institutional space ${space.id}`,
    );
  return {
    ok: true,
    note: db.getNote(noteId) ?? note,
    space,
    record,
    importance,
    ratified_by: stamp,
    existing: Boolean(existing),
  };
}
