// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { creditRecalledReflections } from "../../agent/standing";
import type { TaskManager } from "../../coordination/task-manager";
import { memoryNoteResults, memoryResult } from "../../memory/command-result";
import {
  expandedFtsQueries,
  expansionForEntityCached,
  fuseRecallResults,
} from "../../memory/query-expansion";
import { expandMemoryRecall } from "../../memory/retrieval";
import {
  buildUnifiedContext,
  renderUnifiedContext,
  unifiedLegacyNoteIds,
} from "../../memory/unified-context";
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
import type { MarinaDB, ScoredNoteRow } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import { DAY_MS } from "../constants";
import { extractFlags, extractModifiers } from "../parse-input";

/** Default content budget for `recall <q> all|evidence` — roomier than the
 *  prompt default because a human/tool asked for it explicitly. */
const RECALL_UNIFIED_BUDGET_BYTES = 4096;
/** Max rows a plain `recall` returns (matches the SQL LIMIT in recallNotes). */
const RECALL_LIMIT = 20;
const RECALL_BUDGET_MIN = 256;
const RECALL_BUDGET_MAX = 65_536;

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
    help: "Scored, provenance-aware retrieval. Usage: recall <query> [recent|important|trusted|explain|evidence|all] [type <type>] [budget <bytes>]\n  all — unified tiers: skills, [trusted], [evidence] (durable records + sources), [proposal] (assistance answers), [unverified]\n  evidence — durable tiers only",
    // Synchronous for plain recall (callers that don't await processCommand —
    // quest tracking, cognitive-provenance capture, the SDK reply window — rely
    // on the reply landing in the same tick). Only the unified `all|evidence`
    // branch returns a Promise; the engine awaits either shape.
    handler: (ctx: RoomContext, input): void | Promise<void> => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(
          input.entity,
          "Recall requires database support.",
          undefined,
          memoryResult("recall", { success: false, error: "Persistence unavailable" }),
        );
        return;
      }
      const db = deps.db;
      const args = input.args;
      if (!args) {
        ctx.send(
          input.entity,
          "Usage: recall <query> [recent | important] [type <type>]",
          undefined,
          memoryResult("recall", { success: false, error: "Query required" }),
        );
        return;
      }

      // Parse modifiers from the end of input
      let weightImportance = 0.33;
      let weightRecency = 0.33;
      let weightRelevance = 0.34;

      // Extract modifiers: "type <word>" / "budget <bytes>" (or --type / --budget)
      const { text: afterType, modifiers } = extractModifiers(args, ["type", "budget"]);
      const noteType = modifiers.type;

      // Extract weight flags: trailing "recent"/"important" or "--recent"/"--important"
      let { text: query, flags } = extractFlags(afterType, [
        "recent",
        "important",
        "trusted",
        "explain",
        "evidence",
        "all",
      ]);
      // A bare modifier word is a query, not a modifier: `recall evidence`
      // searches for "evidence" rather than failing with an empty query.
      if (!query && afterType.trim()) {
        query = afterType.trim();
        flags = new Set();
      }

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
        ctx.send(
          input.entity,
          "Usage: recall <query> [recent | important] [type <type>]",
          undefined,
          memoryResult("recall", { success: false, error: "Query required" }),
        );
        return;
      }

      const weights = { weightImportance, weightRecency, weightRelevance };

      // ── Unified surface: `recall <q> all` (every tier) / `recall <q> evidence`
      // (durable tiers only). Same builder the continuation prompt, /mem/context,
      // the MCP `think context` action, and passthru injection use — so an agent
      // and its operator see identical tiers with identical provenance labels.
      if (flags.has("all") || flags.has("evidence")) {
        return (async () => {
          const scope = flags.has("evidence") ? "evidence" : "all";
          const parsedBudget = modifiers.budget
            ? Number.parseInt(modifiers.budget, 10)
            : Number.NaN;
          const budgetBytes = Number.isFinite(parsedBudget)
            ? Math.min(Math.max(parsedBudget, RECALL_BUDGET_MIN), RECALL_BUDGET_MAX)
            : RECALL_UNIFIED_BUDGET_BYTES;
          const unified = await buildUnifiedContext(db, entity.name, query, {
            scope,
            weights,
            noteType,
            budgetBytes,
          });

          // Legacy hits surfaced through the unified view get the same
          // bookkeeping as a plain recall: touch, author credit, recall trace.
          const scores = new Map<string, number>();
          for (const tier of unified.tiers)
            for (const item of tier.items) scores.set(item.id, item.score);
          const legacyRows: ScoredNoteRow[] = [];
          for (const id of unifiedLegacyNoteIds(unified)) {
            db.touchNote(id);
            const note = db.getNote(id);
            if (note) legacyRows.push({ ...note, score: scores.get(String(id)) ?? 0 });
          }
          if (deps.resolveEntityIdByName && legacyRows.length > 0) {
            creditRecalledReflections(db, entity.name, legacyRows, deps.resolveEntityIdByName);
          }
          if (legacyRows.length > 0) {
            deps.logEvent?.({
              type: "recall_trace",
              entity: input.entity,
              query,
              seedNoteIds: legacyRows.slice(0, 5).map((r) => r.id),
              activatedNoteIds: legacyRows.map((r) => r.id),
              timestamp: Date.now(),
            });
          }

          const rendered = renderUnifiedContext(unified, { header: false });
          const typeLabel = noteType ? ` ${status(noteType, "info")}` : "";
          const lines = [
            header(`Recall (${scope}): "${query}"${typeLabel}`),
            separator(),
            rendered || "No matching memories found.",
          ];
          if (unified.truncated) {
            lines.push(
              dim(
                `  (budget ${unified.budgetBytes} bytes reached, ${unified.usedBytes} used — raise with "budget <bytes>")`,
              ),
            );
          }
          // `marina.memory.command.v1` stays backward compatible: `notes` carries
          // the legacy hits as before; `context` is the additive unified payload.
          const payload = memoryResult("recall", {
            success: true,
            notes: memoryNoteResults(legacyRows),
          });
          (payload.memory as Record<string, unknown>).context = unified;
          ctx.send(input.entity, lines.join("\n"), undefined, payload);
        })();
      }

      // Query expansion ties the silos: when the caller's durable resident space
      // carries an authored vocabulary, recall also runs its bounded alternative
      // phrasings and fuses the lists (RRF). No vocabulary → the single query.
      // Synchronous by design: the vocabulary comes from a per-entity cache that
      // refreshes in the background, so plain `recall` never awaits a durable
      // round-trip (the SDK's reply window and the quest tracker both depend on
      // the reply landing in the same tick).
      const expansion = expansionForEntityCached(db, entity.name, query);
      const recallOne = (q: string) =>
        noteType
          ? db.recallNotesWithType(entity.name, q, noteType, weights)
          : db.recallNotes(entity.name, q, weights);
      let results = expansion
        ? fuseRecallResults(
            expandedFtsQueries(query, expansion).map(recallOne),
            (row) => row.id,
            RECALL_LIMIT,
          )
        : recallOne(query);
      results = expandMemoryRecall(db, results, entity.name, {
        noteType,
        trusted: flags.has("trusted"),
      });

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
        ctx.send(
          input.entity,
          "No matching memories found.",
          undefined,
          memoryResult("recall", { success: true, notes: [] }),
        );
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

      ctx.send(
        input.entity,
        lines.join("\n"),
        undefined,
        memoryResult("recall", { success: true, notes: memoryNoteResults(results) }),
      );
    },
  };
}
