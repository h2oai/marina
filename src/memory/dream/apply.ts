// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The apply path of a dream, and its reverse.
 *
 * Two tiers of op. AUTO-TIER ops are the ones a machine verified end to end
 * — `merge` (coverage-checked duplicates fold into their keeper through
 * `consolidateNotes`: superseded, never deleted), `link` (one knowledge-graph
 * edge), `decay` (importance lowered by DECAY_STEP, reversible). They apply
 * in ONE transaction, after the probe set is re-run on the applied view and
 * holds. PROPOSE-TIER ops change meaning — `supersede` with new text — and
 * are filed for the owner: the text waits in `core_memory` (owner
 * `memory:dream`) and `memory dream adopt <dream> <n>` applies it through
 * `reviseNote` after the faithfulness check is run again against the notes
 * as they are THEN. Nothing a dream writes is ever final: the dream row keeps
 * a footprint of every applied op (ids and prior values, never text) and
 * `memory dream rollback <id>` reverses the whole set in one transaction.
 */

import type { MarinaDB } from "../../persistence/database";
import type { DreamRow } from "../../persistence/db-memory-dreams";
import { parseDreamJson } from "../../persistence/db-memory-dreams";
import { faithfulTo, leavingIds, SUPERSEDE_MAX_CHARS } from "./check";
import { settleDreamOp, settleRolledBack } from "./judge";
import type { ProbePlan } from "./probe";
import { probeHit } from "./probe";
import type {
  AppliedFootprint,
  DreamChecks,
  DreamOp,
  DreamProbe,
  RejectedOp,
  StoredDreamOp,
} from "./types";

/** How far one decay lowers a note's importance (1–10 scale). */
export const DECAY_STEP = 2;
/** `core_memory` owner that holds filed supersede proposals (text lives only here). */
export const PROPOSAL_OWNER = "memory:dream";
/** A proposal nobody adopted or dismissed is dropped after this long. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type PriorStatus = "unverified" | "disputed";

/** A supersede waiting for the owner. */
export interface DreamProposal {
  entityName: string;
  dreamId: number;
  n: number;
  id: number;
  text: string;
  refs: number[];
  reason: string;
  createdAt: number;
}

const proposalKey = (entityName: string, dreamId: number, n: number) =>
  `proposal:${entityName}:${dreamId}:${n}`;

function priorStatus(db: MarinaDB, id: number): PriorStatus {
  const status = db.getNote(id)?.verification_status;
  return status === "disputed" ? "disputed" : "unverified";
}

/** Thrown inside the apply transaction to roll the dry view back on purpose. */
class DryView {
  constructor(readonly result: ApplyResult) {}
}
/** Thrown inside the apply transaction when the applied view loses a probe. */
class ProbeLoss {
  constructor(readonly result: ApplyResult) {}
}

export interface ApplyResult {
  /** The accepted ops with their footprint (auto-tier) or proposal mark (supersede). */
  ops: StoredDreamOp[];
  probes: DreamProbe[];
  probesAfter: DreamChecks["probesAfter"];
  /** Supersede ops, in op order, that `on` files as proposals. */
  proposals: Array<{ n: number; op: Extract<DreamOp, { op: "supersede" }> }>;
  /** Probe ids that passed before and fail on the applied view. */
  lost: number[];
  /** Accepted ops the store refused on contact (a link already present): rejected, by index. */
  skipped: Array<{ n: number; rejected: RejectedOp }>;
}

/**
 * Apply the auto-tier ops of `accepted` in one transaction and re-run the
 * probes on the result. `commit: false` (observe, dry-run) always rolls the
 * transaction back and returns what the view showed; `commit: true` keeps
 * the changes only when no probe that passed before fails after — a loss
 * rolls everything back and names the lost ids.
 */
