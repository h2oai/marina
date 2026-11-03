// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dream pass's vocabulary: typed operations over an agent's own records,
 * each with evidence refs — never replacement prose. The model proposes ops;
 * mechanical checks accept or reject them; a dream record keeps both with
 * ids, hashes and counts only.
 */

import type { ProcedureCandidate } from "./procedures";

export type DreamMode = "off" | "observe" | "on";
export type DreamTrigger = "schedule" | "command" | "dry-run";

/** Link relations a dream may propose. */
export const DREAM_LINK_RELATIONS = [
  "related_to",
  "supports",
  "contradicts",
  "derived_from",
  "part_of",
] as const;
export type DreamLinkRelation = (typeof DREAM_LINK_RELATIONS)[number];

export type DreamOp =
  /** Duplicates fold into one keeper (the duplicates are superseded, never deleted). */
  | { op: "merge"; keep: number; into: number[]; reason: string }
  /** One note restated: the new text supersedes the old; every fact must be in the sources. */
  | { op: "supersede"; id: number; text: string; refs: number[]; reason: string }
  /** Structure between two notes. */
  | { op: "link"; from: number; to: number; relation: DreamLinkRelation; reason: string }
  /** Soft decay: served, never used — lowered, reversible. */
  | { op: "decay"; id: number; reason: string }
  /**
   * A skill drafted over a procedure the gather stage found repeated across
   * successful tasks (`procedures.ts`): the model names and describes it; the
   * steps are the ledger's. Propose-tier: the owner adopts it as a DRAFT.
   */
  | { op: "propose-skill"; procedure: string; name: string; description: string; reason: string };

export type DreamOpKind = DreamOp["op"];
export const DREAM_OP_KINDS: readonly DreamOpKind[] = [
  "merge",
  "supersede",
  "link",
  "decay",
  "propose-skill",
];

/** Where a propose-tier op stands with its owner. `earned`: applied at once by a dreamer that earned the op kind (`judge.ts`). */
export type ProposalMark = "pending" | "adopted" | "dismissed" | "stale" | "earned";

/** A rejected op with the check that failed it (agent-swarm's `rejected[]`). */
export interface RejectedOp {
  op: string;
  ids: number[];
  reason: string;
}

/** One record in the region, as the pass sees it. Content is for the model; never stored. */
export interface RegionRecord {
  id: number;
  tier: string;
  noteType: string;
  importance: number;
  verified: boolean;
  createdAt: number;
  content: string;
  /** Serves to the owner in the window. */
  serves: number;
  /** Citation ratings by the owner. */
  cited: number;
  /** Posterior mean over all ratings (0.5 = none). */
  mean: number;
  /** Rating rows. */
  ratings: number;
}

export interface DreamRegion {
  entityName: string;
  since: number;
  until: number;
  records: RegionRecord[];
  /** Outcomes resolved for the owner in the window, as counts. */
  outcomes: { total: number; succeeded: number; failed: number };
  /** New records written since the last dream (the trigger's material). */
  newRecords: number;
  /** Command sequences repeated across the owner's successful tasks that no skill covers. */
  procedures: ProcedureCandidate[];
  /** Set for a pool dream (`scope.ts`): the region is the pool's records, every member's. */
  pool?: { id: string; name: string };
  hash: string;
  bytes: number;
}

/** A self-probe: a query that should still retrieve the record's span (MemDream, rule-based). */
export interface DreamProbe {
  itemId: number;
  /** sha256 prefix of the probe query (ids and hashes only in the record). */
  queryHash: string;
  /** sha256 prefix of the verbatim span the probe expects. */
  spanHash: string;
  before: "pass" | "fail";
  after: "pass" | "fail" | null;
}

/**
 * What applying an op changed, enough to reverse it: the statuses a merge
 * closed, a decay's prior importance, a link's row, an adopted restatement's
 * new note. Never text.
 */
export type AppliedFootprint =
  | { kind: "merge"; prior: Record<string, "unverified" | "disputed"> }
  | { kind: "decay"; priorImportance: number }
  | { kind: "link"; linkId: number }
  | { kind: "supersede"; newId: number; prior: "unverified" | "disputed" }
  /** The skill draft note an adopted (or earned) propose-skill created. */
  | { kind: "propose-skill"; newId: number };

/**
 * The ops' footprint, stored without text: the supersede text is a hash and a
 * length. `applied` is set when the op was applied (and `reverted` when a
 * rollback undid it); `proposal` is set when the op was filed for the owner
 * to adopt — or, in a pool dream, for a ratifier (what it needs waits in
 * `core_memory` owner `memory:dream`).
 */
export type StoredDreamOp = (
  | { op: "merge"; keep: number; into: number[]; reason: string }
  | {
      op: "supersede";
      id: number;
      textHash: string;
      textLength: number;
      refs: number[];
      reason: string;
    }
  | { op: "link"; from: number; to: number; relation: DreamLinkRelation; reason: string }
  | { op: "decay"; id: number; reason: string }
  | {
      op: "propose-skill";
      procedure: string;
      /** How many commands the procedure has, and the tasks it recurred in. */
      steps: number;
      tasks: number[];
      /** The drafted name and description, hashed. */
      textHash: string;
      textLength: number;
      reason: string;
    }
) & {
  applied?: AppliedFootprint;
  reverted?: true;
  /** Set on a propose-tier op (a restatement, a skill draft — and EVERY op of a pool dream). */
  proposal?: ProposalMark;
};

export interface DreamChecks {
  proposed: number;
  accepted: number;
  rejected: number;
  /** Records that would leave the active set, and the region size they are measured against. */
  leaving: number;
  regionSize: number;
  probesBefore: { pass: number; fail: number };
  /** Probes re-run on the dry-applied view (null when nothing would leave). */
  probesAfter?: { pass: number; fail: number } | null;
}

export interface DreamSummary {
  id?: number;
  entityName: string;
  trigger: DreamTrigger;
  mode: DreamMode;
  state: "observed" | "applied" | "dry-run" | "skipped";
  /** Why nothing ran (schedule gates, budget, no material, no model). */
  skipped?: string;
  region?: { records: number; newRecords: number; bytes: number; hash: string };
  ops?: StoredDreamOp[];
  rejected?: RejectedOp[];
  probes?: DreamProbe[];
  checks?: DreamChecks;
  model?: string;
  spendUsd?: number;
  /** Proposals filed for the owner (`on` only): restatements and skill drafts. */
  proposals?: number;
  createdAt: number;
}
