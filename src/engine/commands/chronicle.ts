// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { recordChronicleCitation } from "../../agent/standing";
import { bold, category, dim, id as fmtId, header, separator, status } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { ChronicleEntry, ChronicleKind } from "../../persistence/db-chronicle";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { extractModifiers, splitOn } from "../parse-input";
import { requiresPersistence } from "./command-messages";
import { formatAge, parseSince } from "./format-duration";

const CHRONICLER_ROLE = "chronicler";

const HELP = `Chronicle — the canonical, append-only record of the Marina.
Read (any rank):
  chronicle                            — recent entries (last 20)
  chronicle show <id>                  — full entry + provenance + corrections
  chronicle since <duration>           — entries since 30m|2h|7d|1w
  chronicle about <name>               — entries involving an entity
  chronicle kinds                      — distinct sources of entries
  chronicle pending [since <dur>]      — un-narrated engine events (Chronicler's queue)

Write (Chronicler role only):
  chronicle record <title> | <body> [refs <ids>] [participants <names>]
  chronicle correct <id> <title> | <body> [refs <ids>] [participants <names>]
  chronicle digest day|week <title> | <body> [refs <ids>] [period <token>]

The chronicle is parallel to (and longer-lived than) the feed: feed events
are ephemeral, the chronicle is permanent. See docs/chronicle.md.`;

function kindLabel(kind: ChronicleKind): string {
  switch (kind) {
    case "event":
      return status("event    ", "info");
    case "narrative":
      return status("narrative", "active");
    case "digest":
      return status("digest   ", "done");
    case "correction":
      return status("correctn ", "warn");
  }
}

function formatList(entries: ChronicleEntry[], now: number): string[] {
  return entries.map((e) => {
    const age = dim(formatAge(now - e.created_at).padStart(4));
    const idStr = dim(`#${String(e.id).padStart(4)}`);
    const k = kindLabel(e.kind);
    const title = e.title.length > 70 ? `${e.title.slice(0, 67)}…` : e.title;
    const parts =
      e.participants.length > 0 ? dim(` (${e.participants.slice(0, 3).join(", ")})`) : "";
    return `  ${age} ${idStr} ${k} ${bold(title)}${parts}`;
  });
}

/**
 * Parse a comma-separated list, dropping empties. "feed:1, task:2," → ["feed:1", "task:2"].
 * Used for both refs and participants modifiers.
 */
function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Format Date as UTC YYYY-MM-DD. */
function dayToken(when: Date): string {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, "0");
  const d = String(when.getUTCDate()).padStart(2, "0");
  return `day:${y}-${m}-${d}`;
}

/**
 * Format Date as ISO week: `week:YYYY-Www`. ISO 8601 week-of-year: weeks start
 * Monday; week 1 is the week containing Thursday's first occurrence of the year.
 */
