import { tell } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

export function tellCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  findEntityGlobal: (name: string) => { id: EntityId; name: string } | undefined;
  sendGlobal: (
    target: EntityId,
    message: string,
    senderId: EntityId,
    tag?: string,
    metadata?: Record<string, unknown>,
  ) => void;
}): CommandDef {
  return {
    name: "tell",
    aliases: ["whisper", "msg"],
    help: "Send a private message. Usage: tell <entity> <message>",
    handler: (ctx: RoomContext, input) => {
      const sender = deps.getEntity(input.entity);
      if (!sender) return;

      if (input.tokens.length < 2) {
        ctx.send(input.entity, "Tell whom what? Usage: tell <entity> <message>");
        return;
      }

      const targetName = input.tokens[0]!;
      const message = input.tokens.slice(1).join(" ");

      const target = deps.findEntityGlobal(targetName);
      if (!target) {
        ctx.send(input.entity, `No one named "${targetName}" is online.`);
        return;
      }

      if (target.id === input.entity) {
        ctx.send(input.entity, "Talking to yourself again?");
        return;
      }

      deps.sendGlobal(target.id, tell(sender.name, message, "from"), input.entity, "tell", {
        senderName: sender.name,
        message,
      });
      ctx.send(input.entity, tell(target.name, message, "to"), "tell");
    },
  };
}
