import { header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext, RoomId } from "../../types";
import { getRank, requireRank } from "../permissions";

export function observeCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  findEntity: (name: string) => Entity | undefined;
  db?: MarinaDB;
  getOnlineAgents: () => Entity[];
  getRoomShort: (id: RoomId) => string | undefined;
  getEventLog: () => { type: string; entity?: EntityId; input?: string; timestamp: number }[];
}): CommandDef {
  return {
    name: "observe",
    aliases: [],
    help: "Observe agents. Usage: observe <entity> | observe stats | observe log <entity>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(input.entity, "Usage: observe <entity> | observe stats | observe log <entity>");
        return;
      }

      switch (sub) {
        case "stats": {
          if (!requireRank(entity, 2)) {
            ctx.send(input.entity, "Requires coordinator rank (2+).");
            return;
          }
          const agents = deps.getOnlineAgents();
          const events = deps.getEventLog();
          const commandEvents = events.filter((e) => e.type === "command");
          const uniqueEntities = new Set(commandEvents.map((e) => e.entity)).size;

          // Most visited rooms
          const roomCounts = new Map<string, number>();
          for (const e of events) {
            if (e.type === "entity_enter" && "room" in e) {
              const room = (e as { room: string }).room;
              roomCounts.set(room, (roomCounts.get(room) ?? 0) + 1);
            }
          }
          const topRooms = [...roomCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

          const now = Date.now();
          const recentCmds = commandEvents.filter((e) => now - e.timestamp < 60000).length;

          const lines = [
            header("Server Statistics"),
            separator(),
            `  Online agents: ${agents.length}`,
            `  Total commands: ${commandEvents.length}`,
            `  Unique entities: ${uniqueEntities}`,
            `  Commands/min: ${recentCmds}`,
          ];
          if (topRooms.length > 0) {
            lines.push("  Most visited spaces:");
            for (const [room, count] of topRooms) {
              const name = deps.getRoomShort(room as RoomId) ?? room;
              lines.push(`    ${name}: ${count} visits`);
            }
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "log": {
          if (!requireRank(entity, 7)) {
            ctx.send(input.entity, "Requires steward rank (7).");
            return;
          }
          const targetName = tokens[1];
          if (!targetName) {
            ctx.send(input.entity, "Usage: observe log <entity>");
            return;
          }
          const target = deps.findEntity(targetName);
          if (!target) {
            ctx.send(input.entity, `Entity "${targetName}" not found online.`);
            return;
          }

          // Get from in-memory event log
          const events = deps.getEventLog();
          const entityEvents = events
            .filter((e) => e.type === "command" && e.entity === target.id)
            .slice(-20);

          if (entityEvents.length === 0) {
            ctx.send(input.entity, `No recent commands from ${target.name}.`);
            return;
          }
          const lines = [
            header(`Command Log: ${target.name}`),
            separator(),
            ...entityEvents.map((e) => {
              const time = new Date(e.timestamp).toISOString().slice(11, 19);
              return `  [${time}] ${e.input ?? "?"}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        default: {
          // observe <entity> — requires rank 3+
          if (!requireRank(entity, 3)) {
            ctx.send(input.entity, "Requires organizer rank (3+).");
            return;
          }
          const target = deps.findEntity(sub);
          if (!target) {
            ctx.send(input.entity, `Entity "${sub}" not found online.`);
            return;
          }

          const roomName = deps.getRoomShort(target.room) ?? target.room;
          const rank = getRank(target);

          // Find last command from event log
          const events = deps.getEventLog();
          const lastCmd = events
            .filter((e) => e.type === "command" && e.entity === target.id)
            .pop();

          const lines = [
            header(`Observing: ${target.name}`),
            separator(),
            `  Room: ${roomName} (${target.room})`,
            `  Rank: ${rank}`,
          ];
          if (lastCmd) {
            const ago = Math.floor((Date.now() - lastCmd.timestamp) / 1000);
            lines.push(`  Last command: ${lastCmd.input ?? "?"} (${ago}s ago)`);
          }
          const sessionTime = Math.floor((Date.now() - target.createdAt) / 1000);
          lines.push(`  Session time: ${sessionTime}s`);
          ctx.send(input.entity, lines.join("\n"));
        }
      }
    },
  };
}
