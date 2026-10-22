// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { tell } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { failCommandResponse } from "../command-response";
import { getCurrentMessageCause } from "../gate-context";
import {
  envelopeFields,
  envelopeFor,
  type MessageCause,
  type MessageEnvelope,
} from "../message-envelope";
import { parseModifiers } from "../parse-input";

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
  /**
   * Whether an entity is driven by an agent (internal resident, MCP or a
   * client that declared itself an agent, or an account with an agent config
   * or principal). Without it no tell is treated as agent-to-agent.
   */
  isAgent?: (id: EntityId) => boolean;
}

/** How far back a tell between two agents still continues their conversation. */
export const PEER_THREAD_WINDOW_MS = 30 * 60_000;

/**
 * The envelope of a tell between two agents that names no cause: it continues
 * the pair's conversation. Answering the other side's latest tell (within
 * {@link PEER_THREAD_WINDOW_MS}) is one level deeper; a second tell in a row
 * keeps the sender's own depth; nothing recent starts a thread at depth 0.
 * The cause stays unset — nobody named the message being answered — but the
 * depth lets attention bound agent-only reply chains (`peerReplyDepthLimit`
 * in `src/agent/attention.ts`). A person on either side resets the chain:
 * their tells always start at depth 0.
 */
function conversationEnvelope(
  db: MarinaDB,
  senderId: EntityId,
  targetId: EntityId,
  now = Date.now(),
): MessageEnvelope {
  const prior = db.latestDirectMessageBetween(senderId, targetId, now - PEER_THREAD_WINDOW_MS);
  if (!prior) return { depth: 0 };
  const depth = Math.max(0, prior.depth ?? 0);
  return { depth: prior.sender_id === targetId ? depth + 1 : depth };
}

const TELL_USAGE = "Usage: tell <entity> [ttl:30s] <message>   (also --ttl=30s)";

/**
 * Deliver a private message from `sender` to the named target. Shared by `tell`
 * and `re`. On success it records the sender's name on the recipient as
 * `last_tell_from`, so the recipient can reply with `re <message>`.
 *
 * The message records its causal envelope (`src/engine/message-envelope.ts`):
 * `cause` names the message it answers — `re` passes the tell it replies to,
 * otherwise the current command execution's cause applies — and emits one
 * content-free `tell_sent` event.
 */
export function deliverTell(
  deps: TellDeps,
  ctx: RoomContext,
  senderId: EntityId,
  sender: Entity,
  targetName: string,
  message: string,
  deadlineMs?: number,
  cause?: MessageCause,
): number | undefined {
  const target = deps.findEntityGlobal(targetName);
  if (!target) {
    // A refusal fails the command's result, so a correlated client (the
    // resident command relay, MCP, the SDK) reports it rather than success.
    const refusal = `No one named "${targetName}" is online.`;
    ctx.send(senderId, refusal);
    failCommandResponse(refusal);
    return undefined;
  }
  if (target.id === senderId) {
    ctx.send(senderId, "Talking to yourself again?");
    failCommandResponse("A tell needs another recipient.");
    return undefined;
  }

  // A named cause (an explicit reply, or the command execution's) wins; a
  // tell between two agents that names none continues their conversation.
  const named = cause ?? getCurrentMessageCause(senderId);
  const senderIsAgent = deps.isAgent?.(senderId) ?? false;
  const envelope =
    named || !deps.db || !senderIsAgent || !deps.isAgent?.(target.id)
      ? envelopeFor(named)
      : conversationEnvelope(deps.db, senderId, target.id);
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
    ...envelopeFields(envelope),
  });
  if (receipt && receipt.correlation_id !== correlationId) {
    ctx.send(
      senderId,
      `Duplicate suppressed; existing message #${receipt.id} is ${receipt.status}.`,
    );
    return receipt.id;
  }

  // A world without a database has no stored id; the ref is still unique.
  const messageRef = receipt ? `tell:${receipt.id}` : `tell:${correlationId}`;
  deps.sendGlobal(target.id, tell(sender.name, message, "from"), senderId, "tell", {
    senderName: sender.name,
    to: target.name,
    message,
    messageId: receipt?.id,
    correlationId: receipt?.correlation_id,
    deadlineAt: receipt?.deadline_at,
    messageRef,
    // Server-stamped (never peer text): attention bounds agent-only chains.
    ...(deps.isAgent ? { senderKind: senderIsAgent ? "agent" : "person" } : {}),
    ...envelopeFields(envelope),
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
    {
      delivery: { kind: "tell", target: target.name, message },
      messageRef,
      ...envelopeFields(envelope),
    },
  );
  ctx.logEvent?.({
    type: "tell_sent",
    entity: senderId,
    from: sender.name,
    to: target.name,
    messageRef,
    ...envelopeFields(envelope),
    timestamp: Date.now(),
  });
  return receipt?.id;
}

