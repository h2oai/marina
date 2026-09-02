// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CrewManager } from "../../coordination/crew-manager";
import type { TaskManager } from "../../coordination/task-manager";
import { nextWorkItem } from "../../coordination/work-loop";
import { bold, dim } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import type { QuestDef } from "../../world/world-definition";

interface NextDeps {
  getEntity: (id: EntityId) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  crewManager?: CrewManager;
  quests?: QuestDef[];
  startRoom?: string;
}

export function nextCommand(deps: NextDeps): CommandDef {
  return {
    name: "next",
    aliases: [],
    help: "Context-aware suggestion — tells you the single best thing to do right now.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const db = deps.db;

      const arrow = dim("\u2192");
      const item = nextWorkItem(entity, {
        db,
        taskManager: deps.taskManager,
        crewManager: deps.crewManager,
        quests: deps.quests,
        startRoom: deps.startRoom,
        peers: ctx.entities,
      });
      const detail = item.detail ? `: ${truncate(item.detail, 100)}` : "";
      const memory = db
        ?.recallNotes(entity.name, item.title)
        .find((note) => note.verification_status === "verified" || (note.confidence ?? 0.5) >= 0.7);
      const context = memory
        ? `\n${dim(`Context #${memory.id} · c${(memory.confidence ?? 0.5).toFixed(2)}:`)} ${truncate(memory.content, 120)}`
        : "";
      ctx.send(
        input.entity,
        `${bold(item.title)}${detail}${context}\n${arrow} ${bold(item.action)}`,
      );
    },
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
