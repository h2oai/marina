import type { Board } from "../../coordination/board-manager";
import {
  boardTag,
  bold as fmtBold,
  dim as fmtDim,
  entity as fmtEntity,
  exits as fmtExits,
  sectionHead as fmtSectionHead,
  roomTitle,
} from "../../net/ansi";
import type { CommandDef, EntityId, RoomContext, RoomPerception } from "../../types";
import type { LoadedRoom } from "../../world/room-manager";

export function lookCommand(
  getRoom: (entity: EntityId) => LoadedRoom | undefined,
  getRoomBoards?: (roomId: string) => Board[],
): CommandDef {
  return {
    name: "look",
    aliases: ["l"],
    help: "Look at the space or examine something. Usage: look [target]",
    handler: (ctx: RoomContext, input) => {
      const room = getRoom(input.entity);
      if (!room) {
        ctx.send(input.entity, "You are nowhere.");
        return;
      }

      // look at specific item or entity
      if (input.args) {
        // Check room items
        const items = room.module.items ?? {};
        const target = input.args.toLowerCase();
        for (const [name, desc] of Object.entries(items)) {
          if (name.toLowerCase().includes(target)) {
            const text = typeof desc === "function" ? desc(ctx, input.entity) : desc;
            ctx.send(input.entity, text);
            return;
          }
        }

        // Check entities in room
        const entity = ctx.findEntity(input.args);
        if (entity) {
          ctx.send(input.entity, `${entity.name}: ${entity.long}`);
          return;
        }

        ctx.send(input.entity, "You don't see that here.");
        return;
      }

      // Full room look
      const long =
        typeof room.module.long === "function"
          ? room.module.long(ctx, input.entity)
          : room.module.long;

      const exits = Object.keys(room.module.exits ?? {});
      const others = ctx.entities.filter((e) => e.id !== input.entity);

      const perception: RoomPerception = {
        kind: "room",
        timestamp: Date.now(),
        data: {
          id: room.id,
          short: room.module.short,
          long,
          items: resolveItems(room.module.items ?? {}, ctx, input.entity),
          exits,
          entities: others.map((e) => ({ id: e.id, name: e.name, short: e.short })),
        },
      };

      let text = formatRoom(perception);

      // Append boards if available
      if (getRoomBoards) {
        const roomBoards = getRoomBoards(room.id as string);
        if (roomBoards.length > 0) {
          const names = roomBoards.map((b) => b.name).join(", ");
          text += `\n${boardTag(names)}`;
        }
      }

      ctx.send(input.entity, text);
    },
  };
}

function resolveItems(
  items: Record<string, string | ((ctx: RoomContext, viewer: EntityId) => string)>,
  ctx: RoomContext,
  viewer: EntityId,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(items)) {
    resolved[k] = typeof v === "function" ? v(ctx, viewer) : v;
  }
  return resolved;
}

function formatRoom(p: RoomPerception): string {
  const lines: string[] = [];
  lines.push(roomTitle(p.data.short));
  lines.push(p.data.long as string);

  // Entities — compact list
  if (p.data.entities.length > 0) {
    const entList = p.data.entities.map((e) => {
      const short = e.short && e.short !== `${e.name} is here.` ? ` ${fmtDim(`— ${e.short}`)}` : "";
      return `${fmtEntity(e.name)}${short}`;
    });
    lines.push(`\n${fmtSectionHead("Present", 30)}`);
    // Show as comma-separated if 3 or fewer, otherwise one per line
    if (entList.length <= 3) {
      lines.push(`  ${entList.join(`${fmtDim(",")} `)}`);
    } else {
      for (const ent of entList) lines.push(`  ${ent}`);
    }
  }

  // Items — show with descriptions
  const entries = Object.entries(p.data.items);
  if (entries.length > 0) {
    lines.push(`\n${fmtSectionHead("Items", 30)}`);
    for (const [name, desc] of entries) {
      const truncated =
        typeof desc === "string" && desc.length > 70 ? `${desc.slice(0, 67)}...` : desc;
      lines.push(`  ${fmtBold(name)} ${fmtDim(`— ${truncated}`)}`);
    }
  }

  // Exits
  if (p.data.exits.length > 0) {
    lines.push(`\n${fmtExits(p.data.exits.join(", "))}`);
  } else {
    lines.push(fmtExits("none"));
  }

  return lines.join("\n");
}