export function tellCommand(deps: TellDeps): CommandDef {
  return {
    category: "Communication",
    usage: [
      { syntax: "tell <entity> [ttl:30s] <message>", effect: "write" },
      { syntax: "tell ack <id>", effect: "write" },
      { syntax: "tell inbox", effect: "read" },
      { syntax: "tell status <id>", effect: "read" },
    ],
    name: "tell",
    aliases: ["whisper", "msg"],
    help: "Send durable private messages with delivery receipts. Usage: tell <entity> [ttl:30s] <message> | tell inbox | tell status <id> | tell ack <id>\n(ttl also accepts --ttl 30s / --ttl=30s; units 30s, 5m, 2h, 1d)",
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
          `Message #${id}: ${row.status}${lateAnswer(row) ? " after its deadline" : ""} · ${row.sender_name} → ${row.target_name}${row.deadline_at ? ` · deadline ${new Date(row.deadline_at).toISOString()}` : ""}`,
        );
        return;
      }

      if (input.tokens.length < 2) {
        ctx.send(input.entity, `Tell whom what? ${TELL_USAGE}`);
        return;
      }

      const targetName = input.tokens[0]!;
      // Only LEADING modifiers are parsed — a `ttl:` inside the message is text.
      const { values, rest, errors } = parseModifiers(
        input.tokens.slice(1),
        { ttl: { type: "duration" } },
        { leading: true },
      );
      if (errors.length > 0) {
        ctx.send(input.entity, `tell: ${errors.join("; ")}. ${TELL_USAGE}`);
        return;
      }
      const ttl = values.ttl as number | undefined;
      const message = rest.join(" ");
      if (!message) {
        ctx.send(input.entity, `Tell whom what? ${TELL_USAGE}`);
        return;
      }
      deliverTell(deps, ctx, input.entity, sender, targetName, message, ttl);
    },
  };
}

/** Answered, but only after the deadline had passed. */
function lateAnswer(row: {
  status: string;
  deadline_at: number | null;
  acknowledged_at: number | null;
}) {
  return (
    row.status === "acknowledged" &&
    row.deadline_at !== null &&
    row.acknowledged_at !== null &&
    row.acknowledged_at > row.deadline_at
  );
}

export function replyCommand(deps: TellDeps): CommandDef {
  return {
    category: "Communication",
    usage: [
      { syntax: "re <message>", effect: "write" },
      { syntax: "re #<id> <message>", effect: "write" },
    ],
    name: "re",
    aliases: ["reply"],
    help: "Reply to the last person who sent you a tell, or to one tell by id. Usage: re <message> | re #<id> <message>",
    handler: (ctx: RoomContext, input) => {
      const sender = deps.getEntity(input.entity);
      if (!sender) return;

      // `re #<id> <message>`: answer (and acknowledge) one stored tell
      // addressed to you, whoever sent you something since.
      const pinned = /^#(\d+)$/.exec(input.tokens[0] ?? "");
      if (pinned) {
        const id = Number(pinned[1]);
        const row = deps.db?.getDirectMessage(id);
        if (
          !row ||
          (row.target_id !== input.entity &&
            row.target_name.toLowerCase() !== sender.name.toLowerCase())
        ) {
          ctx.send(input.entity, `No tell #${id} addressed to you.`);
          failCommandResponse(`No tell #${id} addressed to you.`);
          return;
        }
        const message = input.tokens.slice(1).join(" ");
        if (!message) {
          ctx.send(input.entity, `Reply what? Usage: re #${id} <message>`);
          return;
        }
        const replyId = deliverTell(
          deps,
          ctx,
          input.entity,
          sender,
          row.sender_name,
          message,
          undefined,
          { ref: `tell:${row.id}`, depth: row.depth ?? 0 },
        );
        if (replyId !== undefined) deps.db?.acknowledgeDirectMessage(id, input.entity, replyId);
        return;
      }

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
      // The reply's cause is the tell it answers (the explicit reply path of
      // src/engine/message-envelope.ts) — only a stored tell addressed to us.
      const prior =
        Number.isInteger(priorId) && deps.db ? deps.db.getDirectMessage(priorId) : undefined;
      const cause =
        prior &&
        (prior.target_id === input.entity ||
          prior.target_name.toLowerCase() === sender.name.toLowerCase())
          ? { ref: `tell:${prior.id}`, depth: prior.depth ?? 0 }
          : undefined;
      const replyId = deliverTell(
        deps,
        ctx,
        input.entity,
        sender,
        lastFrom,
        message,
        undefined,
        cause,
      );
      if (deps.db && Number.isInteger(priorId)) {
        deps.db.acknowledgeDirectMessage(priorId, input.entity, replyId);
      }
    },
  };
}
