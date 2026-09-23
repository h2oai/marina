// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { NoteTier } from "../../engine/constants";
import type * as notesDb from "../db-notes";
import type {
  CoreMemoryHistoryRow,
  CoreMemoryRow,
  MemApiKeyRow,
  MemoryPoolRow,
  NoteLinkRow,
  NoteRow,
  ScoredNoteRow,
} from "../db-notes";
import type { ExactKeys } from "./exact-keys";

/** Legacy notes, core memory, note links, pools and memory API keys (`db-notes.ts`). */
export interface NotesStore {
  createNote(
    entityName: string,
    content: string,
    roomId?: string,
    opts?: {
      importance?: number;
      noteType?: string;
      poolId?: string;
      supersedesId?: number;
      tier?: NoteTier;
      skipDedup?: boolean;
      confidence?: number;
      verificationStatus?: string;
      claimKey?: string;
    },
  ): number;
  getNotesByEntity(entityName: string, limit?: number): NoteRow[];
  getNotesByType(entityName: string, noteType: string, limit?: number): NoteRow[];
  createNoteWithLinks(
    entityName: string,
    content: string,
    opts: { importance?: number; noteType?: string },
    links: { target: number; relationship: string }[],
  ): number;
  reviseNote(
    entityName: string,
    noteId: number,
    content: string,
    opts?: { importance?: number; noteType?: string },
  ): number | undefined;
  getNotesByRoom(roomId: string, limit?: number): NoteRow[];
  searchNotes(entityName: string, query: string): NoteRow[];
  deleteNote(id: number, entityName: string): boolean;
  getNote(id: number): NoteRow | undefined;
  /** Batch read of every existing note among `ids` (one `IN (…)` per 500-id chunk). */
  getNotes(ids: number[]): NoteRow[];
  addNoteSource(noteId: number, source: notesDb.NoteSourceInput): number;
  getNoteSources(noteId: number): notesDb.NoteSourceRow[];
  getNotesBySourceUrl(url: string, entityName?: string, limit?: number): NoteRow[];
  recordNoteVerification(
    noteId: number,
    verifier: string,
    status: "unverified" | "verified" | "disputed",
    confidence: number,
    rationale?: string,
    evidenceSourceId?: number,
  ): number;
  getNoteVerifications(noteId: number): notesDb.NoteVerificationRow[];
  refreshContradictionCases(): number;
  getContradictionCase(id: number): notesDb.ContradictionCaseRow | undefined;
  listContradictionCases(
    status?: "open" | "resolved",
    limit?: number,
  ): notesDb.ContradictionCaseRow[];
  resolveContradictionCase(
    id: number,
    resolution: "left" | "right" | "both" | "neither",
    resolvedBy: string,
    rationale: string,
  ): boolean;
  updateNoteQuality(
    id: number,
    entityName: string,
    confidence: number,
    verification: string,
  ): boolean;
  findMemoryContradictions(entityName: string): notesDb.ContradictionCandidate[];
  consolidateNotes(entityName: string, keeperId: number, duplicateIds: number[]): number;
  getMemoryQualitySummary(entityName?: string): {
    total: number;
    unverified: number;
    disputed: number;
    superseded: number;
    staleSources: number;
    contradictions: number;
  };
  touchNote(id: number): void;
  recallNotes(
    entityName: string,
    query: string,
    opts?: {
      weightImportance?: number;
      weightRecency?: number;
      weightRelevance?: number;
      includeProcess?: boolean;
    },
  ): ScoredNoteRow[];
  recallNotesWithType(
    entityName: string,
    query: string,
    noteType: string,
    opts?: { weightImportance?: number; weightRecency?: number; weightRelevance?: number },
  ): ScoredNoteRow[];
  /** Find existing notes similar to content (for auto-linking) */
  findSimilarNotes(entityName: string, content: string, excludeId?: number): NoteRow[];
  /** Count total and fading matches for a query (beyond the top-20 recall returns) */
  countMatchingNotes(entityName: string, query: string): { total: number; fading: number };
  adjustNoteImportance(): { boosted: number; decayed: number };
  calibrateMemoryConfidence(): number;
  setCoreMemory(entityName: string, key: string, value: string): void;
  getCoreMemory(entityName: string, key: string): CoreMemoryRow | undefined;
  listCoreMemory(entityName: string): CoreMemoryRow[];
  deleteCoreMemory(entityName: string, key: string): boolean;
  getCoreMemoryHistory(entityName: string, key: string, limit?: number): CoreMemoryHistoryRow[];
  createNoteLink(sourceId: number, targetId: number, relationship: string): number;
  getNoteLinks(noteId: number): NoteLinkRow[];
  searchAllNotes(query: string, limit?: number): NoteRow[];
  removeNoteLink(sourceId: number, targetId: number, relationship: string): boolean;
  getGraphSnapshot(limit?: number): { notes: NoteRow[]; links: NoteLinkRow[] };
  createMemoryPool(id: string, name: string, createdBy: string, groupId?: string): void;
  setMemoryPoolGroup(poolId: string, groupId: string | null): void;
  getMemoryPool(name: string): MemoryPoolRow | undefined;
  getMemoryPoolById(id: string): MemoryPoolRow | undefined;
  listMemoryPools(): MemoryPoolRow[];
  addPoolNote(
    poolId: string,
    entityName: string,
    content: string,
    importance?: number,
    noteType?: string,
    opts?: Parameters<typeof notesDb.addPoolNote>[6],
  ): number;
  getPoolNotes(poolId: string, limit?: number): NoteRow[];
  countPoolNotes(poolId: string): number;
  recallPoolNotes(
    poolId: string,
    query: string,
    opts?: {
      weightImportance?: number;
      weightRecency?: number;
      weightRelevance?: number;
      includeProcess?: boolean;
    },
  ): ScoredNoteRow[];
  createMemApiKey(id: string, secret: string, agentName: string): void;
  validateMemApiKey(secret: string): MemApiKeyRow | undefined;
  listMemApiKeys(): MemApiKeyRow[];
  deleteMemApiKey(id: string): boolean;
  /** Aggregate stats for an agent's memory namespace */
  getMemStats(agentName: string): { notes: number; links: number; coreKeys: number; pools: number };
  /** Count personal notes (excluding pool notes) for an entity, optionally filtered by type. */
  countNotes(entityName: string, noteType?: string): number;
}

