// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TaskArtifact } from "./task-artifact";

export type WorkValue = string | number | boolean | null;
export type WorkPatch = Record<string, WorkValue>;

export interface WorkEntry {
  id: string;
  authorId: string;
  retired?: { authorId: string; reason: string };
}

export interface WorkCitation extends WorkEntry {
  field: string;
  ref: string;
  sourceVersion: string;
  /** Character offsets into the full source. No private quotation is copied. */
  start: number;
  end: number;
}

export interface WorkConstraint extends WorkEntry {
  field: string;
  op: "eq" | "lte" | "gte" | "oneOf";
  expected: WorkValue | WorkValue[];
  citation: string;
}

export interface WorkProposal extends WorkEntry {
  patch: WorkPatch;
  /** A field's absence differs from a field whose value is null. */
  base: Record<string, { present: boolean; value?: WorkValue; revision: number }>;
  accepted?: { authorId: string };
}

export interface TaskWorkDocument {
  format: 1;
  fields: WorkPatch;
  fieldRevisions: Record<string, number>;
  citations: WorkCitation[];
  constraints: WorkConstraint[];
  proposals: WorkProposal[];
  /** Optional canonical JSON deliverable; old scalar work records remain compatible. */
  artifact?: TaskArtifact;
}

export type WorkAction =
  | { kind: "patch"; patch: WorkPatch }
  | { kind: "propose"; patch: WorkPatch }
  | { kind: "accept"; id: string }
  | { kind: "cite"; field: string; ref: string; quote: string }
  | {
      kind: "expect";
      field: string;
      op: WorkConstraint["op"];
      expected: WorkValue | WorkValue[];
      citation: string;
    }
  | { kind: "retire"; id: string; reason: string };

export type CitationStatus =
  | "current"
  | "changed"
  | "unavailable"
  | "superseded"
  | "disputed"
  | "retired";

export interface WorkCheckReport {
  contract: "declared-task-work-v1";
  revision: number;
  outcome: "consistent" | "discrepancies" | "unverified";
  citations: Array<{ id: string; field: string; ref: string; status: CitationStatus }>;
  checks: Array<{
    id: string;
    field: string;
    status: "matches" | "contradiction" | "unverified";
    actual?: WorkValue;
    expected: WorkValue | WorkValue[];
    op: WorkConstraint["op"];
    citation: string;
  }>;
  uncheckedFields: string[];
  pendingProposals: string[];
  scope: string;
}
