// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memoryAccess } from "../../memory/access";
import { memoryNoteResults, memoryResult } from "../../memory/command-result";
import {
  INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP,
  institutionalCapsApply,
  isInstitutionalPoolName,
  ratifyPoolNote,
} from "../../memory/institutional";
import { durableTwinRecordIds, durableTwinUrl } from "../../memory/legacy-projection";
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
import type { MarinaDB, MemoryPoolRow, NoteRow } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { failCommandResponse, refuseCommand } from "../command-response";
import { DAY_MS } from "../constants";
import {
  canonicalSub,
  parseModifiers,
  resolveNamePrefix,
  unknownSubcommand,
  unquote,
} from "../parse-input";
import {
  auditKnowledgeNotes,
  type CommandVocabulary,
  renderKnowledgeHygieneReport,
} from "./knowledge-hygiene";
import { resolveProjectPrefix } from "./project";

const POOL_ACTIONS = ["list", "status", "audit", "add", "ratify", "recall"];

/**
 * The pool a name means: exact, then case-insensitive, then the pool of the
 * project it names (`Demo Pulse`, `project:Demo Pulse`) — the spellings
 * agents read off `project info` and project templates.
 */
function lookupPool(
  db: MarinaDB,
  name: string,
  folded: () => Map<string, MemoryPoolRow>,
): MemoryPoolRow | undefined {
  const exact = db.getMemoryPool(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const byCase = folded().get(lower);
  if (byCase) return byCase;
  const projectName = lower.startsWith("project:") ? name.slice("project:".length) : name;
  const project = resolveProjectPrefix(db, [projectName]);
  return project?.project.pool_id ? db.getMemoryPoolById(project.project.pool_id) : undefined;
}

/** `pool <name…> <action> …`, or verb-first `pool <action> <name…> …`. */
export function resolvePoolTokens(
  db: MarinaDB,
  tokens: readonly string[],
): { pool: MemoryPoolRow; rest: string[] } | undefined {
  let byLower: Map<string, MemoryPoolRow> | undefined;
  const folded = () =>
    (byLower ??= new Map(db.listMemoryPools().map((p) => [p.name.toLowerCase(), p])));
  const lookup = (name: string) => lookupPool(db, name, folded);
  const direct = resolveNamePrefix(tokens, lookup);
  if (direct) return { pool: direct.value, rest: direct.rest };
  const verb = canonicalSub(tokens[0], POOL_ACTIONS);
  if (!verb) return undefined;
  const after = resolveNamePrefix(tokens.slice(1), lookup);
  return after ? { pool: after.value, rest: [verb, ...after.rest] } : undefined;
}

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
  getCommandVocabulary?: () => CommandVocabulary;
}): CommandDef {
  return {
    category: "Memory",
    usage: [
      { syntax: "pool <name> add", effect: "write" },
      { syntax: "pool <name> add <text> [importance:N]", effect: "write" },
      { syntax: "pool <name> audit", effect: "read" },
      { syntax: "pool <name> list", effect: "read" },
      { syntax: "pool <name> ratify", effect: "write" },
      { syntax: "pool <name> recall", effect: "read" },
      { syntax: "pool <name> status", effect: "read" },
      { syntax: "pool create <name> [group <groupName>]", effect: "write" },
      { syntax: "pool list", effect: "read" },
    ],
    name: "pool",
    aliases: [],
    help: "Shared memory pools for collaborative knowledge.\nUsage: pool create <name> [group <groupName>] | pool <name> add <text> [importance:N] | pool <name> recall|list|status|audit|ratify | pool list\n  (importance also as trailing `importance N` or `!N`; `ls` = list)\n\nExamples:\n  pool create findings\n  pool create crew-notes group project:Beta   (members-only pool; you must belong to the group)\n  pool findings add The decode room responds to binary input importance:7\n  pool findings recall binary\n  pool findings list\n  pool findings status\n  pool findings audit\n  pool guide ratify 42 importance 8 verified against the command registry\n\nInstitutional pools (guide, orchestration:*, tradition:*): on a shared instance `add` files a proposal (importance capped at 4, unverified) until someone with standing >= 15 (rank 2), a sovereign, or the local operator runs `pool <name> ratify <noteId> [importance N] [rationale]` — which lifts the cap, marks it verified, and mirrors it into the institutional durable space.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Pools require database support.");
        return;
      }
      const db = deps.db;
      const access = memoryAccess(db, entity);
      let tokens = input.tokens;
      const sub = canonicalSub(tokens[0], ["list", "create"]);

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
          refuseCommand(ctx, input.entity, "Usage: pool create <name> [group <groupName>]");
          return;
        }
        const existing = db.getMemoryPool(name);
        if (existing) {
          refuseCommand(ctx, input.entity, `Pool "${name}" already exists.`);
          return;
        }
        // Optional group scope: `pool create <name> group <groupName>` makes
        // the pool members-only. The creator must already belong to the group
        // (leader or member) — you can't fence off a group you're not in.
        let groupId: string | undefined;
        if (tokens[2]) {
          if (tokens[2].toLowerCase() !== "group" || !tokens[3]) {
            refuseCommand(ctx, input.entity, "Usage: pool create <name> [group <groupName>]");
            return;
          }
          const groupName = tokens.slice(3).join(" ");
          const group = db.getGroupByName(groupName) ?? db.getGroup(groupName);
          if (!group || !db.getGroupMember(group.id, input.entity)) {
            refuseCommand(
              ctx,
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

      // Pool operations: pool <name> <action> [args]. The name is the longest
      // leading run of tokens naming a pool (spaces, quotes, case, or the
      // project it belongs to); `pool recall <name> …` reads as `pool <name> recall …`.
      const resolved = resolvePoolTokens(db, tokens);
      if (!resolved) {
        const typed = unquote(tokens[0]!);
        const message = `Pool "${typed}" not found or inaccessible. List pools with \`pool list\`, or create one with \`pool create ${typed}\`.`;
        ctx.send(
          input.entity,
          message,
          undefined,
          memoryResult("pool-recall", { success: false, error: "Pool not found" }),
        );
        failCommandResponse(message);
        return;
      }
      const pool = resolved.pool;
      const poolName = pool.name;
      // Normalized: [name, action, ...args] — the actions below read args by index.
      tokens = [poolName, ...resolved.rest];
      const action = canonicalSub(tokens[1], POOL_ACTIONS);

      if (!access.pool(pool)) {
        // A project's pool is members-only, and the project is public: name the join.
        const project = db.listProjects().find((p) => p.pool_id === pool.id);
        const message = project
          ? `Pool "${poolName}" is members-only for project "${project.name}": run \`project ${project.name} join\`, then retry.`
          : `Pool "${poolName}" not found or inaccessible. List pools with \`pool list\`, or create one with \`pool create ${poolName}\`.`;
        ctx.send(
          input.entity,
          message,
          undefined,
          memoryResult("pool-recall", { success: false, error: "Pool not found" }),
        );
        failCommandResponse(message);
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
            ...deps.getCommandVocabulary?.(),
            // Flag shared-pool notes nothing has touched in ~3 months as stale —
            // a prune signal for guide and other high-impact pools.
            maxAgeMs: 90 * DAY_MS,
          });
          ctx.send(input.entity, renderKnowledgeHygieneReport(`Pool "${poolName}"`, report));
          return;
        }

        case "add": {
          // pool <name> add <text> [importance:N]   (also trailing `importance N` / `!N`)
          const addMods = parseModifiers(tokens.slice(2), { importance: { type: "int" } });
          if (addMods.errors.length > 0) {
            ctx.send(input.entity, `pool add: ${addMods.errors.join("; ")}`);
            return;
          }
          const text = addMods.rest.join(" ");
          if (!text) {
            refuseCommand(ctx, input.entity, `Usage: pool ${poolName} add <text> [importance:N]`);
            return;
          }
          let importance = 5;
          let content = text;
          const modImportance = addMods.values.importance as number | undefined;
          const impWordMatch = content.match(/\s+importance\s+(\d{1,2})\s*$/);
          if (modImportance !== undefined && modImportance >= 1 && modImportance <= 10) {
            importance = modImportance;
          } else if (impWordMatch) {
            // Legacy: trailing "importance N"
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
            refuseCommand(
              ctx,
              input.entity,
              `Usage: pool ${poolName} ratify <noteId> [importance:N] [rationale]`,
            );
            return;
          }
          const ratifyMods = parseModifiers(tokens.slice(3), { importance: { type: "int" } });
          let rest = ratifyMods.rest;
          let importance = ratifyMods.values.importance as number | undefined;
          if (importance !== undefined && (importance < 1 || importance > 10))
            importance = undefined;
          if (importance === undefined && rest[0]?.toLowerCase() === "importance" && rest[1]) {
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
            refuseCommand(
              ctx,
              input.entity,
              `Cannot ratify #${noteId} in "${poolName}": ${result.reason}`,
            );
            return;
          }
          // Legacy twin row so `note`/`recall` surfaces can follow the mirror.
          // Recorded beside the author's resident twin (from `pool add`), not
          // instead of it: `findDurableTwin` keeps preferring the resident twin
          // and returns this mirror only when it is the sole twin.
          if (!durableTwinRecordIds(db, noteId).includes(result.record.id))
            db.addNoteSource(noteId, {
              url: durableTwinUrl(result.record.id),
              sourceType: "artifact",
              title: "institutional publication",
              capturedBy: entity.name,
              credibility: 0,
              metadata: {
                kind: "durable-twin",
                mirror: "institutional",
                pool: poolName,
                record_id: result.record.id,
                version: result.record.version,
                space_id: result.space.id,
              },
            });
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
            refuseCommand(ctx, input.entity, `Usage: pool ${poolName} recall <query>`);
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
            unknownSubcommand(
              "pool",
              tokens[1],
              `Usage: pool ${poolName} add <text> | pool ${poolName} recall <query> | pool ${poolName} list | pool ${poolName} status | pool ${poolName} audit | pool ${poolName} ratify <noteId>`,
            ),
          );
      }
    },
  };
}
