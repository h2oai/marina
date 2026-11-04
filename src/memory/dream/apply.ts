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
 * holds. PROPOSE-TIER ops change meaning — `supersede` with new text,
 * `propose-skill` with a drafted skill — and are filed for the owner: the
 * text waits in `core_memory` (owner `memory:dream`) and `memory dream adopt
 * <dream> <n>` applies it — a restatement through `reviseNote` after the
 * faithfulness check is run again against the notes as they are THEN, a
 * skill as a DRAFT note (`src/memory/skill-draft.ts`) after the coverage
 * check is run again. A POOL dream (`scope.ts`) files EVERY op this way — the
 * dry view still probes the set — and a ratifier applies one with
 * `pool <name> dream ratify`, under the same re-checks. Nothing a dream
 * writes is ever final: the dream row keeps
 * a footprint of every applied op (ids and prior values, never text) and
 * `memory dream rollback <id>` reverses the whole set in one transaction.
 */

import type { MarinaDB } from "../../persistence/database";
import type { DreamRow } from "../../persistence/db-memory-dreams";
import { parseDreamJson } from "../../persistence/db-memory-dreams";
import { shingleSimilarity } from "../near-duplicate";
import { coversProcedure, skillContent, skillSlug } from "../skill-draft";
import { faithfulTo, leavingIds, MERGE_MIN_OVERLAP, opIds, SUPERSEDE_MAX_CHARS } from "./check";
import { gatherEpisodes } from "./journal";
import { settleDreamOp, settleRolledBack } from "./judge";
import type { ProbePlan } from "./probe";
import { probeHit } from "./probe";
import type { ProcedureCandidate } from "./procedures";
import { type DreamScope, inScope, scopeOf, scopeRecall } from "./scope";
import type {
  AppliedFootprint,
  DreamChecks,
  DreamOp,
  DreamOpKind,
  DreamProbe,
  ProposalMark,
  RejectedOp,
  StoredDreamOp,
} from "./types";

/** How far one decay lowers a note's importance (1–10 scale). */
export const DECAY_STEP = 2;
/** `core_memory` owner that holds filed supersede proposals (text lives only here). */
export const PROPOSAL_OWNER = "memory:dream";
/** A proposal nobody adopted or dismissed is dropped after this long. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How far back an adoption re-reads the owner's journal for a restatement's sources (the first-dream window). */
export const DREAM_WINDOW_FOR_ADOPT_MS = 7 * 24 * 60 * 60 * 1000;

type PriorStatus = "unverified" | "disputed";

/** A propose-tier op waiting for the owner (or a pool's ratifier): a restatement, a skill draft, or — a pool — any record op. */
export type DreamProposal = {
  entityName: string;
  dreamId: number;
  n: number;
  reason: string;
  createdAt: number;
} & (
  | { kind: "supersede"; id: number; text: string; refs: number[] }
  | {
      kind: "skill";
      procedure: string;
      name: string;
      description: string;
      steps: string[];
      tasks: number[];
    }
  | { kind: "op"; op: Extract<DreamOp, { op: "merge" | "link" | "decay" }> }
);

/** Ops that are proposals in an ENTITY dream (a pool dream proposes everything). */
const PROPOSE_TIER: ReadonlySet<DreamOpKind> = new Set(["supersede", "propose-skill"]);

/** A skill draft note from a proposal: the library's content shape, importance 5, exact duplicates fold. */
export function createSkillDraft(
  db: MarinaDB,
  entityName: string,
  skill: { name: string; description: string },
  steps: readonly string[],
): number | undefined {
  const content = skillContent(skillSlug(skill.name), skill.description, steps, { draft: true });
  const id = db.createNote(entityName, content, undefined, { importance: 5, noteType: "skill" });
  return id > 0 ? id : undefined;
}

/** Whether one of the owner's skills or any macro already covers these steps. */
export function procedureCovered(db: MarinaDB, entityName: string, steps: readonly string[]) {
  return [
    ...db.getNotesByType(entityName, "skill", 500).map((n) => n.content),
    ...db.listMacros().map((m) => m.command),
  ].some((text) => coversProcedure(text, steps));
}

