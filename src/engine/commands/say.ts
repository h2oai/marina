// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { say, saySelf } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { envelopeFields, messageEnvelope, mintMessageRef } from "../message-envelope";

export function sayCommand(getEntity: (id: EntityId) => Entity | undefined): CommandDef {
  return {
    category: "Communication",
    usage: [{ syntax: "say <message>", effect: "write" }],
    name: "say",
    aliases: [],
    help: "Say something to everyone in the space. Usage: say <message>",
    handler: (ctx: RoomContext, input) => {
      const entity = getEntity(input.entity);
      if (!entity) return;

      if (!input.args) {
        ctx.send(input.entity, "Say what?");
        return;
      }

      const messageRef = mintMessageRef("say");
      const envelope = envelopeFields(messageEnvelope(input.entity));
      // The words go in the perception data too (only those present get it, and
      // they already read them in the text): attention reads a vocative
      // ("Fern, …") from `message`, so without it no say is ever addressed.
      ctx.broadcastExcept(input.entity, say(entity.name, input.args), "say", {
        senderName: entity.name,
        message: input.args,
        messageRef,
        ...envelope,
      });
      ctx.send(input.entity, saySelf(input.args), "say", {
        delivery: { kind: "say", target: entity.room, message: input.args },
        messageRef,
        ...envelope,
      });
      ctx.logEvent?.({
        type: "say_sent",
        entity: input.entity,
        from: entity.name,
        room: entity.room,
        messageRef,
        ...envelope,
        timestamp: Date.now(),
      });
    },
  };
}
