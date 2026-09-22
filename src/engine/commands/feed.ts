// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, category, dim, id as fmtId, header, separator, status } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { canonicalSub, parseModifiers, unknownSubcommand } from "../parse-input";
import { requiresPersistence } from "./command-messages";
import { formatAge } from "./format-duration";

const HELP = `Activity feed — queryable timeline of world events.
Usage:
  feed                                  — recent events (last 30 minutes)
  feed list [kind:X] [entity:Y] [since:30m|1h|2d] [limit:20]   (also --kind X)
  feed kinds                            — show distinct event kinds in the store

Examples:
  feed                                      — last 30m, newest first
  feed list kind:market_position limit:10
  feed list entity:alice since:2h
  feed list --since 1h                      — all events in the last hour`;

const FEED_SUBS = ["list", "kinds"];

export function feedCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "feed",
    aliases: [],
    help: HELP,
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("the feed"));
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = canonicalSub(tokens[0], FEED_SUBS);

      // `feed` with no arg = `feed list` with defaults. A leading modifier
      // (`feed since:1h`) is also a list.
      if (
        !sub ||
        sub === "list" ||
        /^(?:--(?:kind|entity|since|limit)(?:=|$)|(?:kind|entity|since|limit)[:=])/.test(sub)
      ) {
        const argTokens = sub === "list" ? tokens.slice(1) : tokens;
        const { values, raw, errors } = parseModifiers(argTokens, {
          kind: { type: "string" },
          entity: { type: "string" },
          since: { type: "duration" },
          limit: { type: "int" },
        });
        if (errors.length > 0) {
          ctx.send(input.entity, `feed: ${errors.join("; ")}`);
          return;
        }
        const modifiers = {
          kind: values.kind as string | undefined,
          entity: values.entity as string | undefined,
          since: raw.since,
        };

        const sinceMs = (values.since as number | undefined) ?? 30 * 60_000;
        const limitArg = values.limit as number | undefined;
        const limit = limitArg !== undefined && limitArg > 0 ? Math.min(limitArg, 200) : 20;

        const events = db.queryFeedEvents({
          since: Date.now() - sinceMs,
          kind: modifiers.kind,
          entity: modifiers.entity,
          limit,
        });

        if (events.length === 0) {
          const filters: string[] = [];
          if (modifiers.kind) filters.push(`kind=${modifiers.kind}`);
          if (modifiers.entity) filters.push(`entity=${modifiers.entity}`);
          ctx.send(
            input.entity,
            `No feed events${filters.length ? ` matching ${filters.join(", ")}` : ""} in the last ${modifiers.since ?? "30m"}.`,
          );
          return;
        }

        const now = Date.now();
        const lines = [
          header(
            `Feed — last ${modifiers.since ?? "30m"} (${events.length} event${events.length === 1 ? "" : "s"})`,
          ),
          separator(),
          ...events.map((e) => {
            const age = dim(formatAge(now - e.created_at).padStart(4));
            const kind = status(e.kind.padEnd(18), "info");
            const ent = e.entity ? bold(e.entity) : dim("system");
            const trimmed = e.summary.length > 80 ? `${e.summary.slice(0, 77)}…` : e.summary;
            return `  ${age} ${kind} ${ent}: ${trimmed}`;
          }),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "kinds") {
        // Show distinct kinds with counts from the last 24 hours
        const events = db.queryFeedEvents({
          since: Date.now() - 24 * 3_600_000,
          limit: 500,
        });
        if (events.length === 0) {
          ctx.send(input.entity, "No feed events in the last 24 hours.");
          return;
        }
        const counts = new Map<string, number>();
        for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const lines = [
          header("Feed event kinds (last 24h)"),
          separator(),
          ...sorted.map(([kind, count]) => `  ${category(kind.padEnd(24))} ${fmtId(count)}`),
          "",
          dim("Filter with: feed list kind:<name>"),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      ctx.send(input.entity, unknownSubcommand("feed", tokens[0], HELP));
    },
  };
}