function withProposal(
  base: StoredDreamOp,
  mark: ProposalMark,
  applied?: AppliedFootprint,
): StoredDreamOp {
  return applied ? { ...base, proposal: mark, applied } : { ...base, proposal: mark };
}

/** The author who may write to a note: a pool note's own author, else the dream's owner. */
const authorOf = (db: MarinaDB, id: number, fallback: string) =>
  db.getNote(id)?.entity_name ?? fallback;

/**
 * Apply ONE op to the store (inside the caller's transaction): the footprint
 * when it applied, `proposal` when it is filed instead, `skipped` with the
 * reason when the store refused it on contact. Shared by the dream's apply
 * and by adoption/ratification.
 */
function applyOne(
  db: MarinaDB,
  entityName: string,
  scope: DreamScope,
  op: DreamOp,
  ctx: {
    plan?: ProbePlan;
    applySupersedes?: boolean;
    applySkills?: boolean;
    procedures?: readonly ProcedureCandidate[];
  },
): { applied?: AppliedFootprint; skipped?: RejectedOp; proposal?: true } {
  switch (op.op) {
    case "merge": {
      const prior: Record<string, PriorStatus> = {};
      for (const id of op.into) prior[String(id)] = priorStatus(db, id);
      const changed =
        scope.kind === "pool"
          ? db.consolidatePoolNotes(scope.poolId, op.keep, op.into)
          : db.consolidateNotes(entityName, op.keep, op.into);
      if (!changed)
        return {
          skipped: {
            op: "merge",
            ids: [op.keep, ...op.into],
            reason: "merge: nothing to fold (the notes have moved on)",
          },
        };
      return { applied: { kind: "merge", prior } };
    }
    case "link": {
      const present = db
        .getNoteLinks(op.from)
        .some(
          (l) => l.source_id === op.from && l.target_id === op.to && l.relationship === op.relation,
        );
      if (present)
        return {
          skipped: {
            op: "link",
            ids: [op.from, op.to],
            reason: `link: #${op.from} ${op.relation} #${op.to} is already there`,
          },
        };
      return { applied: { kind: "link", linkId: db.createNoteLink(op.from, op.to, op.relation) } };
    }
    case "decay": {
      const note = db.getNote(op.id);
      const priorImportance = note?.importance ?? 5;
      db.setNoteImportance(
        note?.entity_name ?? entityName,
        op.id,
        Math.max(1, priorImportance - DECAY_STEP),
      );
      return { applied: { kind: "decay", priorImportance } };
    }
    case "supersede": {
      if (!ctx.applySupersedes) return { proposal: true };
      // An earned dreamer applies the restatement at once — same path as an
      // adoption, same footprint, same rollback.
      const prior = priorStatus(db, op.id);
      const newId = db.reviseNote(entityName, op.id, op.text);
      if (!newId) return { proposal: true };
      // The restatement carries the old note's span for its probe.
      const q = ctx.plan?.queries.get(op.id);
      if (q) q.successor = newId;
      return { applied: { kind: "supersede", newId, prior } };
    }
    case "propose-skill": {
      const candidate = ctx.procedures?.find((p) => p.key === op.procedure);
      if (!candidate)
        return {
          skipped: {
            op: "propose-skill",
            ids: [],
            reason: `procedure: ${op.procedure} is not in this dream's region`,
          },
        };
      if (!ctx.applySkills) return { proposal: true };
      // An earned dreamer stores the draft at once — still a draft: a
      // validation run or a person's verify makes it servable.
      const newId = createSkillDraft(db, entityName, op, candidate.steps);
      return newId ? { applied: { kind: "propose-skill", newId } } : { proposal: true };
    }
  }
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
  /** Ops, in op order, that `on` files as proposals (propose-tier; every op of a pool dream). */
  proposals: Array<{ n: number; op: DreamOp }>;
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
  opts: {
    commit: boolean;
    applySupersedes?: boolean;
    applySkills?: boolean;
    /** The region's repeated procedures (a propose-skill's steps). */
    procedures?: readonly ProcedureCandidate[];
    /** A pool dream: every op that applied on the view is filed as a proposal and the view is rolled back. */
    proposeAll?: boolean;
  },
): ApplyResult {
  const scope = scopeOf(db, entityName) ?? { kind: "entity" as const, name: entityName };
  const run = (): ApplyResult => {
    const ops: StoredDreamOp[] = [];
    const proposals: ApplyResult["proposals"] = [];
    const skipped: ApplyResult["skipped"] = [];
    accepted.forEach((op, n) => {
      const base = stored[n]!;
      const one = applyOne(db, entityName, scope, op, {
        plan,
        applySupersedes: opts.applySupersedes,
        applySkills: opts.applySkills,
        procedures: opts.procedures,
      });
      if (one.skipped) {
        skipped.push({ n, rejected: one.skipped });
        ops.push(base);
        return;
      }
      if (one.proposal) {
        proposals.push({ n, op });
        ops.push(withProposal(base, "pending"));
        return;
      }
      ops.push(
        PROPOSE_TIER.has(base.op)
          ? withProposal(base, "earned", one.applied)
          : { ...base, applied: one.applied },
      );
    });
    if (opts.proposeAll) {
      // The view showed what the set would do; now every applied op waits for a ratifier.
      ops.forEach((o, n) => {
        if (!o.applied) return;
        proposals.push({ n, op: accepted[n]! });
        const { applied: _applied, ...rest } = o;
        ops[n] = withProposal(rest as StoredDreamOp, "pending");
      });
      proposals.sort((a, b) => a.n - b.n);
    }
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
    if (!opts.commit || opts.proposeAll) throw new DryView(result);
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
    const hits = q.query ? scopeRecall(db, entityName, q.query) : [];
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
  procedures: readonly ProcedureCandidate[] = [],
): number {
  let filed = 0;
  for (const { n, op } of proposals) {
    const base = { entityName, dreamId, n, reason: op.reason, createdAt: now };
    let value: DreamProposal;
    if (op.op === "supersede")
      value = { ...base, kind: "supersede", id: op.id, text: op.text, refs: op.refs };
    else if (op.op !== "propose-skill") value = { ...base, kind: "op", op };
    else {
      const candidate = procedures.find((p) => p.key === op.procedure);
      if (!candidate) continue;
      value = {
        ...base,
        kind: "skill",
        procedure: op.procedure,
        name: skillSlug(op.name),
        description: op.description,
        steps: candidate.steps,
        tasks: candidate.tasks,
      };
    }
    db.setCoreMemory(PROPOSAL_OWNER, proposalKey(entityName, dreamId, n), JSON.stringify(value));
    filed++;
  }
  return filed;
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
  return value?.entityName === entityName ? withKind(value) : undefined;
}

/** A proposal filed before skill drafts existed carries no `kind`: it is a restatement. */
function withKind(value: DreamProposal): DreamProposal {
  return (value as { kind?: string }).kind
    ? value
    : ({ ...value, kind: "supersede" } as DreamProposal);
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
    const raw = parseDreamJson<DreamProposal | null>(row.value, null);
    if (!raw || raw.entityName !== entityName) continue;
    const value = withKind(raw);
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
  if (!op) return;
  ops[proposal.n] = withProposal(op, mark, applied);
  db.updateDream(row.id, { ops });
}

export type AdoptOutcome =
  | { ok: true; kind: "supersede"; newId: number; oldId: number }
  | { ok: true; kind: "skill"; newId: number }
  | { ok: true; kind: "op"; op: DreamOpKind }
  | { ok: false; reason: string; stale?: boolean };

/**
 * Adopt one filed proposal. A restatement: the target and its refs must
 * still be the owner's live, unverified notes, and the text must still be
 * faithful to them as they are now; applied through `reviseNote` (one
 * transaction; the old note is superseded, never deleted). A skill: no skill
 * or macro may have come to cover the procedure since; stored as a DRAFT
 * note. Either way the footprint goes on the dream so `rollback` can reverse
 * it.
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
  if (proposal.kind === "op") {
    // A pool's record op, ratified: the notes must still be live in the
    // scope, nothing it takes out may have been verified since, and a merge's
    // duplicates must still say the same thing.
    const scope = scopeOf(db, entityName);
    if (!scope) return { ok: false, reason: "no such pool" };
    const op = proposal.op;
    const notes = opIds(op).map((id) => db.getNote(id));
    if (notes.some((note) => !inScope(scope, note) || note!.verification_status === "superseded")) {
      dismissProposal(db, entityName, dreamId, n, "stale");
      return { ok: false, reason: "a note it touches has since changed", stale: true };
    }
    if (leavingIds(op).some((id) => db.getNote(id)!.verification_status === "verified")) {
      dismissProposal(db, entityName, dreamId, n, "stale");
      return { ok: false, reason: "a note it touches is verified now", stale: true };
    }
    if (op.op === "merge") {
      const keep = db.getNote(op.keep)!;
      const apart = op.into.some(
        (id) => shingleSimilarity(keep.content, db.getNote(id)!.content) < MERGE_MIN_OVERLAP,
      );
      if (apart) {
        dismissProposal(db, entityName, dreamId, n, "stale");
        return { ok: false, reason: "the notes no longer say the same thing", stale: true };
      }
    }
    const failed = db.transaction(() => {
      const one = applyOne(db, entityName, scope, op, {});
      if (!one.applied) return one.skipped?.reason ?? "the op could not be applied";
      db.deleteCoreMemory(PROPOSAL_OWNER, proposalKey(entityName, dreamId, n));
      markProposal(db, proposal, "adopted", one.applied);
      return undefined;
    });
    if (failed) return { ok: false, reason: failed };
    settleDreamOp(db, dreamId, n, true);
    return { ok: true, kind: "op", op: op.op };
  }
  if (proposal.kind === "skill") {
    if (procedureCovered(db, entityName, proposal.steps)) {
      dismissProposal(db, entityName, dreamId, n, "stale");
      return { ok: false, reason: "a skill or macro already covers this procedure", stale: true };
    }
    const newId = db.transaction(() => {
      const id = createSkillDraft(db, entityName, proposal, proposal.steps);
      if (!id) return undefined;
      db.deleteCoreMemory(PROPOSAL_OWNER, proposalKey(entityName, dreamId, n));
      markProposal(db, proposal, "adopted", { kind: "propose-skill", newId: id });
      return id;
    });
    if (!newId) return { ok: false, reason: "the draft could not be stored" };
    settleDreamOp(db, dreamId, n, true);
    return { ok: true, kind: "skill", newId };
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
  // The same sources the dream had: the notes as they are now, and the
  // owner's episodes of the dream's window (the journal is immutable).
  const episodes = gatherEpisodes(
    db,
    entityName,
    dream.created_at - DREAM_WINDOW_FOR_ADOPT_MS,
    dream.created_at,
  ).episodes;
  const sources = [
    ...[target!, ...refs.map((r) => r!)].map((note) => note.content),
    ...episodes.map((e) => e.text),
  ].join("\n");
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
  return { ok: true, kind: "supersede", newId, oldId: proposal.id };
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

/**
 * Reverse ONE applied op from its footprint: a merged-away note reopens as
 * its author, a decay's importance returns, a link is removed, a restatement
 * steps aside (the original is current again), a skill draft is retired.
 * True when the store changed; a note that moved on since is skipped.
 */
function revertOne(db: MarinaDB, entityName: string, op: StoredDreamOp): boolean {
  const applied = op.applied;
  if (!applied) return false;
  switch (applied.kind) {
    case "merge": {
      if (op.op !== "merge") return false;
      let done = false;
      for (const id of op.into)
        done =
          db.restoreSupersededNote(
            authorOf(db, id, entityName),
            op.keep,
            id,
            applied.prior[String(id)] ?? "unverified",
          ) || done;
      return done;
    }
    case "decay":
      return op.op === "decay"
        ? db.setNoteImportance(authorOf(db, op.id, entityName), op.id, applied.priorImportance)
        : false;
    case "link":
      return op.op === "link" ? db.removeNoteLink(op.from, op.to, op.relation) : false;
    case "supersede":
      return op.op === "supersede"
        ? db.revertRevision(entityName, applied.newId, op.id, applied.prior)
        : false;
    case "propose-skill":
      return op.op === "propose-skill" ? db.deleteNote(applied.newId, entityName) : false;
  }
}

export type RestoreOutcome =
  | { ok: true; op: DreamOpKind; remaining: number; rolledBack: boolean }
  | { ok: false; reason: string };

/**
 * The owner's per-op undo (`memory dream restore <dream> <n>`): reverse ONE
 * applied op of an applied dream with the same reversal a rollback uses, and
 * leave the rest standing. The op's judge opinion settles as a fail (the
 * owner disagreed with that one). When nothing applied remains and no
 * proposal is pending, the dream is as rolled back. A pending proposal is
 * dismissed, not restored.
 */
export function restoreDreamOp(
  db: MarinaDB,
  row: DreamRow,
  n: number,
  now = Date.now(),
): RestoreOutcome {
  if (row.state === "rolled_back") return { ok: false, reason: "already rolled back" };
  if (row.state !== "applied")
    return { ok: false, reason: "observed, not applied: nothing to undo" };
  const entityName = row.entity_name;
  const ops = parseDreamJson<StoredDreamOp[]>(row.ops_json, []);
  const op = ops[n];
  if (!op) return { ok: false, reason: `no op ${n} in this dream` };
  if (op.proposal === "pending")
    return { ok: false, reason: `op ${n} is a pending proposal: dismiss it instead` };
  if (!op.applied) return { ok: false, reason: `op ${n} was not applied` };
  if (op.reverted) return { ok: false, reason: `op ${n} is already restored` };
  let rolledBack = false;
  let remaining = 0;
  db.transaction(() => {
    revertOne(db, entityName, op);
    ops[n] = { ...op, reverted: true };
    remaining = ops.filter((o) => o.applied && !o.reverted).length;
    const pending = ops.some((o) => o.proposal === "pending");
    rolledBack = remaining === 0 && !pending;
    db.updateDream(row.id, {
      ops,
      ...(rolledBack ? { state: "rolled_back", rolledBackAt: now } : {}),
    });
  });
  settleDreamOp(db, row.id, n, false, now);
  db.appendChronicle({
    kind: "event",
    source: "memory",
    title: "memory.dream.restore",
    body: `${entityName}: op ${n} (${op.op}) of dream #${row.id} restored — ${remaining} applied op(s) still stand${rolledBack ? "; the dream is as rolled back" : ""}`,
    participants: [entityName],
    refs: [`dream:${row.id}`],
  });
  return { ok: true, op: op.op, remaining, rolledBack };
}

export type RollbackOutcome =
  | { ok: true; reverted: number; dismissed: number }
  | { ok: false; reason: string };

/**
 * Reverse an applied dream in one transaction: merged-away notes reopen
 * (status, edge and canonical validity), decays restore their importance,
 * links are removed, adopted restatements step aside (the original is current
 * again, the restatement stays as a superseded note), adopted skill drafts
 * are retired; pending proposals are dismissed. Ops are reversed newest first.
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
      if (op.proposal === "pending") {
        if (dismissProposal(db, entityName, row.id, i)) dismissed++;
        ops[i] = { ...op, proposal: "dismissed" };
        continue;
      }
      if (!op.applied || op.reverted) continue;
      if (revertOne(db, entityName, op)) reverted++;
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
