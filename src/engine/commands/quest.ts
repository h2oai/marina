import {
  bold,
  category,
  dim,
  error as fmtError,
  header,
  separator,
  status,
  success,
} from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import type { QuestDef, QuestStep } from "../../world/world-definition";

export type { QuestDef, QuestStep };

// ─── Sector Tracking ────────────────────────────────────────────────────────

export function trackQuestProgress(
  entity: Entity,
  event:
    | "look"
    | "move"
    | "say"
    | "examine"
    | "memory_set"
    | "note_create"
    | "recall"
    | "reflect"
    | "project_join"
    | "task_claim"
    | "task_submit"
    | "pool_add"
    | "channel_send",
  roomId?: string,
): void {
  const questId = entity.properties.active_quest as string | undefined;
  if (!questId) return;

  // Sector tracking (shared between all movement-based quests)
  if (event === "move" && roomId) {
    const visited = (entity.properties.quest_sectors as string[]) ?? [];
    if (!visited.includes(roomId)) {
      visited.push(roomId);
      entity.properties.quest_sectors = visited;
    }
  }

  // Set generic progress flags for any quest (not just tutorial)
  switch (event) {
    case "look":
      entity.properties.quest_look = true;
      break;
    case "move":
      entity.properties.quest_move = true;
      break;
    case "say":
      entity.properties.quest_say = true;
      break;
    case "examine":
      entity.properties.quest_examine = true;
      break;
    case "memory_set":
      entity.properties.quest_memory_set = true;
      break;
    case "note_create":
      entity.properties.quest_note = true;
      break;
    case "recall":
      entity.properties.quest_recall = true;
      break;
    case "reflect":
      entity.properties.quest_reflect = true;
      break;
    case "project_join":
      entity.properties.quest_project_join = true;
      break;
    case "task_claim":
      entity.properties.quest_task_claim = true;
      break;
    case "task_submit":
      entity.properties.quest_task_submit = true;
      break;
    case "pool_add":
      entity.properties.quest_pool_add = true;
      break;
    case "channel_send":
      entity.properties.quest_channel_send = true;
      break;
  }
}

// ─── Quest Command ──────────────────────────────────────────────────────────

export function questCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  db?: MarinaDB;
  quests?: QuestDef[];
}): CommandDef {
  const ALL_QUESTS = deps.quests ?? [];

  return {
    name: "quest",
    aliases: ["checklist", "onboarding"],
    help: "Guided objectives and onboarding checklists. Structured step-by-step workflows that track your progress. Usage: quest [start|status|list|complete|abandon]",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const sub = input.tokens[0]?.toLowerCase() ?? "status";

      switch (sub) {
        case "list": {
          const lines = [
            header("Available Objectives"),
            separator(),
            ...ALL_QUESTS.map((q) => {
              const active = entity.properties.active_quest === q.id;
              const completed = (
                (entity.properties.completed_quests as string[] | undefined) ?? []
              ).includes(q.id);
              const badge = completed
                ? ` ${status("COMPLETED", "done")}`
                : active
                  ? ` ${status("ACTIVE", "warn")}`
                  : "";
              return `  ${bold(q.name)}${badge}\n    ${q.description}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          break;
        }

        case "start": {
          const questName = input.tokens.slice(1).join(" ").toLowerCase() || "first steps";
          const quest = ALL_QUESTS.find((q) => q.name.toLowerCase() === questName);
          if (!quest) {
            ctx.send(
              input.entity,
              'Objective not found. Type "quest list" to see available objectives.',
            );
            return;
          }

          const completed = (entity.properties.completed_quests as string[] | undefined) ?? [];
          if (completed.includes(quest.id)) {
            ctx.send(input.entity, "You have already completed this objective.");
            return;
          }

          if (entity.properties.active_quest) {
            ctx.send(
              input.entity,
              'You already have an active objective. Use "quest abandon" first.',
            );
            return;
          }

          entity.properties.active_quest = quest.id;
          ctx.send(
            input.entity,
            `${success(`Started: ${quest.name}`)}\n${quest.description}\n\nType "quest status" to check your progress.`,
          );
          break;
        }

        case "status": {
          const questId = entity.properties.active_quest as string | undefined;
          if (!questId) {
            ctx.send(
              input.entity,
              'No active objective. Type "quest list" to see available objectives, or "quest start First Steps" to begin.',
            );
            return;
          }

          const quest = ALL_QUESTS.find((q) => q.id === questId);
          if (!quest) {
            ctx.send(input.entity, "Unknown objective. Something went wrong.");
            return;
          }

          const lines = [header(quest.name), quest.description, "", bold("Progress:")];

          let allDone = true;
          for (const step of quest.steps) {
            const done = step.check(entity);
            if (!done) allDone = false;
            const marker = done ? success("\u2713") : fmtError("\u2717");
            lines.push(`  ${marker} ${step.description}`);
            if (!done) {
              lines.push(`    ${dim(`Hint: ${step.hint}`)}`);
            }
          }

          if (allDone) {
            lines.push("");
            lines.push(category('All steps complete! Type "quest complete" to finish.'));
          }

          ctx.send(input.entity, lines.join("\n"));
          break;
        }

        case "complete": {
          const questId = entity.properties.active_quest as string | undefined;
          if (!questId) {
            ctx.send(input.entity, "No active objective to complete.");
            return;
          }

          const quest = ALL_QUESTS.find((q) => q.id === questId);
          if (!quest) return;

          const allDone = quest.steps.every((s) => s.check(entity));
          if (!allDone) {
            ctx.send(
              input.entity,
              'Not all steps are complete yet. Type "quest status" to check your progress.',
            );
            return;
          }

          // Grant reward
          const completed = (entity.properties.completed_quests as string[] | undefined) ?? [];
          completed.push(quest.id);
          entity.properties.completed_quests = completed;
          entity.properties.active_quest = undefined;

          // Run quest-specific completion callback
          quest.onComplete?.(entity, deps.db);

          ctx.send(
            input.entity,
            `${success(`Completed: ${quest.name}!`)}\n${quest.reward}\n\nCongratulations! You have earned your place here.`,
          );
          ctx.broadcastExcept(
            input.entity,
            `${entity.name} has completed "${quest.name}"!`,
            "action",
          );
          break;
        }

        case "abandon": {
          if (!entity.properties.active_quest) {
            ctx.send(input.entity, "No active objective to abandon.");
            return;
          }

          const quest = ALL_QUESTS.find((q) => q.id === (entity.properties.active_quest as string));
          entity.properties.active_quest = undefined;
          // Clear progress
          entity.properties.quest_look = undefined;
          entity.properties.quest_move = undefined;
          entity.properties.quest_sectors = undefined;
          entity.properties.quest_say = undefined;
          entity.properties.quest_examine = undefined;
          entity.properties.quest_memory_set = undefined;
          entity.properties.quest_note = undefined;
          entity.properties.quest_recall = undefined;

          ctx.send(
            input.entity,
            `Quest abandoned: ${quest?.name ?? "Unknown"}. You can start it again anytime.`,
          );
          break;
        }

        default:
          ctx.send(input.entity, "Usage: quest [list|start <name>|status|complete|abandon]");
      }
    },
  };
}
