// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { creditRecalledReflections } from "../../agent/standing";
import { memoryAccess } from "../../memory/access";
import { memoryNoteResults, memoryResult } from "../../memory/command-result";
import {
  INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP,
  institutionalCapsApply,
  isInstitutionalPoolName,
  ratifyPoolNote,
} from "../../memory/institutional";
import { findDurableTwin, recordDurableTwin } from "../../memory/legacy-bridge";
import { depositPoolNote } from "../../memory/pool-deposit";
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
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
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
  /** Author lookup so recalled reflections credit their writer (generational). */
  resolveEntityIdByName?: (name: string) => EntityId | undefined;
}): CommandDef {
  return {
    name: "pool",
    aliases: [],
    help: "Shared memory pools for collaborative knowledge.\nUsage: pool create <name> [group <groupName>] | pool <name> add|recall|list|status|audit|ratify | pool list\n\nExamples:\n  pool create findings\n  pool create crew-notes group project:Beta   (members-only pool; you must belong to the group)\n  pool findings add The decode room responds to binary input importance 7\n  pool findings recall binary\n  pool findings list\n  pool findings status\n  pool findings audit\n  pool guide ratify 42 importance 8 verified against the command registry\n\nInstitutional pools (guide, orchestration:*, tradition:*): on a shared instance `add` files a proposal (importance capped at 4, unverified) until someone with standing >= 15 (rank 2), a sovereign, or the local operator runs `pool <name> ratify <noteId> [importance N] [rationale]` — which lifts the cap, marks it verified, and mirrors it into the institutional durable space.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Pools require database support.");
        return;
      }
      const db = deps.db;
      const access = memoryAccess(db, entity);
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(
          input.entity,
          "Usage: pool create <name> [group <groupName>] | pool <name> add|recall|list|status|audit | pool list",
        );
        return;
      }

      if (sub === "list") {
        const pools = db.listMemoryPools().filter(access.pool);
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
          ctx.send(input.entity, "Usage: pool create <name> [group <groupName>]");
          return;
        }
        const existing = db.getMemoryPool(name);
        if (existing) {
          ctx.send(input.entity, `Pool "${name}" already exists.`);
          return;
        }
        // Optional group scope: `pool create <name> group <groupName>` makes
        // the pool members-only. The creator must already belong to the group
        // (leader or member) — you can't fence off a group you're not in.
        let groupId: string | undefined;
        if (tokens[2]) {
          if (tokens[2].toLowerCase() !== "group" || !tokens[3]) {
            ctx.send(input.entity, "Usage: pool create <name> [group <groupName>]");
            return;
          }
          const groupName = tokens.slice(3).join(" ");
          const group = db.getGroupByName(groupName) ?? db.getGroup(groupName);
          if (!group || !db.getGroupMember(group.id, input.entity)) {
            ctx.send(
              input.entity,
              `Group "${groupName}" not found or you are not a member. Join it first, or create the pool without a group.`,
            );
            return;
          }
          groupId = group.id;
        }
        const id = `pool_${name}_${Date.now()}`;
        db.createMemoryPool(id, name, entity.name, groupId);
        deps.logEvent?.({
          type: "coordination_change",
          resource: "pool",
          action: "create",
          entity: input.entity,
          name,
          timestamp: Date.now(),
        });
        ctx.send(
          input.entity,
          groupId
            ? `Memory pool "${name}" created (members-only: group ${tokens.slice(3).join(" ")}).`
            : `Memory pool "${name}" created.`,
        );
        return;
      }

      // Pool operations: pool <name> <action> [args]
      const poolName = sub;
      const action = tokens[1]?.toLowerCase();
      const pool = db.getMemoryPool(poolName);

      if (!pool || !access.pool(pool)) {
        ctx.send(
          input.entity,
          `Pool "${poolName}" not found or inaccessible.`,
          undefined,
          memoryResult("pool-recall", { success: false, error: "Pool not found" }),
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
          // Institutional pools on a shared/public instance take PROPOSALS:
          // the note is written (nothing breaks) but capped and unverified
          // until `pool <name> ratify` — curation with standing at stake.
          const proposal = isInstitutionalPoolName(poolName) && institutionalCapsApply();
          const requested = importance;
          if (proposal) importance = Math.min(importance, INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP);
          const { id: noteId, existing } = depositPoolNote(
            db,
            pool.id,
            entity.name,
            content,
            importance,
          );
          if (existing) {
            ctx.send(
              input.entity,
              `Already shared as #${noteId} in pool "${poolName}" — identical note by you is still active.`,
            );
            return;
          }
          deps.logEvent?.({
            type: "pool_note",
            entity: input.entity,
            noteId,
            poolName,
            content,
            importance,
            timestamp: Date.now(),
          });
          ctx.send(
            input.entity,
            proposal
              ? `Added proposal #${noteId} to institutional pool "${poolName}" (importance ${importance}${requested > importance ? `, requested ${requested}` : ""}, unverified). ` +
                  `It becomes canon when someone with standing ≥ 15 runs ${bold(`pool ${poolName} ratify ${noteId}`)}.`
              : `Added note #${noteId} to pool "${poolName}".`,
          );
          return;
        }

        case "ratify": {
          const noteId = Number.parseInt(tokens[2] ?? "", 10);
          if (!Number.isInteger(noteId) || noteId <= 0) {
            ctx.send(
              input.entity,
              `Usage: pool ${poolName} ratify <noteId> [importance N] [rationale]`,
            );
            return;
          }
          let rest = tokens.slice(3);
          let importance: number | undefined;
          if (rest[0]?.toLowerCase() === "importance" && rest[1]) {
            const val = Number.parseInt(rest[1], 10);
            if (val >= 1 && val <= 10) importance = val;
            rest = rest.slice(2);
          }
          const rationale = rest.join(" ").trim() || undefined;
          const result = ratifyPoolNote(
            db,
            poolName,
            noteId,
            { name: entity.name, rank: entity.properties.rank },
            { importance, rationale },
          );
          if (!result.ok) {
            ctx.send(input.entity, `Cannot ratify #${noteId} in "${poolName}": ${result.reason}`);
            return;
          }
          // Legacy twin row so `note`/`recall` surfaces can follow the mirror.
          if (!findDurableTwin(db, noteId))
            recordDurableTwin(
              db,
              noteId,
              {
                recordId: result.record.id,
                version: result.record.version ?? 1,
                spaceId: result.space.id,
              },
              entity.name,
            );
          ctx.send(
            input.entity,
            [
              header(`Ratified #${noteId} into "${poolName}"`),
              separator(),
              `  importance ${result.importance} · verified · by ${fmtEntity(result.ratified_by.name)} (${result.ratified_by.basis}, standing ${result.ratified_by.standing.toFixed(1)})`,
              `  durable record ${bold(result.record.id)} in institutional space ${dim(result.space.id)}${result.existing ? dim(" (already mirrored)") : ""}`,
            ].join("\n"),
          );
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
            ctx.send(
              input.entity,
              `No matching notes in pool "${poolName}". Recall matches words, not phrases — ` +
                `try a different keyword, or browse with \`pool ${poolName} list\`.`,
              undefined,
              memoryResult("pool-recall", { success: true, notes: [] }),
            );
            return;
          }
          for (const note of results) {
            db.touchNote(note.id);
          }
          // Pool recall is THE generational hand-off surface: someone else
          // reading your deposited reflection is your wisdom put back to use.
          // Credit flows to the author (idempotent; self-recall earns nothing).
          if (deps.resolveEntityIdByName) {
            creditRecalledReflections(db, entity.name, results, deps.resolveEntityIdByName);
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
          ctx.send(
            input.entity,
            lines.join("\n"),
            undefined,
            memoryResult("pool-recall", { success: true, notes: memoryNoteResults(results) }),
          );
          return;
        }

        default:
          ctx.send(
            input.entity,
            `Usage: pool ${poolName} add <text> | pool ${poolName} recall <query> | pool ${poolName} list | pool ${poolName} status | pool ${poolName} audit | pool ${poolName} ratify <noteId>`,
          );
      }
    },
  };
}
