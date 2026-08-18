// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Global search across the unified world state.
 *
 * Searches entities, rooms, canvas nodes, and projects by name, type,
 * district, model, focus, rank, and title. Returns categorized results
 * ordered by relevance (exact match first, then prefix, then substring).
 */

import type { Node } from "@xyflow/react";

/** Canvas content node types — kept in sync with nodeTypes registered in UnifiedCanvas. */
const CANVAS_CONTENT_TYPES = new Set([
  "text",
  "image",
  "video",
  "audio",
  "pdf",
  "document",
  "frame",
  "a2ui",
  "embed",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single search result with type and navigable target. */
export interface SearchResult {
  /** Category of the result. */
  category: "entity" | "room" | "canvas" | "project";
  /** Display label for the result. */
  label: string;
  /** Secondary description text. */
  detail: string;
  /** ID used for navigation (entity name, room ID, canvas node ID). */
  targetId: string;
}

/** World state shape needed for search. */
export interface SearchableWorldState {
  /** All entities currently in the world. */
  entities: {
    name: string;
    kind: string;
    room: string;
    agentStatus?: {
      model?: string;
      focus?: string | null;
      state?: string;
      role?: string;
      supports?: {
        text: boolean;
        image?: boolean;
        video?: boolean;
      };
    };
    rank?: number;
  }[];
  /** All rooms in the world. */
  rooms: {
    id: string;
    short: string;
    district: string;
  }[];
  /** ReactFlow nodes (includes both room and canvas nodes). */
  flowNodes: Node[];
  /** Projects (optional, may not be loaded). */
  projects?: {
    name: string;
    status: string;
    description: string;
  }[];
}

// ── Search implementation ────────────────────────────────────────────────────

/**
 * Score a match: 3 for exact (case-insensitive), 2 for prefix, 1 for substring.
 * Returns 0 if no match.
 */
function matchScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 3;
  if (h.startsWith(n)) return 2;
  if (h.includes(n)) return 1;
  return 0;
}

/**
 * Search across entities, rooms, canvas nodes, and projects.
 *
 * @param query - The search string (trimmed, non-empty).
 * @param state - Current world state to search through.
 * @returns Array of search results, sorted by relevance.
 */
export function searchWorld(query: string, state: SearchableWorldState): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: { result: SearchResult; score: number }[] = [];

  // Search entities by name, kind, model, focus, role
  for (const e of state.entities) {
    const fields = [
      e.name,
      e.kind,
      e.room,
      e.agentStatus?.model ?? "",
      e.agentStatus?.focus ?? "",
      e.agentStatus?.role ?? "",
      e.agentStatus?.state ?? "",
      e.rank !== undefined ? `rank ${e.rank}` : "",
    ];
    let best = 0;
    for (const f of fields) {
      if (f) best = Math.max(best, matchScore(f, q));
    }
    if (best > 0) {
      const status = e.agentStatus?.state ?? e.kind;
      const model = e.agentStatus?.model ? ` [${e.agentStatus.model}]` : "";
      scored.push({
        result: {
          category: "entity",
          label: e.name,
          detail: `${status}${model} in ${e.room}`,
          targetId: e.name,
        },
        score: best + (e.name.toLowerCase() === q ? 10 : 0),
      });
    }
  }

  // Search rooms by name, district
  for (const r of state.rooms) {
    const fields = [r.id, r.short, r.district];
    let best = 0;
    for (const f of fields) {
      best = Math.max(best, matchScore(f, q));
    }
    if (best > 0) {
      scored.push({
        result: {
          category: "room",
          label: r.short,
          detail: `${r.district} district`,
          targetId: r.id,
        },
        score: best,
      });
    }
  }

  // Search canvas nodes by title, type
  for (const node of state.flowNodes) {
    if (!node.type || !CANVAS_CONTENT_TYPES.has(node.type)) continue;
    const d = node.data as { title?: string; canvasId?: string } | undefined;
    if (!d) continue;
    const title = d.title ?? node.type;
    const fields: (string | undefined)[] = [d.title, node.type, d.canvasId];
    let best = 0;
    for (const f of fields) {
      if (f) best = Math.max(best, matchScore(f, q));
    }
    if (best > 0) {
      scored.push({
        result: {
          category: "canvas",
          label: title,
          detail: `${node.type} node`,
          targetId: node.id,
        },
        score: best,
      });
    }
  }

  // Search projects by name
  if (state.projects) {
    for (const p of state.projects) {
      const fields = [p.name, p.description, p.status];
      let best = 0;
      for (const f of fields) {
        if (f) best = Math.max(best, matchScore(f, q));
      }
      if (best > 0) {
        scored.push({
          result: {
            category: "project",
            label: p.name,
            detail: `project (${p.status})`,
            targetId: p.name,
          },
          score: best,
        });
      }
    }
  }

  // Sort by score descending, then alphabetically
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.result.label.localeCompare(b.result.label);
  });

  return scored.map((s) => s.result).slice(0, 20);
}

/**
 * Check whether a raw command string is a search command.
 * Returns the query string if it is, or null if not.
 */
export function parseSearchCommand(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("?")) {
    const q = trimmed.slice(1).trim();
    return q || null;
  }
  const match = trimmed.match(/^(?:search|find)\s+(.+)/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * Format search results as displayable text lines.
 */
export function formatSearchResults(results: SearchResult[]): string[] {
  if (results.length === 0) return ["No results found."];
  const lines: string[] = [`Found ${results.length} result(s):`];
  for (const r of results) {
    const badge = r.category.toUpperCase().padEnd(7);
    lines.push(`  [${badge}] ${r.label} -- ${r.detail}`);
  }
  return lines;
}
