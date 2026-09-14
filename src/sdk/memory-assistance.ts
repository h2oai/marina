// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryAnswer, MemoryAnswerContract } from "./memory-answer";
import type { MemoryOperationRequest } from "./memory-operations";

/** Adoption closes the loop: the requester (or a writer on a shared target)
 * turns an `answered` proposal into a versioned record with the `adopt`
 * operation (`POST /assistance/:id/adopt`, `/spaces/:space/adopt`, world
 * `memory adopt <ID>`). Adopting into an institutional space is a ratification
 * (standing-gated, `metadata.ratified_by`). Standing credit lands on the
 * helper — see `MemoryAdoptInput` / `MemoryAdoptResult` in `memory-types`. */
export type { MemoryAdoptInput, MemoryAdoptResult, MemoryRatifiedBy } from "./memory-types";

export const MEMORY_HELPER_ROLES = ["librarian", "reflector", "evaluator"] as const;
export type MemoryHelperRole = (typeof MEMORY_HELPER_ROLES)[number];

/** Assistance is explicitly delegated reading and a cited proposal, never a
 * grant to edit the requester's memories or to certify a claim as true. */
export interface MemoryAssistanceInput {
  worker_id: string;
  role: MemoryHelperRole;
  task: string;
  max_operations?: number;
  timeout_ms?: number;
}
export interface MemoryAssistanceJob {
  id: string;
  space_id: string;
  requester_id: string;
  worker_id: string;
  role: MemoryHelperRole;
  parent_id: string | null;
  root_id: string;
  depth: number;
  state: "pending" | "running" | "answered" | "abstained" | "cancelled";
  /** Live deadline/ancestor projection; state retains the last recorded transition. */
  work_open: boolean;
  version: number;
  lease_until: number | null;
  deadline: number;
  remaining_operations: number;
  input_source_id: string;
  result_record_id: string | null;
  created_at: number;
  task?: string;
  result?: MemoryAnswer;
}
export interface MemoryAssistanceListInput {
  open?: boolean;
  limit?: number;
  cursor?: string;
}
export interface MemoryAssistancePage {
  jobs: MemoryAssistanceJob[];
  next_cursor: string | null;
}
export const MEMORY_ASSISTANCE_READS = [
  "search",
  "query",
  "graph",
  "get",
  "source_search",
  "source_range",
  "vocabulary",
  "review",
] as const satisfies readonly MemoryOperationRequest["operation"][];

export const MEMORY_ASSISTANCE_CONTRACT: MemoryAnswerContract = {
  schema: {
    type: "string",
    description:
      "A concise evidence packet, proposed lesson, or evaluation with limitations and uncertainty.",
  },
  evidence: "required",
};

export const MEMORY_HELPER_INSTRUCTIONS: Record<MemoryHelperRole, string> = {
  librarian:
    "Find evidence relevant to the requested task. Try alternative vocabulary and explicit relationships when lexical search misses. Read original source ranges. Return an evidence packet with what is known, conflicts, applicability, and remaining uncertainty. Do not invent a fact or treat a search miss as proof of absence.",
  reflector:
    "Compare the attempted work with observed outcomes. Propose one small reusable lesson with prerequisites, exceptions, and a way to test it. Preserve distinctions between observations and inference. Read the original evidence; repeated assertions are not independent corroboration. If no observed outcome supports a lesson, abstain. Your result is a proposal, not permission to rewrite or delete memories.",
  evaluator:
    "Independently inspect the task and evidence. Find the original methodology with source_search and read it with source_range; search alone only searches authored records. Match the evidence to the specific claim being evaluated, not merely the same project. Identify support, contradictions, stale premises, missing controls, and limits of any claimed improvement. Separate mechanical citation validity from semantic support. Do not certify performance from an agent's self-report. Where possible specify a falsifiable test and expected observation. Your judgment is attributed opinion, not verified truth.",
};
