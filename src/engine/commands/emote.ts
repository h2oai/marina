// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { emote } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

export function emoteCommand(getEntity: (id: EntityId) => Entity | undefined): CommandDef {
  return {
    name: "emote",
    aliases: ["me", "em"],
    help: "Broadcast an action in the third person. Usage: emote reviews the findings",
    handler: (ctx: RoomContext, input) => {
      const entity = getEntity(input.entity);
      if (!entity) return;

      if (!input.args) {
        ctx.send(input.entity, "Emote what?");
        return;
      }

      const msg = emote(entity.name, input.args);
      ctx.send(input.entity, msg, "emote");
      ctx.broadcastExcept(input.entity, msg, "emote");
    },
  };
}
