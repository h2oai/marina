// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  bold,
  dim,
  entity as fmtEntity,
  id as fmtId,
  header,
  importance,
  separator,
} from "../../net/ansi";
import type { MarinaDB, NoteRow } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { DAY_MS } from "../constants";
import { auditKnowledgeNotes, renderKnowledgeHygieneReport } from "./knowledge-hygiene";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "was",
  "one",
  "our",
  "out",
  "has",
  "have",
  "been",
  "were",
  "they",
  "this",
  "that",
  "with",
  "from",
  "will",
  "would",
  "there",
  "their",
  "what",
  "about",
  "which",
  "when",
  "make",
  "like",
  "could",
  "into",
  "than",
  "other",
  "some",
  "very",
  "just",
  "also",
  "more",
  "should",
  "each",
  "being",
  "does",
  "use",
  "used",
  "using",
  "pool",
  "project",
]);

function extractPoolTopics(notes: NoteRow[]): string[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const words = n.content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    const seen = new Set<string>();
    for (const w of words) {
      if (w.length < 4 || STOP_WORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
}

export function poolCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
  getCommandNames?: () => string[];
}): CommandDef {
  return {
    name: "pool",
    aliases: [],
    help: "Shared memory pools for collaborative knowledge.\nUsage: pool create <name> | pool <name> add|recall|list|status|audit | pool list\n\nExamples:\n  pool create findings\n  pool findings add The decode room responds to binary input importance 7\n  pool findings recall binary\n  pool findings list\n  pool findings status\n  pool findings audit",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Pools require database support.");
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(
          input.entity,
          "Usage: pool create <name> | pool <name> add|recall|list|status|audit | pool list",
        );
        return;
      }

      if (sub === "list") {
        const pools = db.listMemoryPools();
        if (pools.length === 0) {
          ctx.send(input.entity, "No memory pools exist.");
          return;
        }
        const lines = [
          header("Memory Pools"),
          separator(),
          ...pools.map((p) => `  ${bold(p.name)} ${dim(`(by ${p.created_by})`)}`),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "create") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: pool create <name>");
          return;
        }
        const existing = db.getMemoryPool(name);
        if (existing) {
          ctx.send(input.entity, `Pool "${name}" already exists.`);
          return;
        }
        const id = `pool_${name}_${Date.now()}`;
        db.createMemoryPool(id, name, entity.name);
        deps.logEvent?.({
          type: "coordination_change",
          resource: "pool",
          action: "create",
          entity: input.entity,
          name,
          timestamp: Date.now(),
        });
        ctx.send(input.entity, `Memory pool "${name}" created.`);
        return;
      }

      // Pool operations: pool <name> <action> [args]
      const poolName = sub;
      const action = tokens[1]?.toLowerCase();
      const pool = db.getMemoryPool(poolName);

      if (!pool) {
        ctx.send(
          input.entity,
          `Pool "${poolName}" not found. Use "pool create ${poolName}" to create.`,
        );
        return;
      }

      if (!action || action === "list") {
        // Recent notes in the pool. Use the direct getPoolNotes() reader rather
        // than recallPoolNotes(pool, "*", …): the FTS "*" query is fragile and
        // silently returned nothing on some inputs, making a populated pool look
        // empty. `pool status` already uses getPoolNotes for the same reason.
        const notes = db.getPoolNotes(pool.id);
        if (notes.length === 0) {
          ctx.send(input.entity, `Pool "${poolName}" has no notes yet.`);
          return;
        }
        const lines = [
          header(`Pool: ${poolName}`),
          separator(),
          ...notes.map((n) => {
            const date = dim(new Date(n.created_at).toISOString().slice(0, 10));
            return `  ${fmtId(n.id)} ${date} (${fmtEntity(n.entity_name)}) ${importance(n.importance)}: ${n.content.slice(0, 60)}`;
          }),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      switch (action) {
        case "status": {
          const notes = db.getPoolNotes(pool.id);
          if (notes.length === 0) {
            ctx.send(input.entity, `Pool "${poolName}" is empty.`);
            return;
          }

          // Contributors
          const contributors = new Map<string, number>();
          for (const n of notes) {
            contributors.set(n.entity_name, (contributors.get(n.entity_name) ?? 0) + 1);
          }

          // Note types
          const typeCounts: Record<string, number> = {};
          for (const n of notes) {
            typeCounts[n.note_type] = (typeCounts[n.note_type] ?? 0) + 1;
          }

          // Importance distribution
          const highImp = notes.filter((n) => n.importance >= 7).length;
          const midImp = notes.filter((n) => n.importance >= 4 && n.importance <= 6).length;
          const lowImp = notes.filter((n) => n.importance <= 3).length;

          // Recency
          const now = Date.now();
          const recentCount = notes.filter((n) => now - n.created_at < DAY_MS).length;
          const weekCount = notes.filter((n) => now - n.created_at < 7 * DAY_MS).length;

          // Topics
          const topics = extractPoolTopics(notes);

          const lines = [
            header(`Pool: ${poolName}`),
            separator(),
            `  Notes: ${notes.length}`,
            `  Contributors: ${[...contributors.entries()].map(([name, count]) => `${fmtEntity(name)} ${dim(`(${count})`)}`).join(", ")}`,
            `  Types: ${Object.entries(typeCounts)
              .map(([t, c]) => `${t}: ${c}`)
              .join(", ")}`,
            `  Importance: ${highImp} high, ${midImp} mid, ${lowImp} low`,
            `  Activity: ${recentCount} today, ${weekCount} this week`,
          ];
          if (topics.length > 0) {
            lines.push(`  Topics: ${topics.join(", ")}`);
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "audit": {
          const notes = db.getPoolNotes(pool.id, 500);
          const report = auditKnowledgeNotes(notes, {
            knownCommands: deps.getCommandNames?.(),
            // Flag shared-pool notes nothing has touched in ~3 months as stale —
            // a prune signal for guide and other high-impact pools.
            maxAgeMs: 90 * DAY_MS,
          });
          ctx.send(input.entity, renderKnowledgeHygieneReport(`Pool "${poolName}"`, report));
          return;
        }

        case "add": {
          const text = tokens.slice(2).join(" ");
          if (!text) {
            ctx.send(input.entity, `Usage: pool ${poolName} add <text> [importance N]`);
            return;
          }
          // Parse importance — new: trailing "importance N"
          let importance = 5;
          let content = text;
          const impWordMatch = content.match(/\s+importance\s+(\d{1,2})\s*$/);
          if (impWordMatch) {
            const val = Number.parseInt(impWordMatch[1]!, 10);
            if (val >= 1 && val <= 10) {
              importance = val;
              content = content.slice(0, content.length - impWordMatch[0].length).trim();
            }
          } else {
            // Legacy: !N — backward compatible
            const impMatch = content.match(/\s+!(\d{1,2})(?:\s|$)/);
            if (impMatch) {
              const val = Number.parseInt(impMatch[1]!, 10);
              if (val >= 1 && val <= 10) {
                importance = val;
                content = content.replace(impMatch[0], " ").trim();
              }
            }
          }
          const noteId = db.addPoolNote(pool.id, entity.name, content, importance);
          deps.logEvent?.({
            type: "pool_note",
            entity: input.entity,
            noteId,
            poolName,
            content,
            importance,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Added note #${noteId} to pool "${poolName}".`);
          return;
        }

        case "recall": {
          const query = tokens.slice(2).join(" ");
          if (!query) {
            ctx.send(input.entity, `Usage: pool ${poolName} recall <query>`);
            return;
          }
          const results = db.recallPoolNotes(pool.id, query);
          if (results.length === 0) {
            ctx.send(input.entity, "No matching notes in pool.");
            return;
          }
          for (const note of results) {
            db.touchNote(note.id);
          }
          const lines = [
            header(`Pool "${poolName}" recall: "${query}"`),
            separator(),
            ...results.map((n) => {
              const now = Date.now();
              const age = Math.floor((now - n.created_at) / DAY_MS);
              const ageStr = age === 0 ? "today" : `${age}d ago`;
              return `  #${n.id} [score=${n.score.toFixed(2)} imp=${n.importance} ${ageStr}] (${n.entity_name}): ${n.content.slice(0, 60)}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        default:
          ctx.send(
            input.entity,
            `Usage: pool ${poolName} add <text> | pool ${poolName} recall <query> | pool ${poolName} list | pool ${poolName} status | pool ${poolName} audit`,
          );
      }
    },
  };
}
