// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { category, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext, RoomId } from "../../types";

export function searchCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  getAllRooms: () => { id: RoomId; short: string; long: string }[];
}): CommandDef {
  return {
    name: "search",
    aliases: [],
    help: "Global search across rooms, boards, channels, tasks, markets, open pools, and the chronicle. Usage: search <query>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const query = input.args.trim();
      if (!query) {
        ctx.send(input.entity, "Usage: search <query>");
        return;
      }

      const lines: string[] = [header(`Search: "${query}"`), separator()];
      let totalResults = 0;

      // 1. Search rooms (in-memory)
      const lowerQuery = query.toLowerCase();
      const rooms = deps.getAllRooms();
      const matchingRooms = rooms.filter(
        (r) =>
          r.short.toLowerCase().includes(lowerQuery) ||
          (typeof r.long === "string" && r.long.toLowerCase().includes(lowerQuery)),
      );
      if (matchingRooms.length > 0) {
        lines.push(category("Rooms"));
        for (const r of matchingRooms.slice(0, 5)) {
          lines.push(`  ${r.id}: ${r.short}`);
          totalResults++;
        }
      }

      // 2. Search DB. Without a DB this surface is room-only — say so rather
      // than silently omitting the other sections.
      if (!deps.db) {
        lines.push(
          dim("(boards, channels, tasks, markets, pools not searched — no database backend)"),
        );
      }
      if (deps.db) {
        const dbResults = deps.db.globalSearch(query);
        const sections: { type: string; label: string }[] = [
          { type: "board_post", label: "Board Posts" },
          { type: "channel_message", label: "Channel Messages" },
          { type: "task", label: "Tasks" },
          { type: "market", label: "Markets" },
          { type: "pool_note", label: "Pool Notes" },
          { type: "chronicle", label: "Chronicle" },
        ];
        for (const section of sections) {
          const hits = dbResults.filter((r) => r.type === section.type);
          if (hits.length === 0) continue;
          lines.push(category(section.label));
          for (const r of hits) {
            lines.push(`  [${r.context}] ${r.title}`);
            totalResults++;
          }
        }
      }

      if (totalResults === 0) {
        ctx.send(input.entity, `No results found for "${query}".`);
      } else {
        lines.push(`\n${totalResults} result(s) found.`);
        ctx.send(input.entity, lines.join("\n"));
      }
    },
  };
}
