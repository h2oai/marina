import type { TaskManager } from "../../coordination/task-manager";
import { bold, dim, id, status } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import type { QuestDef } from "../../world/world-definition";

interface NextDeps {
  getEntity: (id: EntityId) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  quests?: QuestDef[];
  startRoom?: string;
}

export function nextCommand(deps: NextDeps): CommandDef {
  return {
    name: "next",
    aliases: ["suggest"],
    help: "Context-aware suggestion — tells you the single best thing to do right now.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const db = deps.db;

      const arrow = dim("\u2192");

      // 1. No goal in core memory
      if (db) {
        const goal = db.getCoreMemory(entity.name, "goal");
        if (!goal) {
          ctx.send(
            input.entity,
            `${status("no goal", "warn")}\n${arrow} ${bold("memory set goal <what you want to accomplish>")}`,
          );
          return;
        }
      }

      // 2. Active quest with incomplete steps
      const activeQuestId = entity.properties.active_quest as string | undefined;
      if (activeQuestId && deps.quests) {
        const quest = deps.quests.find((q) => q.id === activeQuestId);
        if (quest) {
          const incomplete = quest.steps.find((step) => !step.check(entity));
          if (incomplete) {
            ctx.send(
              input.entity,
              `Quest ${bold(`"${quest.name}"`)} \u2014 next step: ${incomplete.description}\n${arrow} ${bold(incomplete.hint)}`,
            );
            return;
          }
        }
      }

      // 3. Has claimed tasks
      if (db) {
        const claims = db.getActiveClaimsByName(entity.name);
        if (claims.length > 0) {
          const first = claims[0]!;
          ctx.send(
            input.entity,
            `Active task ${id(first.task_id)}: ${first.title}\n${arrow} ${bold(`task info ${first.task_id}`)}`,
          );
          return;
        }
      }

      // 4. Open bounties exist and none claimed
      if (deps.taskManager) {
        const open = deps.taskManager.list({ status: "open" });
        const bounties = open.filter((t) => t.validationMode === "bounty");
        if (bounties.length > 0) {
          ctx.send(
            input.entity,
            `${bold(String(bounties.length))} bounties available.\n${arrow} ${bold("task list")} to see them, ${bold("task claim <id>")} to take one`,
          );
          return;
        }
      }

      // 5. No notes yet
      if (db) {
        const notes = db.getNotesByEntity(entity.name, 1);
        if (notes.length === 0) {
          ctx.send(
            input.entity,
            `No observations yet.\n${arrow} ${bold("note <what you see> importance 5 type observation")}`,
          );
          return;
        }
      }

      // 6. Has notes but hasn't used recall
      if (db) {
        const commands = db.getActivityByType(entity.name, "command", 50);
        const usedRecall = commands.some((c) => c.key === "recall");
        if (!usedRecall) {
          ctx.send(
            input.entity,
            `You have notes but haven't searched them.\n${arrow} ${bold("recall <topic>")}`,
          );
          return;
        }
      }

      // 7. Still in start room and hasn't moved
      if (deps.startRoom && entity.room === deps.startRoom && !entity.properties.quest_move) {
        ctx.send(
          input.entity,
          `You haven't explored yet.\n${arrow} ${bold("north")}, ${bold("south")}, ${bold("east")}, or ${bold("west")}`,
        );
        return;
      }

      // 8. Not in any channels
      if (db) {
        const channels = db.getEntityChannels(input.entity);
        if (channels.length === 0) {
          ctx.send(input.entity, `Not in any channels.\n${arrow} ${bold("channel join general")}`);
          return;
        }
      }

      // 9. Hasn't published to canvas yet
      if (db) {
        const canvases = db.listCanvases({ limit: 1 });
        if (canvases.length > 0) {
          const feedCanvas = db.getCanvasByName("feed");
          if (feedCanvas) {
            const nodes = db.getNodesByCanvas(feedCanvas.id);
            const hasPublished = nodes.some((n) => n.creator_name === entity.name);
            if (!hasPublished) {
              ctx.send(
                input.entity,
                `The canvas has activity but you haven't contributed yet.\n${arrow} ${bold("canvas list")} to explore, or post on a board — it auto-appears on the feed canvas`,
              );
              return;
            }
          }
        }
      }

      // 10. Default
      ctx.send(input.entity, dim("Explore, observe, remember. The world responds to curiosity."));
    },
  };
}
