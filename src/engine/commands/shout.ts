import { shout, shoutSelf } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

export function shoutCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  broadcastAll: (senderId: EntityId, message: string, tag?: string) => void;
}): CommandDef {
  return {
    name: "shout",
    aliases: ["yell"],
    help: "Shout a message to all entities on the server. Usage: shout <message>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      if (!input.args) {
        ctx.send(input.entity, "Shout what?");
        return;
      }

      ctx.send(input.entity, shoutSelf(input.args), "shout");
      deps.broadcastAll(input.entity, shout(entity.name, input.args), "shout");
    },
  };
}
