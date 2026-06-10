import { tell } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

export interface TellDeps {
  getEntity: (id: EntityId) => Entity | undefined;
  findEntityGlobal: (name: string) => { id: EntityId; name: string } | undefined;
  sendGlobal: (
    target: EntityId,
    message: string,
    senderId: EntityId,
    tag?: string,
    metadata?: Record<string, unknown>,
  ) => void;
}

/**
 * Deliver a private message from `sender` to the named target. Shared by `tell`
 * and `re`. On success it records the sender's name on the recipient as
 * `last_tell_from`, so the recipient can reply with `re <message>`.
 */
export function deliverTell(
  deps: TellDeps,
  ctx: RoomContext,
  senderId: EntityId,
  sender: Entity,
  targetName: string,
  message: string,
): void {
  const target = deps.findEntityGlobal(targetName);
  if (!target) {
    ctx.send(senderId, `No one named "${targetName}" is online.`);
    return;
  }
  if (target.id === senderId) {
    ctx.send(senderId, "Talking to yourself again?");
    return;
  }

  deps.sendGlobal(target.id, tell(sender.name, message, "from"), senderId, "tell", {
    senderName: sender.name,
    message,
  });
  // Record who just messaged the recipient so they can `re`ply without retyping
  // the name. Reply chains naturally: replying makes you their last sender too.
  const targetEntity = deps.getEntity(target.id);
  if (targetEntity) targetEntity.properties.last_tell_from = sender.name;

  ctx.send(senderId, tell(target.name, message, "to"), "tell");
}

export function tellCommand(deps: TellDeps): CommandDef {
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
      deliverTell(deps, ctx, input.entity, sender, targetName, message);
    },
  };
}

export function replyCommand(deps: TellDeps): CommandDef {
  return {
    name: "re",
    aliases: ["reply"],
    help: "Reply to the last person who sent you a tell. Usage: re <message>",
    handler: (ctx: RoomContext, input) => {
      const sender = deps.getEntity(input.entity);
      if (!sender) return;

      const lastFrom = sender.properties.last_tell_from;
      if (!lastFrom) {
        ctx.send(input.entity, "No one has sent you a tell yet — nothing to reply to.");
        return;
      }
      if (input.tokens.length < 1) {
        ctx.send(input.entity, `Reply what? Usage: re <message> (replying to ${lastFrom})`);
        return;
      }

      const message = input.tokens.join(" ");
      deliverTell(deps, ctx, input.entity, sender, lastFrom, message);
    },
  };
}