export function applyOps(
  db: MarinaDB,
  entityName: string,
  accepted: readonly DreamOp[],
  stored: readonly StoredDreamOp[],
  plan: ProbePlan,
  opts: { commit: boolean; applySupersedes?: boolean },
): ApplyResult {
  const run = (): ApplyResult => {
    const ops: StoredDreamOp[] = [];
    const proposals: ApplyResult["proposals"] = [];
    const skipped: ApplyResult["skipped"] = [];
    accepted.forEach((op, n) => {
      const base = stored[n]!;
      let applied: AppliedFootprint | undefined;
      switch (op.op) {
        case "merge": {
          const prior: Record<string, PriorStatus> = {};
          for (const id of op.into) prior[String(id)] = priorStatus(db, id);
          db.consolidateNotes(entityName, op.keep, op.into);
          applied = { kind: "merge", prior };
          break;
        }
        case "link": {
          const present = db
            .getNoteLinks(op.from)
            .some(
              (l) =>
                l.source_id === op.from && l.target_id === op.to && l.relationship === op.relation,
            );
          if (present) {
            skipped.push({
              n,
              rejected: {
                op: "link",
                ids: [op.from, op.to],
                reason: `link: #${op.from} ${op.relation} #${op.to} is already there`,
              },
            });
            break;
          }
          const linkId = db.createNoteLink(op.from, op.to, op.relation);
          applied = { kind: "link", linkId };
          break;
        }
        case "decay": {
          const priorImportance = db.getNote(op.id)?.importance ?? 5;
          db.setNoteImportance(entityName, op.id, Math.max(1, priorImportance - DECAY_STEP));
          applied = { kind: "decay", priorImportance };
          break;
        }
        case "supersede": {
          if (!opts.applySupersedes) {
            proposals.push({ n, op });
            break;
          }
          // An earned dreamer applies the restatement at once — same path as
          // an adoption, same footprint, same rollback.
          const prior = priorStatus(db, op.id);
          const newId = db.reviseNote(entityName, op.id, op.text);
          if (newId) {
            applied = { kind: "supersede", newId, prior };
            // The restatement carries the old note's span for its probe.
            const q = plan.queries.get(op.id);
            if (q) q.successor = newId;
          } else proposals.push({ n, op });
          break;
        }
      }
      ops.push(
        applied
          ? base.op === "supersede"
            ? { ...base, applied, proposal: "earned" }
            : { ...base, applied }
          : base.op === "supersede"
            ? { ...base, proposal: "pending" }
            : base,
      );
    });
    const probes = probesAfter(db, entityName, plan);
    const lost = probes
      .filter((p) => p.before === "pass" && p.after === "fail")
      .map((p) => p.itemId);
    const result: ApplyResult = {
      ops,
      skipped,
      probes,
      probesAfter: plan.probes.length
        ? {
            pass: probes.filter((p) => p.after === "pass").length,
            fail: probes.filter((p) => p.after === "fail").length,
          }
        : null,
      proposals,
      lost,
    };
    if (lost.length) throw new ProbeLoss(result);
    if (!opts.commit) throw new DryView(result);
    return result;
  };
  try {
    return db.transaction(run);
  } catch (err) {
    if (err instanceof DryView) return err.result;
    if (err instanceof ProbeLoss) return err.result;
    throw err;
  }
}

/** Re-run the plan's probes against the store as it is now. */
export function probesAfter(db: MarinaDB, entityName: string, plan: ProbePlan): DreamProbe[] {
  return plan.probes.map((probe) => {
    const q = plan.queries.get(probe.itemId);
    if (!q) return { ...probe, after: null };
    const hits = q.query ? db.recallNotes(entityName, q.query) : [];
    return { ...probe, after: probeHit(hits, probe.itemId, q.successor) ? "pass" : "fail" };
  });
}

// ─── Proposals ────────────────────────────────────────────────────────────

export function fileProposals(
  db: MarinaDB,
  entityName: string,
  dreamId: number,
  proposals: ApplyResult["proposals"],
  now = Date.now(),
): number {
  for (const { n, op } of proposals) {
    const value: DreamProposal = {
      entityName,
      dreamId,
      n,
      id: op.id,
      text: op.text,
      refs: op.refs,
      reason: op.reason,
      createdAt: now,
    };
    db.setCoreMemory(PROPOSAL_OWNER, proposalKey(entityName, dreamId, n), JSON.stringify(value));
  }
  return proposals.length;
}

