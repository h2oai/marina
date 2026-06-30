import type { CrewManager } from "../../coordination/crew-manager";
import type { TaskManager } from "../../coordination/task-manager";
import { listWorkItems } from "../../coordination/work-loop";
import { bold, dim, header, separator, status } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId } from "../../types";
import type { QuestDef } from "../../world/world-definition";

interface WorkDeps {
  getEntity: (id: EntityId) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  crewManager?: CrewManager;
  quests?: QuestDef[];
  startRoom?: string;
}

export function workCommand(deps: WorkDeps): CommandDef {
  return {
    name: "work",
    aliases: ["inbox"],
    category: "Coordination",
    help: "Show the prioritized work inbox: active commitments, reviews, canvas intents, crews, tasks, and social blockers.",
    handler: (ctx, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const items = listWorkItems(
        entity,
        {
          db: deps.db,
          taskManager: deps.taskManager,
          crewManager: deps.crewManager,
          quests: deps.quests,
          startRoom: deps.startRoom,
          peers: ctx.entities,
        },
        12,
      ).filter((item) => item.kind !== "default" || item.priority > 0);

      if (items.length === 0) {
        ctx.send(input.entity, `${dim("No active work surfaced.")}\n${bold("look")}`);
        return;
      }

      const lines = [header("Work Inbox"), separator()];
      for (const item of items) {
        const detail = item.detail ? ` — ${truncate(item.detail, 90)}` : "";
        lines.push(
          `  ${status(item.kind.replaceAll("_", " "), "info")} ${bold(item.title)}${detail}`,
          `    ${dim("->")} ${item.action}`,
        );
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
