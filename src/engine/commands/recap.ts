// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { bold, category, dim, header, id, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { ChronicleEntry } from "../../persistence/db-chronicle";
import type { CommandDef, Entity, RoomContext } from "../../types";

const HELP =
  "Show what the world remembers about a topic — no synthesis. " +
  "Usage:\n" +
  "  recap <topic>             — multi-source retrieval (notes, pools, world search)\n" +
  "  recap chronicle           — recent chronicle entries (canonical record)\n" +
  "  recap chronicle day       — chronicle entries from the last 24h\n" +
  "  recap chronicle week      — chronicle entries from the last 7d";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function formatChronicleLine(e: ChronicleEntry, now: number): string {
  const ageMs = now - e.created_at;
  const age =
    ageMs < 60_000
      ? `${Math.round(ageMs / 1000)}s`
      : ageMs < 3_600_000
        ? `${Math.round(ageMs / 60_000)}m`
        : ageMs < 86_400_000
          ? `${Math.round(ageMs / 3_600_000)}h`
          : `${Math.round(ageMs / 86_400_000)}d`;
  const idStr = `#${String(e.id).padStart(4)}`;
  const title = e.title.length > 70 ? `${e.title.slice(0, 67)}…` : e.title;
  const parts = e.participants.length > 0 ? ` (${e.participants.slice(0, 3).join(", ")})` : "";
  return `  ${dim(age.padStart(4))} ${dim(idStr)} [${e.kind}] ${bold(title)}${dim(parts)}`;
}

/**
 * Recap — retrieve-only multi-source pull on a topic.
 *
 * Sibling of `ask`. Ask synthesizes via the LLM (when available); recap
 * just shows what the world remembers. Faster, free, and useful when the
 * agent wants a cheap context refresh without burning model tokens.
 *
 * Sources: personal notes, guide pool, every other shared pool, world
 * full-text search, and (since pass 3 of the chronicle work) chronicle
 * entries. `recap chronicle [day|week]` is a special mode that returns
 * recent chronicle entries grouped — the natural input for the Chronicler's
 * digest synthesis, and the simplest way for any agent to ask "what
 * happened recently?"
 */
export function recapCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "recap",
    aliases: [],
    help: HELP,
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const query = input.args.trim();
      if (!query) {
        ctx.send(input.entity, "Usage: recap <topic>  (or `recap chronicle [day|week]`)");
        return;
      }

      if (!deps.db) {
        ctx.send(input.entity, "Recap requires database support.");
        return;
      }

      const db = deps.db;

      // ─── recap chronicle [day|week] — canonical-record lens ────────────
      const tokens = input.tokens;
      if (tokens[0]?.toLowerCase() === "chronicle") {
        const periodArg = tokens[1]?.toLowerCase();
        const now = Date.now();
        let since: number | undefined;
        let label: string;
        if (periodArg === "day") {
          since = now - DAY_MS;
          label = "Chronicle — last 24h";
        } else if (periodArg === "week") {
          since = now - WEEK_MS;
          label = "Chronicle — last 7d";
        } else {
          since = undefined;
          label = "Chronicle — recent";
        }
        const entries = db.queryChronicle({
          since,
          limit: periodArg ? 100 : 20,
        });
        if (entries.length === 0) {
          ctx.send(
            input.entity,
            periodArg
              ? `Nothing chronicled in the last ${periodArg === "day" ? "24h" : "7d"}.`
              : "The chronicle is empty.",
          );
          return;
        }
        const grouped = new Map<string, ChronicleEntry[]>();
        for (const e of entries) {
          const k = e.kind;
          const arr = grouped.get(k) ?? [];
          arr.push(e);
          grouped.set(k, arr);
        }
        const order: ChronicleEntry["kind"][] = ["digest", "narrative", "correction", "event"];
        const lines: string[] = [
          header(`${label} (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`),
          separator(),
        ];
        for (const kind of order) {
          const bucket = grouped.get(kind);
          if (!bucket || bucket.length === 0) continue;
          lines.push(category(`${kind} (${bucket.length})`));
          for (const e of bucket) lines.push(formatChronicleLine(e, now));
        }
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── recap <topic> — original behavior (retrieval over many sources)
      const lines: string[] = [header(`Recap: ${query}`), separator()];
      let sections = 0;

      const memories = db.recallNotes(entity.name, query).slice(0, 5);
      if (memories.length > 0) {
        sections++;
        lines.push(category("Your Notes"));
        for (const note of memories) {
          db.touchNote(note.id);
          lines.push(`  ${id(note.id)} ${note.content}`);
        }
      }

      const guide = db.getMemoryPool("guide");
      if (guide) {
        const guideNotes = db.recallPoolNotes(guide.id, query).slice(0, 5);
        if (guideNotes.length > 0) {
          sections++;
          lines.push(category("Guide"));
          for (const note of guideNotes) {
            db.touchNote(note.id);
            lines.push(`  ${id(note.id)} ${note.content}`);
          }
        }
      }

      const poolHits: { pool: string; content: string; noteId: number }[] = [];
      for (const pool of db.listMemoryPools()) {
        if (pool.name === "guide") continue;
        const hits = db.recallPoolNotes(pool.id, query).slice(0, 2);
        for (const hit of hits) {
          db.touchNote(hit.id);
          poolHits.push({ pool: pool.name, content: hit.content, noteId: hit.id });
          if (poolHits.length >= 6) break;
        }
        if (poolHits.length >= 6) break;
      }
      if (poolHits.length > 0) {
        sections++;
        lines.push(category("Shared Pools"));
        for (const hit of poolHits) {
          lines.push(`  ${id(hit.noteId)} [${hit.pool}] ${hit.content}`);
        }
      }

      // Chronicle entries that mention the topic — the canonical record as a
      // retrieval source. Bias toward synthesized kinds (narrative + digest)
      // since those are interpretation; raw events are still findable but
      // capped lower so they don't crowd the section.
      const chronicleHits = db.queryChronicle({ like: query, limit: 5 });
      if (chronicleHits.length > 0) {
        sections++;
        lines.push(category("Chronicle"));
        for (const e of chronicleHits) {
          const title = e.title.length > 90 ? `${e.title.slice(0, 87)}…` : e.title;
          lines.push(`  ${id(e.id)} [${e.kind}] ${title}`);
        }
      }

      const searchHits = db.globalSearch(query).slice(0, 5);
      if (searchHits.length > 0) {
        sections++;
        lines.push(category("World Search"));
        for (const hit of searchHits) {
          lines.push(`  [${hit.type}:${hit.context}] ${hit.title}`);
        }
      }

      if (sections === 0) {
        lines.push("Nothing on file yet.");
        lines.push(dim("Try: `dig <topic>` to bring in external evidence, or `ask <topic>`."));
      }

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
