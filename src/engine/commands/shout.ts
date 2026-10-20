// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { shout, shoutSelf } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { envelopeFields, messageEnvelope, mintMessageRef } from "../message-envelope";

export function shoutCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  broadcastAll: (
    senderId: EntityId,
    message: string,
    tag?: string,
    metadata?: Record<string, unknown>,
  ) => void;
}): CommandDef {
  return {
    category: "Communication",
    usage: [{ syntax: "shout <message>", effect: "write" }],
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

      const meta = {
        senderName: entity.name,
        messageRef: mintMessageRef("shout"),
        ...envelopeFields(messageEnvelope(input.entity)),
      };
      ctx.send(input.entity, shoutSelf(input.args), "shout", meta);
      deps.broadcastAll(input.entity, shout(entity.name, input.args), "shout", meta);
    },
  };
}