/** Runtime mirror of `NotesStore`'s method names — the drift test compares it to the facade. */
export const NOTES_STORE_METHODS = [
  "createNote",
  "getNotesByEntity",
  "getNotesByType",
  "createNoteWithLinks",
  "reviseNote",
  "getNotesByRoom",
  "searchNotes",
  "deleteNote",
  "getNote",
  "getNotes",
  "addNoteSource",
  "getNoteSources",
  "getNotesBySourceUrl",
  "recordNoteVerification",
  "getNoteVerifications",
  "refreshContradictionCases",
  "getContradictionCase",
  "listContradictionCases",
  "resolveContradictionCase",
  "updateNoteQuality",
  "findMemoryContradictions",
  "consolidateNotes",
  "getMemoryQualitySummary",
  "touchNote",
  "recallNotes",
  "recallNotesWithType",
  "findSimilarNotes",
  "countMatchingNotes",
  "adjustNoteImportance",
  "calibrateMemoryConfidence",
  "setCoreMemory",
  "getCoreMemory",
  "listCoreMemory",
  "deleteCoreMemory",
  "getCoreMemoryHistory",
  "createNoteLink",
  "getNoteLinks",
  "searchAllNotes",
  "removeNoteLink",
  "getGraphSnapshot",
  "createMemoryPool",
  "setMemoryPoolGroup",
  "getMemoryPool",
  "getMemoryPoolById",
  "listMemoryPools",
  "addPoolNote",
  "getPoolNotes",
  "countPoolNotes",
  "recallPoolNotes",
  "createMemApiKey",
  "validateMemApiKey",
  "listMemApiKeys",
  "deleteMemApiKey",
  "getMemStats",
  "countNotes",
] as const satisfies readonly (keyof NotesStore)[];

export const NOTES_STORE_COMPLETE: ExactKeys<NotesStore, typeof NOTES_STORE_METHODS> = true;
