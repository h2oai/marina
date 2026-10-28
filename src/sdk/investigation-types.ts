// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Client-safe service envelopes. They describe recorded work, not an agent's strategy. */
export const INVESTIGATION_SCHEMA = "marina.investigation.v1" as const;

export type InvestigationKind = "prediction" | "research";
export type InvestigationState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type InvestigationAccess = "read" | "work";
export type PredictionShape =
  | { type: "binary" }
  | { type: "number"; unit?: string }
  | { type: "choice"; options: Array<{ id: string; label: string }> };

export interface InvestigationLimits {
  calls: number;
  concurrency: number;
  timeoutMs: number;
}

export interface InvestigationRequest {
  kind: InvestigationKind;
  question: string;
  answer?: PredictionShape;
  context?: string;
  horizon?: string;
  asOf?: string;
  /** Existing case for a new attempt; prior results remain immutable. */
  caseId?: string;
  /** An owned child while its parent runs; otherwise a new episode referencing prior work. */
  parentAttemptId?: string;
  runs?: number;
  limits?: Partial<InvestigationLimits>;
}

export interface InvestigationActor {
  /** Authenticated durable account, never a caller-supplied display name. */
  key: string;
  name: string;
}

export interface InvestigationSource {
  id: string;
  url: string;
  title?: string;
}

export interface InvestigationReason {
  actor: string;
  text: string;
  /** Only declared citations; proximity to a source is not entailment. */
  sourceIds: string[];
}

export type PredictionEstimate =
  | { type: "binary"; probability?: number }
  | { type: "number"; value?: number; sd?: number; unit?: string }
  | {
      type: "choice";
      selected?: string;
      options: Array<{ id: string; label: string; probability?: number }>;
    };

export interface InvestigationResult {
  schema: typeof INVESTIGATION_SCHEMA;
  kind: InvestigationKind;
  summary: string;
  availability: "final" | "partial" | "none";
  estimate?: PredictionEstimate;
  report?: string;
  reasons: InvestigationReason[];
  sources: InvestigationSource[];
  limitations: string[];
  horizon?: string;
  cutoff?: string;
  answerId?: number;
  /** Raw executor output is private content, loaded separately from a compact result. */
  outputId?: string;
  capture: { status: "complete" | "partial"; gaps: string[] };
  accounting: {
    knownUsd: number;
    complete: boolean;
    outstanding: number;
    /** Coverage gaps are independent of outstanding calls and answer availability. */
    reasons?: string[];
    pricedCalls?: number;
    unknownCalls?: number;
    /** Adapter totals can overlap; retained for diagnosis, never added to receipts. */
    reportedUsd?: number;
  };
}

export interface InvestigationAttempt {
  id: string;
  caseId: string;
  actor: InvestigationActor;
  parentAttemptId?: string;
  rootAttemptId: string;
  request: InvestigationRequest;
  state: InvestigationState;
  generation?: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  /** Mutable settlement, separate from the immutable answer (including after cancellation). */
  accounting: InvestigationResult["accounting"];
  result?: InvestigationResult;
  error?: string;
}

export interface InvestigationCase {
  schema: typeof INVESTIGATION_SCHEMA;
  id: string;
  instanceId: string;
  owner: InvestigationActor;
  kind: InvestigationKind;
  question: string;
  selectedAttemptId: string;
  currentAttemptId?: string;
  createdAt: number;
  updatedAt: number;
  access: "owner" | InvestigationAccess;
}

export interface InvestigationSnapshot {
  case: InvestigationCase;
  attempt: InvestigationAttempt;
  attempts: Array<Pick<InvestigationAttempt, "id" | "state" | "createdAt" | "actor">>;
  /** Cursor and state are read in one transaction. */
  cursor: number;
  children: Array<{
    caseId: string;
    attemptId: string;
    question: string;
    state: InvestigationState;
  }>;
  resolution?: { at: number; value: unknown; loss: number | null };
  grants?: Array<{ name: string; access: InvestigationAccess }>;
}

export interface InvestigationEvent {
  attemptId: string;
  sequence: number;
  at: number;
  kind: string;
  actor: string;
  stageId?: string;
  inputId?: string;
  outputId?: string;
  message?: string;
}

export interface InvestigationContent {
  id: string;
  attemptId: string;
  label: string;
  value: unknown;
  bytes: number;
  hash: string;
  createdAt: number;
}

export interface InvestigationEventPage {
  events: InvestigationEvent[];
  cursor: number;
  more: boolean;
  reset: boolean;
}

export function investigationTerminal(state: InvestigationState): boolean {
  return state !== "queued" && state !== "running";
}
