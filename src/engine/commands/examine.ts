import { dim, entity as fmtEntity, header, separator } from "../../net/ansi";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import type { LoadedRoom } from "../../world/room-manager";
import { normalizeLookTarget } from "./look";

export function examineCommand(getRoom: (entity: EntityId) => LoadedRoom | undefined): CommandDef {
  return {
    name: "examine",
    aliases: ["ex", "x"],
    help: "Examine something closely. Usage: examine <target>",
    handler: (ctx: RoomContext, input) => {
      // Accept "examine at the builder" as well as "examine builder".
      const target = normalizeLookTarget(input.args);
      if (!target) {
        ctx.send(input.entity, "Examine what?");
        return;
      }

      const room = getRoom(input.entity);
      if (!room) return;

      // Check entities
      const entity = ctx.findEntity(target);
      if (entity) {
        const lines = [
          header(fmtEntity(entity.name)),
          separator(30),
          entity.long,
          dim(`Kind: ${entity.kind}`),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // Check room items
      const items = room.module.items ?? {};
      for (const [name, desc] of Object.entries(items)) {
        if (name.toLowerCase().includes(target)) {
          const text = typeof desc === "function" ? desc(ctx, input.entity) : desc;
          ctx.send(input.entity, text);
          return;
        }
      }

      ctx.send(input.entity, "You don't see that here.");
    },
  };
}