function weekToken(when: Date): string {
  // Copy to UTC midnight on the Thursday of the same ISO week as `when`.
  const t = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Sunday=0 → 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `week:${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function isChronicler(entity: Entity, db?: MarinaDB): boolean {
  // `entity.properties.role` is the nominal source, but the spawn path never
  // populates it — an agent's role lives on its AgentConfig. So fall back to
  // the config role, mirroring how entity-api resolves an entity's role. This
  // is what lets the seeded Chronicler agent (config.role="chronicler")
  // actually pass the write gate.
  if (entity.properties.role === CHRONICLER_ROLE) return true;
  return db?.getAgentConfig(entity.name)?.role === CHRONICLER_ROLE;
}

export function chronicleCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  /**
   * Participant-name → entity-id resolver. Used to flow `chronicled` standing
   * to cited entities. Optional — when absent, standing simply doesn't flow
   * (citation discipline still works, just without the reputation reward).
   */
  resolveEntityIdByName?: (name: string) => string | undefined;
}): CommandDef {
  return {
    name: "chronicle",
    aliases: [],
    help: HELP,
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("the chronicle"));
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();
      const now = Date.now();

      // `chronicle` with no arg — recent entries
      if (!sub) {
        const entries = db.queryChronicle({ limit: 20 });
        if (entries.length === 0) {
          ctx.send(
            input.entity,
            "The chronicle is empty. Civic events (task completions, crew lifecycle, rank changes, market consensus) will be recorded here as they happen.",
          );
          return;
        }
        const lines = [
          header(`Chronicle — recent (${entries.length} of ${db.getChronicleCount()})`),
          separator(),
          ...formatList(entries, now),
          "",
          dim("chronicle show <id> · chronicle since 24h · chronicle about <name>"),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "show") {
        const idArg = Number.parseInt(tokens[1] ?? "", 10);
        if (!Number.isFinite(idArg) || idArg <= 0) {
          ctx.send(input.entity, "Usage: chronicle show <id>");
          return;
        }
        const entry = db.getChronicleEntry(idArg);
        if (!entry) {
          ctx.send(input.entity, `No chronicle entry with id ${idArg}.`);
          return;
        }
        const corrections = db.getChronicleCorrectionsFor(entry.id);
        const lines: string[] = [
          header(`Chronicle #${entry.id} — ${kindLabel(entry.kind).trim()}`),
          separator(),
          `${bold("title:")}        ${entry.title}`,
          `${bold("when:")}         ${formatAge(now - entry.created_at)} ago (${new Date(entry.created_at).toISOString()})`,
          `${bold("source:")}       ${category(entry.source)}`,
        ];
        if (entry.period) lines.push(`${bold("period:")}       ${entry.period}`);
        if (entry.participants.length > 0) {
          lines.push(`${bold("participants:")} ${entry.participants.join(", ")}`);
        }
        if (entry.refs.length > 0) {
          lines.push(`${bold("refs:")}         ${entry.refs.join(", ")}`);
        }
        if (entry.supersedes) {
          lines.push(`${bold("supersedes:")}   #${entry.supersedes}`);
        }
        if (entry.body) {
          lines.push("", entry.body);
        }
        if (corrections.length > 0) {
          lines.push(
            "",
            dim(
              `↻ this entry has ${corrections.length} correction${corrections.length === 1 ? "" : "s"}:`,
            ),
            ...corrections.map(
              (c) =>
                `  ${dim(`#${c.id}`)} ${kindLabel(c.kind).trim()} ${c.title} ${dim(`(${formatAge(now - c.created_at)} ago)`)}`,
            ),
          );
        }
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "since") {
        const since = parseSince(tokens[1]);
        if (since === undefined) {
          ctx.send(input.entity, "Usage: chronicle since <30m|2h|7d|1w>");
          return;
        }
        const entries = db.queryChronicle({ since: now - since, limit: 100 });
        if (entries.length === 0) {
          ctx.send(input.entity, `Nothing chronicled in the last ${tokens[1]}.`);
          return;
        }
        const lines = [
          header(`Chronicle — last ${tokens[1]} (${entries.length} entries)`),
          separator(),
          ...formatList(entries, now),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "about") {
        const name = tokens[1];
        if (!name) {
          ctx.send(input.entity, "Usage: chronicle about <name>");
          return;
        }
        const entries = db.queryChronicle({ participant: name, limit: 50 });
        if (entries.length === 0) {
          ctx.send(input.entity, `Nothing in the chronicle involves ${name}.`);
          return;
        }
        const lines = [
          header(`Chronicle — about ${bold(name)} (${entries.length} entries)`),
          separator(),
          ...formatList(entries, now),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "kinds") {
        // Show distinct sources with counts
        const entries = db.queryChronicle({ limit: 200 });
        if (entries.length === 0) {
          ctx.send(input.entity, "The chronicle is empty.");
          return;
        }
        const counts = new Map<string, number>();
        for (const e of entries) counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const lines = [
          header(`Chronicle sources (sample of ${entries.length})`),
          separator(),
          ...sorted.map(([src, count]) => `  ${category(src.padEnd(24))} ${fmtId(count)}`),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── chronicle pending — the Chronicler's work queue ───────────────
      // Returns event-kind entries since the most recent narrative/digest, or
      // since `--since <dur>` if given. Rank 0 — anyone can inspect the queue.
      if (sub === "pending") {
        const rest = tokens.slice(1).join(" ");
        const { modifiers } = extractModifiers(rest, ["since", "limit"]);
        const sinceMs = parseSince(modifiers.since);

        let cursor: number;
        if (sinceMs !== undefined) {
          cursor = now - sinceMs;
        } else {
          // Cursor = the millisecond AFTER the most recent narrative/digest
          // (queryChronicle's `since` is inclusive — events at the exact
          // narrative timestamp count as pre-narrative, not post). Falls
          // back to 1 hour ago if no synthesis has happened yet.
          const recentNarrative = db.queryChronicle({ kind: "narrative", limit: 1 });
          const recentDigest = db.queryChronicle({ kind: "digest", limit: 1 });
          const lastSynth = Math.max(
            recentNarrative[0]?.created_at ?? 0,
            recentDigest[0]?.created_at ?? 0,
          );
          cursor = lastSynth > 0 ? lastSynth + 1 : now - 3_600_000;
        }

        const limitArg = Number.parseInt(modifiers.limit ?? "", 10);
        const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(limitArg, 50) : 20;
        const events = db.queryChronicle({ kind: "event", since: cursor, limit });

        if (events.length === 0) {
          ctx.send(
            input.entity,
            "Nothing pending — every engine event is already narrated. `chronicle` shows the recent record.",
          );
          return;
        }
        const sinceLabel =
          sinceMs !== undefined
            ? `last ${modifiers.since}`
            : `since last narrative (${formatAge(now - cursor)} ago)`;
        const lines = [
          header(
            `Pending — ${sinceLabel} (${events.length} event${events.length === 1 ? "" : "s"})`,
          ),
          separator(),
          ...formatList(events, now),
          "",
          dim("chronicle record <title> | <body> refs <feed:N,task:N,…> [participants <names>]"),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── chronicle record — write a narrative entry ────────────────────
      // Gated to entities with role=chronicler. Requires citation: `refs:` must
      // include at least one provenance id. This is the only write path for
      // free-form interpretation; everything else either auto-emits (engine)
      // or supersedes (correction).
      if (sub === "record") {
        if (!isChronicler(entity, deps.db)) {
          ctx.send(
            input.entity,
            "Only the Chronicler can record narratives. Use `chronicle` to read, `chronicle pending` to see the queue.",
          );
          return;
        }
        const rest = tokens.slice(1).join(" ");
        const { text: titleBody, modifiers } = extractModifiers(rest, ["refs", "participants"]);
        const parts = splitOn(titleBody, "|");
        if (!parts || parts[0].length === 0) {
          ctx.send(
            input.entity,
            "Usage: chronicle record <title> | <body> refs <feed:N,task:N,...> [participants <names>]",
          );
          return;
        }
        const refs = parseCsv(modifiers.refs);
        if (refs.length === 0) {
          ctx.send(
            input.entity,
            "A narrative must cite at least one source in refs:. Run `chronicle pending` for source ids.",
          );
          return;
        }
        const participants = parseCsv(modifiers.participants);
        const id = db.appendChronicle({
          kind: "narrative",
          source: "chronicler",
          title: parts[0],
          body: parts[1],
          refs,
          participants,
        });
        if (deps.resolveEntityIdByName && participants.length > 0) {
          recordChronicleCitation(
            db,
            { id, kind: "narrative", participants },
            deps.resolveEntityIdByName,
          );
        }
        ctx.send(
          input.entity,
          `Recorded #${id} — narrative cited ${refs.length} source${refs.length === 1 ? "" : "s"}.`,
        );
        return;
      }

      // ─── chronicle correct — supersede a prior narrative or digest ──────
      // Append-only: the prior entry is untouched; readers see the chain.
      if (sub === "correct") {
        if (!isChronicler(entity, deps.db)) {
          ctx.send(input.entity, "Only the Chronicler can record corrections.");
          return;
        }
        const priorId = Number.parseInt(tokens[1] ?? "", 10);
        if (!Number.isFinite(priorId) || priorId <= 0) {
          ctx.send(input.entity, "Usage: chronicle correct <id> <title> | <body> [refs <ids>]");
          return;
        }
        const prior = db.getChronicleEntry(priorId);
        if (!prior) {
          ctx.send(input.entity, `No chronicle entry with id ${priorId}.`);
          return;
        }
        if (prior.kind === "event") {
          ctx.send(
            input.entity,
            "Engine-emitted event entries are immutable. Corrections supersede narrative or digest entries.",
          );
          return;
        }
        const rest = tokens.slice(2).join(" ");
        const { text: titleBody, modifiers } = extractModifiers(rest, ["refs", "participants"]);
        const parts = splitOn(titleBody, "|");
        if (!parts || parts[0].length === 0) {
          ctx.send(
            input.entity,
            "Usage: chronicle correct <id> <title> | <body> [refs <ids>] [participants <names>]",
          );
          return;
        }
        const refs = parseCsv(modifiers.refs);
        const participants = parseCsv(modifiers.participants);
        const id = db.appendChronicle({
          kind: "correction",
          source: "chronicler",
          title: parts[0],
          body: parts[1],
          refs,
          participants,
          supersedes: priorId,
        });
        if (deps.resolveEntityIdByName && participants.length > 0) {
          recordChronicleCitation(
            db,
            { id, kind: "correction", participants },
            deps.resolveEntityIdByName,
          );
        }
        ctx.send(input.entity, `Recorded #${id} — supersedes #${priorId}.`);
        return;
      }

      // ─── chronicle digest — period summary ─────────────────────────────
      if (sub === "digest") {
        if (!isChronicler(entity, deps.db)) {
          ctx.send(input.entity, "Only the Chronicler can record digests.");
          return;
        }
        const periodKind = tokens[1]?.toLowerCase();
        if (periodKind !== "day" && periodKind !== "week") {
          ctx.send(
            input.entity,
            "Usage: chronicle digest day|week <title> | <body> [refs <ids>] [period <token>]",
          );
          return;
        }
        const rest = tokens.slice(2).join(" ");
        const { text: titleBody, modifiers } = extractModifiers(rest, [
          "refs",
          "participants",
          "period",
        ]);
        const parts = splitOn(titleBody, "|");
        if (!parts || parts[0].length === 0) {
          ctx.send(
            input.entity,
            "Usage: chronicle digest day|week <title> | <body> [refs <ids>] [period <token>]",
          );
          return;
        }
        const period =
          modifiers.period ??
          (periodKind === "day" ? dayToken(new Date(now)) : weekToken(new Date(now)));
        const refs = parseCsv(modifiers.refs);
        const participants = parseCsv(modifiers.participants);
        const id = db.appendChronicle({
          kind: "digest",
          source: "chronicler",
          title: parts[0],
          body: parts[1],
          refs,
          participants,
          period,
        });
        if (deps.resolveEntityIdByName && participants.length > 0) {
          recordChronicleCitation(
            db,
            { id, kind: "digest", participants },
            deps.resolveEntityIdByName,
          );
        }
        ctx.send(input.entity, `Recorded #${id} — digest for ${period}.`);
        return;
      }

      ctx.send(input.entity, HELP);
    },
  };
}