export function readProposal(
  db: MarinaDB,
  entityName: string,
  dreamId: number,
  n: number,
): DreamProposal | undefined {
  const row = db.getCoreMemory(PROPOSAL_OWNER, proposalKey(entityName, dreamId, n));
  if (!row) return undefined;
  const value = parseDreamJson<DreamProposal | null>(row.value, null);
  return value?.entityName === entityName ? value : undefined;
}

/** The owner's pending proposals, oldest first; expired ones are dropped as they are met. */
export function pendingProposals(
  db: MarinaDB,
  entityName: string,
  now = Date.now(),
): DreamProposal[] {
  const prefix = `proposal:${entityName}:`;
  const out: DreamProposal[] = [];
  for (const row of db.listCoreMemory(PROPOSAL_OWNER)) {
    if (!row.key.startsWith(prefix)) continue;
    const value = parseDreamJson<DreamProposal | null>(row.value, null);
    if (!value || value.entityName !== entityName) continue;
    if (now - value.createdAt > PROPOSAL_TTL_MS) {
      db.deleteCoreMemory(PROPOSAL_OWNER, row.key);
      markProposal(db, value, "stale");
      continue;
    }
    out.push(value);
  }
  return out.sort((a, b) => a.dreamId - b.dreamId || a.n - b.n);
}

function markProposal(
  db: MarinaDB,
  proposal: DreamProposal,
  mark: "adopted" | "dismissed" | "stale",
  applied?: AppliedFootprint,
): void {
  const row = db.getDream(proposal.dreamId);
  if (!row) return;
  const ops = parseDreamJson<StoredDreamOp[]>(row.ops_json, []);
  const op = ops[proposal.n];
  if (!op || op.op !== "supersede") return;
  ops[proposal.n] = { ...op, proposal: mark, ...(applied ? { applied } : {}) };
  db.updateDream(row.id, { ops });
}

export type AdoptOutcome =
  | { ok: true; newId: number; oldId: number }
  | { ok: false; reason: string; stale?: boolean };

/**
 * Adopt one filed restatement: the target and its refs must still be the
 * owner's live, unverified notes, and the text must still be faithful to
 * them as they are now. Applies through `reviseNote` (one transaction; the
 * old note is superseded, never deleted) and records the footprint on the
 * dream so `rollback` can reverse it.
 */
export function adoptProposal(
  db: MarinaDB,
  entityName: string,
  dreamId: number,
  n: number,
): AdoptOutcome {
  const proposal = readProposal(db, entityName, dreamId, n);
  if (!proposal) return { ok: false, reason: "no such pending proposal" };
  const dream = db.getDream(dreamId);
  if (!dream || dream.entity_name !== entityName)
    return { ok: false, reason: "no such dream of yours" };
  if (dream.state === "rolled_back") {
    dismissProposal(db, entityName, dreamId, n);
    return { ok: false, reason: `dream #${dreamId} was rolled back`, stale: true };
  }
  const target = db.getNote(proposal.id);
  const refs = proposal.refs.map((id) => db.getNote(id));
  const gone = [target, ...refs].some(
    (note) => !note || note.entity_name !== entityName || note.verification_status === "superseded",
  );
  if (gone) {
    dismissProposal(db, entityName, dreamId, n, "stale");
    return { ok: false, reason: "a note it rests on has since changed", stale: true };
  }
  if (target!.verification_status === "verified") {
    dismissProposal(db, entityName, dreamId, n, "stale");
    return { ok: false, reason: `#${proposal.id} is verified and stays as it is`, stale: true };
  }
  if (proposal.text.length > SUPERSEDE_MAX_CHARS)
    return { ok: false, reason: `text over ${SUPERSEDE_MAX_CHARS} characters` };
  const sources = [target!, ...refs.map((r) => r!)].map((note) => note.content).join("\n");
  if (!faithfulTo(proposal.text, sources)) {
    dismissProposal(db, entityName, dreamId, n, "stale");
    return {
      ok: false,
      reason: "the text carries a number, name or identifier its sources no longer hold",
      stale: true,
    };
  }
  const prior = priorStatus(db, proposal.id);
  const newId = db.transaction(() => {
    const id = db.reviseNote(entityName, proposal.id, proposal.text);
    if (!id) return undefined;
    db.deleteCoreMemory(PROPOSAL_OWNER, proposalKey(entityName, dreamId, n));
    markProposal(db, proposal, "adopted", { kind: "supersede", newId: id, prior });
    return id;
  });
  if (!newId) return { ok: false, reason: "the note could not be revised" };
  settleDreamOp(db, dreamId, n, true);
  return { ok: true, newId, oldId: proposal.id };
}

