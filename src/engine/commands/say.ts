import { say, saySelf } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

export function sayCommand(getEntity: (id: EntityId) => Entity | undefined): CommandDef {
  return {
    name: "say",
    aliases: ["'"],
    help: "Say something to everyone in the space. Usage: say <message>",
    handler: (ctx: RoomContext, input) => {
      const entity = getEntity(input.entity);
      if (!entity) return;

      if (!input.args) {
        ctx.send(input.entity, "Say what?");
        return;
      }

      ctx.send(input.entity, saySelf(input.args), "say");
      ctx.broadcastExcept(input.entity, say(entity.name, input.args), "say");
    },
  };
}
