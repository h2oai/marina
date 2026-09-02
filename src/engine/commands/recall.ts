// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { creditRecalledReflections } from "../../agent/standing";
import type { TaskManager } from "../../coordination/task-manager";
import {
  bold,
  dim,
  fmtScore,
  header,
  id,
  importance,
  sectionHead,
  separator,
  status,
} from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import { DAY_MS } from "../constants";
import { extractFlags, extractModifiers } from "../parse-input";

/** One-line preview that cuts at a word boundary with an ellipsis instead of
 *  chopping mid-word (".. the readiness command is ex" reads like a bug). */
function previewText(s: string, max = 100): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return `${s.slice(0, cut > max * 0.6 ? cut : max)}…`;
}

/** Auto-detect query intent and return adjusted weights */
function detectIntent(query: string): {
  weightImportance: number;
  weightRecency: number;
  weightRelevance: number;
} | null {
  const q = query.toLowerCase();
  // Episodic: "when did", "last time", "yesterday", "earlier", "recently"
  if (/\b(when did|last time|yesterday|earlier|recently|just now|today)\b/.test(q)) {
    return { weightImportance: 0.15, weightRecency: 0.6, weightRelevance: 0.25 };
  }
  // Procedural: "how to", "how do", "steps to", "procedure", "method for"
  if (/\b(how to|how do|steps to|procedure|method for|way to|process)\b/.test(q)) {
    return { weightImportance: 0.2, weightRecency: 0.2, weightRelevance: 0.6 };
  }
  // Decision: "should I", "decide", "choice", "option", "trade-off"
  if (/\b(should i|decide|decision|choice|option|trade.?off|pros and cons)\b/.test(q)) {
    return { weightImportance: 0.5, weightRecency: 0.15, weightRelevance: 0.35 };
  }
  // Semantic: "what is", "define", "meaning of", "explain"
  if (/\b(what is|what are|define|meaning of|explain|tell me about)\b/.test(q)) {
    return { weightImportance: 0.4, weightRecency: 0.1, weightRelevance: 0.5 };
  }
  return null;
}

