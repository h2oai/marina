import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import { DAY_MS } from "../constants";
import { auditKnowledgeNotes, renderKnowledgeHygieneReport } from "./knowledge-hygiene";

/**
 * First-class surface for the platform-wide `guide` pool — the canonical
 * orientation knowledge every world seeds. It is reachable via `pool guide ...`,
 * but the guide is special (stable, high-impact, read by every new agent), so it
 * gets its own discoverable, read-only command:
 *
 *   guide                 — overview (note count + recall hint)
 *   guide <topic>         — recall guide notes about a topic (voice-friendly)
 *   guide recall <topic>  — same, explicit
 *   guide list            — list all guide notes
 *   guide audit | lint    — hygiene audit (duplicate/overlong/stale-command/
 *                           unsupported-claim/stale) of the guide pool
 *
 * All read-only (rank 0). It never mutates the pool — authoring guide notes
 * stays a world-seed concern, and ad-hoc additions go through `pool guide add`.
 */
const POOL_NAME = "guide";
const KNOWN_SUBCOMMANDS = new Set(["recall", "list", "audit", "lint"]);

export function guideCommand(deps: {
  db?: MarinaDB;
  getEntity?: (id: EntityId) => { name: string } | undefined;
  getCommandNames?: () => string[];
}): CommandDef {
  return {
    name: "guide",
    aliases: [],
    minRank: 0,
    help: "Read the platform guide — orientation knowledge for this world.\nUsage: guide | guide <topic> | guide recall <topic> | guide list | guide audit\n\nThe guide is the shared `guide` pool every world seeds. `guide <topic>` recalls relevant notes; `guide audit` (alias `guide lint`) reports hygiene findings (duplicates, overlong notes, stale command references, unsupported claims, stale notes). Read-only.",
    handler: (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, "Guide requires database support.");
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const pool = db.getMemoryPool(POOL_NAME);
      if (!pool) {
        ctx.send(input.entity, "No guide pool in this world.");
        return;
      }

      const first = tokens[0]?.toLowerCase();
      const sub = first && KNOWN_SUBCOMMANDS.has(first) ? first : undefined;

      // Overview: bare `guide`.
      if (!first) {
        const notes = db.getPoolNotes(pool.id, 500);
        ctx.send(
          input.entity,
          [
            header("Guide"),
            separator(),
            `The platform guide pool holds ${bold(String(notes.length))} orientation note(s).`,
            dim('Try "guide <topic>" to recall, "guide list" to browse, "guide audit" to lint.'),
          ].join("\n"),
        );
        return;
      }

      if (sub === "list") {
        const notes = db.getPoolNotes(pool.id, 500);
        if (notes.length === 0) {
          ctx.send(input.entity, "The guide pool is empty.");
          return;
        }
        const lines = [header("Guide notes"), separator()];
        for (const n of notes) {
          const preview = n.content.replace(/\s+/g, " ").slice(0, 100);
          lines.push(
            `  #${n.id} ${dim(`[imp=${n.importance}]`)} ${preview}${n.content.length > 100 ? "..." : ""}`,
          );
        }
        lines.push(separator(), dim(`${notes.length} note(s) total`));
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "audit" || sub === "lint") {
        const notes = db.getPoolNotes(pool.id, 500);
        const report = auditKnowledgeNotes(notes, {
          knownCommands: deps.getCommandNames?.(),
          maxAgeMs: 90 * DAY_MS,
        });
        ctx.send(input.entity, renderKnowledgeHygieneReport("Guide pool", report));
        return;
      }

      // recall: either `guide recall <topic>` or bare `guide <topic>`.
      const query = (sub === "recall" ? tokens.slice(1) : tokens).join(" ").trim();
      if (!query) {
        ctx.send(input.entity, "Usage: guide recall <topic>");
        return;
      }
      const results = db.recallPoolNotes(pool.id, query);
      if (results.length === 0) {
        ctx.send(input.entity, `No guide notes match "${query}".`);
        return;
      }
      for (const note of results) db.touchNote(note.id);
      const lines = [header(`Guide: "${query}"`), separator()];
      for (const n of results) {
        lines.push(
          `  #${n.id} ${dim(`[score=${n.score.toFixed(2)} imp=${n.importance}]`)} ${n.content}`,
        );
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
