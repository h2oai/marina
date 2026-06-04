import { header, separator } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

export function inventoryCommand(getEntity: (id: EntityId) => Entity | undefined): CommandDef {
  return {
    name: "inventory",
    aliases: ["i", "inv"],
    help: "View what you are carrying.",
    handler: (ctx: RoomContext, input) => {
      const entity = getEntity(input.entity);
      if (!entity) return;

      if (entity.inventory.length === 0) {
        ctx.send(input.entity, "You are not carrying anything.");
        return;
      }

      const lines = [
        header("Inventory"),
        separator(30),
        ...entity.inventory.map((itemId) => {
          const item = getEntity(itemId);
          return item ? `  ${item.name}` : `  [unknown: ${itemId}]`;
        }),
      ];
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
