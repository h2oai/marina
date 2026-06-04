import { category, header, separator } from "../../net/ansi";
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
    help: "Global search across boards, spaces, and channels. Usage: search <query>",
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

      // 2. Search DB (boards + channels)
      if (deps.db) {
        const dbResults = deps.db.globalSearch(query);
        const boardResults = dbResults.filter((r) => r.type === "board_post");
        const channelResults = dbResults.filter((r) => r.type === "channel_message");

        if (boardResults.length > 0) {
          lines.push(category("Board Posts"));
          for (const r of boardResults) {
            lines.push(`  [${r.context}] ${r.title}`);
            totalResults++;
          }
        }

        if (channelResults.length > 0) {
          lines.push(category("Channel Messages"));
          for (const r of channelResults) {
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
