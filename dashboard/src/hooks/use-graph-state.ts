// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import type {
  DashboardEvent,
  GraphLink,
  GraphNote,
  GraphSnapshot,
  RecallTrace,
} from "../lib/types";

/** Keys a link uniquely — relationships are directional + typed. */
function linkKey(sourceId: number, targetId: number, relationship: string): string {
  return `${sourceId}|${targetId}|${relationship}`;
}

/** Event types that mutate the knowledge graph. Routed in use-websocket. */
export const GRAPH_EVENT_TYPES = new Set([
  "note_created",
  "note_deleted",
  "note_link_created",
  "note_link_deleted",
  "recall_trace",
]);

interface GraphState {
  notes: Map<number, GraphNote>;
  links: Map<string, GraphLink>;
  /** Most recent recall traces, newest first. Capped. */
  recentTraces: RecallTrace[];
  /** True once a snapshot has been merged — gates the "loading" state. */
  snapshotLoaded: boolean;

  setSnapshot: (snap: GraphSnapshot) => void;
  applyEvent: (event: DashboardEvent) => void;
  reset: () => void;
}

const MAX_TRACES = 20;

export const useGraphState = create<GraphState>((set) => ({
  notes: new Map(),
  links: new Map(),
  recentTraces: [],
  snapshotLoaded: false,

  setSnapshot: (snap) =>
    set(() => {
      const notes = new Map<number, GraphNote>();
      for (const n of snap.notes) notes.set(n.id, n);
      const links = new Map<string, GraphLink>();
      for (const l of snap.links) links.set(linkKey(l.sourceId, l.targetId, l.relationship), l);
      return { notes, links, snapshotLoaded: true };
    }),

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case "note_created": {
          if (event.noteId === undefined) return state;
          const note: GraphNote = {
            id: event.noteId,
            entityName: event.authorName ?? event.entity ?? "unknown",
            content: event.content ?? "",
            importance: event.importance ?? 5,
            noteType: event.noteType ?? "observation",
            createdAt: event.timestamp,
            lastAccessed: event.timestamp,
            roomId: event.roomId ?? null,
            poolId: event.poolId ?? null,
          };
          const notes = new Map(state.notes);
          notes.set(note.id, note);
          return { notes };
        }
        case "note_deleted": {
          if (event.noteId === undefined) return state;
          const notes = new Map(state.notes);
          notes.delete(event.noteId);
          // Also drop any link touching this note
          const links = new Map(state.links);
          for (const [key, link] of links) {
            if (link.sourceId === event.noteId || link.targetId === event.noteId) {
              links.delete(key);
            }
          }
          return { notes, links };
        }
        case "note_link_created": {
          if (event.sourceId === undefined || event.targetId === undefined || !event.relationship) {
            return state;
          }
          const link: GraphLink = {
            sourceId: event.sourceId,
            targetId: event.targetId,
            relationship: event.relationship,
          };
          const links = new Map(state.links);
          links.set(linkKey(link.sourceId, link.targetId, link.relationship), link);
          return { links };
        }
        case "note_link_deleted": {
          if (event.sourceId === undefined || event.targetId === undefined || !event.relationship) {
            return state;
          }
          const links = new Map(state.links);
          links.delete(linkKey(event.sourceId, event.targetId, event.relationship));
          return { links };
        }
        case "recall_trace": {
          const trace: RecallTrace = {
            entity: event.entity ?? "unknown",
            query: event.query ?? "",
            seedNoteIds: event.seedNoteIds ?? [],
            activatedNoteIds: event.activatedNoteIds ?? [],
            timestamp: event.timestamp,
          };
          // Bump lastAccessed on activated notes so decay resets visually
          const notes = new Map(state.notes);
          for (const id of trace.activatedNoteIds) {
            const existing = notes.get(id);
            if (existing) notes.set(id, { ...existing, lastAccessed: event.timestamp });
          }
          return {
            notes,
            recentTraces: [trace, ...state.recentTraces].slice(0, MAX_TRACES),
          };
        }
        default:
          return state;
      }
    }),

  reset: () => set({ notes: new Map(), links: new Map(), recentTraces: [], snapshotLoaded: false }),
}));

/** Fetch the initial graph snapshot — call once on connect. */
export async function loadGraphSnapshot(limit = 500): Promise<void> {
  const res = await fetch(`/api/graph?limit=${limit}`, { credentials: "same-origin" });
  if (!res.ok) return;
  const snap = (await res.json()) as GraphSnapshot;
  useGraphState.getState().setSnapshot(snap);
}