export function dismissProposal(
  db: MarinaDB,
  entityName: string,
  dreamId: number,
  n: number,
  mark: "dismissed" | "stale" = "dismissed",
): boolean {
  const proposal = readProposal(db, entityName, dreamId, n);
  if (!proposal) return false;
  db.deleteCoreMemory(PROPOSAL_OWNER, proposalKey(entityName, dreamId, n));
  markProposal(db, proposal, mark);
  // A dismissal is the owner's verdict; a stale proposal says nothing about the op.
  if (mark === "dismissed") settleDreamOp(db, dreamId, n, false);
  return true;
}

// ─── Rollback ─────────────────────────────────────────────────────────────

export type RollbackOutcome =
  | { ok: true; reverted: number; dismissed: number }
  | { ok: false; reason: string };

/**
 * Reverse an applied dream in one transaction: merged-away notes reopen
 * (status, edge and canonical validity), decays restore their importance,
 * links are removed, adopted restatements step aside (the original is current
 * again, the restatement stays as a superseded note); pending proposals are
 * dismissed. Ops are reversed newest first.
 * A note that has moved on since (deleted, re-superseded by something else)
 * is skipped, not forced.
 */
export function rollbackDream(db: MarinaDB, row: DreamRow, now = Date.now()): RollbackOutcome {
  if (row.state === "rolled_back") return { ok: false, reason: "already rolled back" };
  if (row.state !== "applied")
    return { ok: false, reason: "observed, not applied: nothing to undo" };
  const entityName = row.entity_name;
  const ops = parseDreamJson<StoredDreamOp[]>(row.ops_json, []);
  let reverted = 0;
  let dismissed = 0;
  db.transaction(() => {
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i]!;
      if (op.op === "supersede" && op.proposal === "pending") {
        if (dismissProposal(db, entityName, row.id, i)) dismissed++;
        ops[i] = { ...op, proposal: "dismissed" };
        continue;
      }
      const applied = op.applied;
      if (!applied || op.reverted) continue;
      let done = false;
      switch (applied.kind) {
        case "merge":
          if (op.op === "merge")
            for (const id of op.into)
              done =
                db.restoreSupersededNote(
                  entityName,
                  op.keep,
                  id,
                  applied.prior[String(id)] ?? "unverified",
                ) || done;
          break;
        case "decay":
          if (op.op === "decay")
            done = db.setNoteImportance(entityName, op.id, applied.priorImportance);
          break;
        case "link":
          if (op.op === "link") done = db.removeNoteLink(op.from, op.to, op.relation);
          break;
        case "supersede":
          if (op.op === "supersede")
            done = db.revertRevision(entityName, applied.newId, op.id, applied.prior);
          break;
      }
      if (done) reverted++;
      ops[i] = { ...op, reverted: true };
    }
    db.updateDream(row.id, { state: "rolled_back", ops, rolledBackAt: now });
  });
  settleRolledBack(db, row.id, parseDreamJson<StoredDreamOp[]>(row.ops_json, []), now);
  db.appendChronicle({
    kind: "event",
    source: "memory",
    title: "memory.dream.rollback",
    body: `${entityName}: dream #${row.id} rolled back — ${reverted} op(s) reversed, ${dismissed} proposal(s) dismissed`,
    participants: [entityName],
    refs: [`dream:${row.id}`],
  });
  return { ok: true, reverted, dismissed };
}

/** Ids an accepted op set would take out of the active set, for the probe plan. */
export function leavingOf(accepted: readonly DreamOp[]): number[] {
  const out = new Set<number>();
  for (const op of accepted) for (const id of leavingIds(op)) out.add(id);
  return [...out];
}
