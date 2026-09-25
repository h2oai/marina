// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  CodingArtifactRow,
  CodingEventRow,
  CodingRunQuery,
  CodingSessionRow,
} from "../db-coding";
import type { ExactKeys } from "./exact-keys";

/** Coding sessions, events and artifacts (`db-coding.ts`). */
export interface CodingStore {
  createCodingSession(session: {
    id: string;
    title: string;
    workspaceRoot: string;
    status?: string;
    mode?: string;
    createdBy: string;
  }): CodingSessionRow;
  getCodingSession(id: string): CodingSessionRow | null;
  listCodingSessions(createdBy?: string, limit?: number): CodingSessionRow[];
  updateCodingSession(
    id: string,
    patch: Partial<{
      status: string;
      mode: string;
      title: string;
      writer: string | null;
      agent: string | null;
      driver: string | null;
      executionTarget: "local" | "flywheel";
      worktreePath: string | null;
      worktreeBranch: string | null;
    }>,
  ): void;
  createCodingEvent(event: {
    id?: string;
    sessionId: string;
    actor: string;
    kind: string;
    payload: unknown;
  }): CodingEventRow;
  listCodingEvents(sessionId: string, limit?: number): CodingEventRow[];
  createCodingArtifact(artifact: {
    id?: string;
    sessionId: string;
    kind: string;
    title: string;
    status?: string;
    contentText: string;
    metadata?: unknown;
    createdBy: string;
  }): CodingArtifactRow;
  listCodingRuns(query?: CodingRunQuery): CodingArtifactRow[];
  listCodingRunArtifacts(runId: string): CodingArtifactRow[];
  getCodingArtifact(id: string): CodingArtifactRow | null;
  listCodingArtifacts(sessionId: string, limit?: number): CodingArtifactRow[];
  updateCodingArtifact(
    id: string,
    patch: Partial<{
      appliedAt: number | null;
      appliedBy: string | null;
      metadata: unknown;
      status: string;
    }>,
  ): void;
}

/** Runtime mirror of `CodingStore`'s method names — the drift test compares it to the facade. */
export const CODING_STORE_METHODS = [
  "createCodingSession",
  "getCodingSession",
  "listCodingSessions",
  "updateCodingSession",
  "createCodingEvent",
  "listCodingEvents",
  "createCodingArtifact",
  "getCodingArtifact",
  "listCodingRuns",
  "listCodingRunArtifacts",
  "listCodingArtifacts",
  "updateCodingArtifact",
] as const satisfies readonly (keyof CodingStore)[];

export const CODING_STORE_COMPLETE: ExactKeys<CodingStore, typeof CODING_STORE_METHODS> = true;
