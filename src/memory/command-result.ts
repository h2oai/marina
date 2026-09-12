// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CoreMemoryRow, NoteRow } from "../persistence/database";
import type { Perception } from "../types";

export interface MemoryNoteResult {
  id: string;
  content: string;
  importance: number;
  noteType: string;
  score?: number;
  age?: string;
}

export type MemoryOperation =
  | "recall"
  | "pool-recall"
  | "skill-search"
  | "core-get"
  | "core-set"
  | "core-delete";

export interface MemoryCommandResult {
  schema: "marina.memory.command.v1";
  operation: MemoryOperation;
  success: boolean;
  notes?: MemoryNoteResult[];
  entry?: CoreMemoryRow;
  error?: string;
}

/** Additive machine data; human command rendering is deliberately independent. */
export function memoryResult(
  operation: MemoryOperation,
  result: Omit<MemoryCommandResult, "schema" | "operation">,
): Record<string, unknown> {
  return {
    memory: {
      schema: "marina.memory.command.v1",
      operation,
      ...result,
    } satisfies MemoryCommandResult,
  };
}

export function memoryNoteResults(notes: (NoteRow & { score?: number })[]): MemoryNoteResult[] {
  return notes.map((note) => ({
    id: String(note.id),
    content: note.content,
    importance: note.importance,
    noteType: note.note_type,
    score: note.score,
    age: `${Math.max(0, Math.floor((Date.now() - note.created_at) / 86_400_000))}d`,
  }));
}

export function readMemoryResult(
  perceptions: Perception[],
  operation: MemoryOperation,
): MemoryCommandResult | undefined {
  for (const perception of perceptions) {
    const data = perception.data.memory;
    if (!data || typeof data !== "object") continue;
    const value = data as Partial<MemoryCommandResult>;
    if (
      value.schema !== "marina.memory.command.v1" ||
      value.operation !== operation ||
      typeof value.success !== "boolean"
    )
      continue;
    if (
      value.notes !== undefined &&
      (!Array.isArray(value.notes) ||
        !value.notes.every(
          (note) =>
            note &&
            typeof note.id === "string" &&
            typeof note.content === "string" &&
            typeof note.noteType === "string" &&
            typeof note.importance === "number",
        ))
    )
      continue;
    if (
      value.entry !== undefined &&
      (!value.entry ||
        typeof value.entry.value !== "string" ||
        typeof value.entry.key !== "string" ||
        typeof value.entry.version !== "number")
    )
      continue;
    return value as MemoryCommandResult;
  }
  return undefined;
}
