// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Edge } from "@xyflow/react";
import type { RecallTrace } from "../../lib/types";

/**
 * How long a recall path stays visible on the map (ms). The UnifiedCanvas
 * ticks periodically while any trace is within this window so the fade
 * animates smoothly and edges naturally drop out when they expire.
 */
export const RECALL_PATH_LIFETIME_MS = 6000;

/** Data attached to a RecallPath edge. Read by the edge component. */
export interface RecallPathEdgeData {
  /** Timestamp the trace was recorded — drives fade. */
  createdAt: number;
  /** Agent / entity name that performed the recall. */
  entity: string;
  /** The query text — shown in the pill at the source side of the path. */
  query: string;
  /**
   * True for the first edge in a trace only. Prevents the query pill
   * from being rendered once per activated note (which would be loud
   * and overlapping on wide fans).
   */
  showLabel: boolean;
  /** Total activated notes in this trace — shown alongside the pill. */
  activatedCount: number;
  /** Was this note a seed (the agent's top-of-mind recall) vs. a spreading-activation hit? */
  seed: boolean;
}

/**
 * Build ReactFlow edges rendering the `recall_trace` memory stream as
 * amber paths on the unified canvas: entity room → each activated note.
 *
 * The first activated-note edge carries `showLabel: true` so the query
 * text renders once at the source side; subsequent edges share the path
 * but no longer duplicate the pill.
 *
 * Edges are only emitted when both endpoints resolve:
 *   - entity has a known current room, AND that room is in `roomNodeIds`
 *   - the activated note has a position in `notePositions`
 *
 * Expired traces (age > RECALL_PATH_LIFETIME_MS) produce no edges.
 */
export function buildRecallPathEdges(
  traces: readonly RecallTrace[],
  entityRooms: Record<string, string>,
  roomNodeIds: ReadonlySet<string>,
  notePositions: ReadonlyMap<number, unknown>,
  now: number,
): Edge[] {
  const edges: Edge[] = [];

  for (const trace of traces) {
    const age = now - trace.timestamp;
    if (age < 0 || age >= RECALL_PATH_LIFETIME_MS) continue;

    const sourceRoom = entityRooms[trace.entity];
    if (!sourceRoom || !roomNodeIds.has(sourceRoom)) continue;

    if (trace.activatedNoteIds.length === 0) continue;

    const seedSet = new Set(trace.seedNoteIds);
    let labeled = false;

    for (const noteId of trace.activatedNoteIds) {
      if (!notePositions.has(noteId)) continue;

      const showLabel = !labeled;
      labeled = true;

      const data: RecallPathEdgeData = {
        createdAt: trace.timestamp,
        entity: trace.entity,
        query: trace.query,
        showLabel,
        activatedCount: trace.activatedNoteIds.length,
        seed: seedSet.has(noteId),
      };

      edges.push({
        id: `recall-${trace.timestamp}-${noteId}`,
        source: sourceRoom,
        target: `note-${noteId}`,
        type: "recallPath",
        data: data as unknown as Record<string, unknown>,
      });
    }
  }

  return edges;
}

/**
 * True if any trace in the list is still within its render window.
 * Used to gate the UnifiedCanvas tick timer — we only need to re-render
 * for fade animation while at least one path is live.
 */
export function hasLiveRecallTrace(traces: readonly RecallTrace[], now: number): boolean {
  for (const t of traces) {
    if (now - t.timestamp < RECALL_PATH_LIFETIME_MS) return true;
  }
  return false;
}
