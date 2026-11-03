// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export type { AdoptOutcome, DreamProposal } from "./apply";
export {
  adoptProposal,
  applyOps,
  createSkillDraft,
  DECAY_STEP,
  dismissProposal,
  PROPOSAL_OWNER,
  PROPOSAL_TTL_MS,
  pendingProposals,
  procedureCovered,
  rollbackDream,
} from "./apply";
export { checkOps, leavingIds, opIds } from "./check";
export {
  assessDream,
  assessDreams,
  assessmentOf,
  clearGuard,
  GUARD_K,
  GUARD_MARGIN,
  GUARD_TRIP_AFTER,
  guardState,
  guardTripped,
} from "./guard";
export type { JournalEpisode } from "./journal";
export {
  DREAM_JOURNAL_MAX_BYTES,
  DREAM_MIN_JOURNAL_BYTES,
  gatherEpisodes,
  journalBytesSince,
  parseEpisode,
  renderEpisodes,
  residentSpaceIds,
} from "./journal";
export {
  DREAM_SETTLE_MS,
  dreamJudgeApplies,
  dreamJudgeName,
  recordDreamOpinions,
  settleDreamOp,
  settleQuietDreams,
} from "./judge";
export { dreamEffect, MEASURE_MIN, renderDreamEffect } from "./measure";
export {
  budgetGate,
  DREAM_COOLDOWN_MS,
  DREAM_IDLE_MS,
  DREAM_MIN_NEW,
  dreamCandidates,
  dreamingMode,
  poolDreamCandidates,
  runDream,
  runDreamSchedule,
  runRequestedDreams,
  scheduleGate,
} from "./pass";
export { probePlan, probeQuery, probeSpan, probesBefore } from "./probe";
export type { ProcedureCandidate } from "./procedures";
export {
  commandSequence,
  gatherProcedures,
  PROCEDURE_MAX_STEPS,
  PROCEDURE_MIN_STEPS,
  PROCEDURE_MIN_TASKS,
  procedureKey,
} from "./procedures";
export { DREAM_SYSTEM_PROMPT, parseOps, proposeOps, regionPrompt } from "./propose";
export { gatherRegion } from "./region";
export type { DreamRequest } from "./request";
export {
  clearRequest,
  DREAM_COMPACTION_MIN_MESSAGES,
  pendingRequest,
  pendingRequests,
  REQUEST_TTL_MS,
  requestDream,
} from "./request";
export type { DreamScope } from "./scope";
export { inScope, isPoolScopeName, poolScopeName, scopeOf, scopeRecall } from "./scope";
export type * from "./types";
