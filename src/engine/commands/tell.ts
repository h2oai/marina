import { tell } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
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
  db?: MarinaDB;
}

function ttlMs(token: string | undefined): number | undefined {
  const match = /^--ttl=(\d+)(s|m|h)$/.exec(token ?? "");
  if (!match) return undefined;
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[match[2]!]!;
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
  deadlineMs?: number,
): number | undefined {
  const target = deps.findEntityGlobal(targetName);
  if (!target) {
    ctx.send(senderId, `No one named "${targetName}" is online.`);
    return undefined;
  }
  if (target.id === senderId) {
    ctx.send(senderId, "Talking to yourself again?");
    return undefined;
  }

  const correlationId = crypto.randomUUID();
  const receipt = deps.db?.createDirectMessage({
    correlationId,
    dedupeKey: Bun.hash(message.trim().toLowerCase()).toString(),
    senderId,
    senderName: sender.name,
    targetId: target.id,
    targetName: target.name,
    content: message,
    ...(deadlineMs ? { deadlineAt: Date.now() + deadlineMs } : {}),
  });
  if (receipt && receipt.correlation_id !== correlationId) {
    ctx.send(
      senderId,
      `Duplicate suppressed; existing message #${receipt.id} is ${receipt.status}.`,
    );
    return receipt.id;
  }

  deps.sendGlobal(target.id, tell(sender.name, message, "from"), senderId, "tell", {
    senderName: sender.name,
    message,
    messageId: receipt?.id,
    correlationId: receipt?.correlation_id,
    deadlineAt: receipt?.deadline_at,
  });
  // Record who just messaged the recipient so they can `re`ply without retyping
  // the name. Reply chains naturally: replying makes you their last sender too.
  const targetEntity = deps.getEntity(target.id);
  if (targetEntity) {
    targetEntity.properties.last_tell_from = sender.name;
    if (receipt) targetEntity.properties.last_tell_id = receipt.id;
  }

  ctx.send(
    senderId,
    `${tell(target.name, message, "to")}${receipt ? ` [delivered #${receipt.id}]` : ""}`,
    "tell",
  );
  return receipt?.id;
}

export function tellCommand(deps: TellDeps): CommandDef {
  return {
    name: "tell",
    aliases: ["whisper", "msg"],
    help: "Send durable private messages with delivery receipts. Usage: tell <entity> [--ttl=30s] <message> | tell inbox | tell status <id> | tell ack <id>",
    handler: (ctx: RoomContext, input) => {
      const sender = deps.getEntity(input.entity);
      if (!sender) return;

      const sub = input.tokens[0]?.toLowerCase();
      if (sub === "inbox") {
        const rows = deps.db?.listDirectMessageInbox(input.entity) ?? [];
        ctx.send(
          input.entity,
          rows.length === 0
            ? "Inbox is empty."
            : rows
                .map(
                  (row) =>
                    `#${row.id} ${row.status} from ${row.sender_name}: ${row.content.slice(0, 100)}`,
                )
                .join("\n"),
        );
        return;
      }
      if (sub === "status" || sub === "ack") {
        const id = Number(input.tokens[1]);
        if (!Number.isInteger(id) || !deps.db) {
          ctx.send(input.entity, `Usage: tell ${sub} <id>`);
          return;
        }
        const row = deps.db.getDirectMessage(id);
        if (!row) {
          ctx.send(input.entity, `Message #${id} not found.`);
          return;
        }
        if (sub === "ack") {
          const ok = deps.db.acknowledgeDirectMessage(id, input.entity);
          ctx.send(
            input.entity,
            ok ? `Acknowledged message #${id}.` : `Cannot acknowledge message #${id}.`,
          );
          if (ok) {
            const originalSender = deps.findEntityGlobal(row.sender_name);
            if (originalSender) {
              deps.sendGlobal(
                originalSender.id,
                `${sender.name} acknowledged message #${id}.`,
                input.entity,
                "tell_ack",
                { messageId: id, correlationId: row.correlation_id },
              );
            }
          }
          return;
        }
        if (row.sender_id !== input.entity && row.target_id !== input.entity) {
          ctx.send(input.entity, `Message #${id} is private.`);
          return;
        }
        ctx.send(
          input.entity,
          `Message #${id}: ${row.status} · ${row.sender_name} → ${row.target_name}${row.deadline_at ? ` · deadline ${new Date(row.deadline_at).toISOString()}` : ""}`,
        );
        return;
      }

      if (input.tokens.length < 2) {
        ctx.send(input.entity, "Tell whom what? Usage: tell <entity> <message>");
        return;
      }

      const targetName = input.tokens[0]!;
      const ttl = ttlMs(input.tokens[1]);
      const message = input.tokens.slice(ttl ? 2 : 1).join(" ");
      if (!message) {
        ctx.send(input.entity, "Tell whom what? Usage: tell <entity> [--ttl=30s] <message>");
        return;
      }
      deliverTell(deps, ctx, input.entity, sender, targetName, message, ttl);
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
      const priorId = Number(sender.properties.last_tell_id);
      const replyId = deliverTell(deps, ctx, input.entity, sender, lastFrom, message);
      if (deps.db && Number.isInteger(priorId)) {
        deps.db.acknowledgeDirectMessage(priorId, input.entity, replyId);
      }
    },
  };
}
