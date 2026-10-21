// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EntityId } from "../../types";
import { isIgnoring } from "../commands/ignore";
import type { TellDeps } from "../commands/tell";
import type { Engine } from "../engine";

/** What `tell` needs from the engine; shared by every command that delivers one. */
export function engineTellDeps(engine: Engine): TellDeps {
  return {
    getEntity: (id: EntityId) => engine.entities.get(id),
    findEntityGlobal: (name: string) => {
      const e = engine.findEntityGlobal(name);
      return e ? { id: e.id, name: e.name } : undefined;
    },
    sendGlobal: (
      target: EntityId,
      msg: string,
      senderId: EntityId,
      tag?: string,
      metadata?: Record<string, unknown>,
    ) => {
      const targetEntity = engine.entities.get(target);
      const sender = engine.entities.get(senderId);
      if (targetEntity && sender && isIgnoring(targetEntity, sender.name)) return;
      engine.sendToEntity(target, msg, tag, metadata);
    },
    db: engine.db,
  };
}