export function recallCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  logEvent?: (event: EngineEvent) => void;
  /** Resolve a note author's entity id so generational credit can flow to the
   *  WRITER of recalled wisdom, not the reader. */
  resolveEntityIdByName?: (name: string) => EntityId | undefined;
}): CommandDef {
  return {
    name: "recall",
    aliases: [],
    help: "Scored, provenance-aware retrieval. Usage: recall <query> [recent|important|trusted|explain] [type <type>]",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Recall requires database support.");
        return;
      }
      const db = deps.db;
      const args = input.args;
      if (!args) {
        ctx.send(input.entity, "Usage: recall <query> [recent | important] [type <type>]");
        return;
      }

      // Parse modifiers from the end of input
      let weightImportance = 0.33;
      let weightRecency = 0.33;
      let weightRelevance = 0.34;

      // Extract type modifier: "type <word>" or "--type <word>"
      const { text: afterType, modifiers } = extractModifiers(args, ["type"]);
      const noteType = modifiers.type;

      // Extract weight flags: trailing "recent"/"important" or "--recent"/"--important"
      const { text: query, flags } = extractFlags(afterType, [
        "recent",
        "important",
        "trusted",
        "explain",
      ]);

      if (flags.has("recent")) {
        weightImportance = 0.2;
        weightRecency = 0.6;
        weightRelevance = 0.2;
      } else if (flags.has("important")) {
        weightImportance = 0.6;
        weightRecency = 0.2;
        weightRelevance = 0.2;
      } else {
        // No explicit modifier — auto-detect intent from query phrasing
        const detected = detectIntent(query);
        if (detected) {
          weightImportance = detected.weightImportance;
          weightRecency = detected.weightRecency;
          weightRelevance = detected.weightRelevance;
        }
      }

      if (!query) {
        ctx.send(input.entity, "Usage: recall <query> [recent | important] [type <type>]");
        return;
      }

      const weights = { weightImportance, weightRecency, weightRelevance };
      let results = noteType
        ? db.recallNotesWithType(entity.name, query, noteType, weights)
        : db.recallNotes(entity.name, query, weights);
      if (flags.has("trusted")) {
        results = results.filter((note) => {
          const sources = db.getNoteSources(note.id);
          return (
            note.verification_status === "verified" ||
            ((note.confidence ?? 0.5) >= 0.7 && sources.some((source) => source.credibility >= 0.6))
          );
        });
      }

      // Graph-enhanced recall: spread activation from top results to linked notes
      if (results.length > 0 && results.length < 20) {
        const SPREAD_DAMPING = 0.3;
        const resultIds = new Set(results.map((r) => r.id));
        const linkedBoosts = new Map<number, number>();

        // Walk 1-hop links from top-5 results
        for (const note of results.slice(0, 5)) {
          const links = db.getNoteLinks(note.id);
          for (const link of links) {
            const linkedId = link.source_id === note.id ? link.target_id : link.source_id;
            if (!resultIds.has(linkedId)) {
              const boost = note.score * SPREAD_DAMPING;
              linkedBoosts.set(linkedId, Math.max(linkedBoosts.get(linkedId) ?? 0, boost));
            }
          }
        }

        // Fetch and insert graph-discovered notes
        if (linkedBoosts.size > 0) {
          for (const [noteId, boost] of linkedBoosts) {
            const linkedNote = db.getNote(noteId);
            if (linkedNote && linkedNote.entity_name === entity.name && !linkedNote.pool_id) {
              results.push({ ...linkedNote, score: boost } as (typeof results)[0]);
            }
          }
          // Re-sort by score and cap at 20
          results.sort((a, b) => b.score - a.score);
          results = results.slice(0, 20);
        }
      }

      // Touch each returned note to update last_accessed and recall_count,
      // then flow generational credit to the AUTHORS of any cross-entity
      // reflections surfaced (see creditRecalledReflections — the writer
      // earns, never the reader).
      for (const note of results) {
        db.touchNote(note.id);
      }
      if (deps.resolveEntityIdByName) {
        creditRecalledReflections(db, entity.name, results, deps.resolveEntityIdByName);
      }

      // Emit recall trace so the dashboard can animate spreading activation on the graph
      if (results.length > 0) {
        deps.logEvent?.({
          type: "recall_trace",
          entity: input.entity,
          query,
          seedNoteIds: results.slice(0, 5).map((r) => r.id),
          activatedNoteIds: results.map((r) => r.id),
          timestamp: Date.now(),
        });
      }

      // Collect task FTS results
      const taskLines: string[] = [];
      if (deps.taskManager) {
        try {
          const taskResults = deps.taskManager.searchTasks(query, { limit: 5 });
          const openTasks = taskResults.filter(
            (t) => t.status === "open" || t.status === "claimed",
          );
          if (openTasks.length > 0) {
            taskLines.push("", sectionHead("Related Tasks"));
            for (const t of openTasks) {
              const bounty =
                t.validationMode === "bounty" && t.standing > 0
                  ? ` ${status(`!${t.standing}`, "warn")}`
                  : "";
              const claims = deps.taskManager.getClaims(t.id);
              const submissions = claims.filter((c) => c.status === "submitted").length;
              const subLabel = submissions > 0 ? dim(` (${submissions} submissions)`) : "";
              taskLines.push(`  ${id(t.id)}${bounty} ${t.title}${subLabel}`);
            }
          }
        } catch {
          // FTS query syntax errors are silently ignored
        }
      }

      if (results.length === 0 && taskLines.length === 0) {
        ctx.send(input.entity, "No matching memories found.");
        return;
      }

      const now = Date.now();
      const typeLabel = noteType ? ` ${status(noteType, "info")}` : "";
      const lines = [
        header(`Recall: "${query}"${typeLabel}`),
        separator(),
        ...results.flatMap((n) => {
          const age = Math.floor((now - n.created_at) / DAY_MS);
          const ageStr = age === 0 ? "today" : `${age}d ago`;
          const base = `  ${id(n.id)} ${fmtScore(n.score)} ${importance(n.importance)} ${dim(ageStr)} ${previewText(n.content)}`;
          if (!flags.has("explain")) return [base];
          const sources = db.getNoteSources(n.id);
          const credibility =
            sources.length > 0
              ? sources.reduce((sum, source) => sum + source.credibility, 0) / sources.length
              : 0;
          return [
            base,
            dim(
              `      provenance: ${n.verification_status ?? "unverified"} · confidence ${(n.confidence ?? 0.5).toFixed(2)} · ${sources.length} source(s) · credibility ${credibility.toFixed(2)}`,
            ),
          ];
        }),
      ];

      // Depth signal: show what's beyond the returned results
      if (results.length > 0) {
        const counts = db.countMatchingNotes(entity.name, query);
        if (counts.total > results.length || counts.fading > 0) {
          const parts: string[] = [];
          if (counts.total > results.length) {
            parts.push(`${counts.total} total`);
          }
          if (counts.fading > 0) {
            parts.push(`${bold(String(counts.fading))} fading`);
          }
          lines.push(dim(`  (${parts.join(", ")})`));
        }
      }

      lines.push(...taskLines);

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
