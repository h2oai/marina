import {
  dim,
  entity as fmtEntity,
  header,
  label,
  progressBar,
  rank,
  sectionHead,
  separator,
} from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { formatDuration } from "./format-duration";

export function scoreCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  getRoomShort: (roomId: string) => string | undefined;
}): CommandDef {
  return {
    name: "score",
    // `status` intentionally omitted: it collides with orient's alias, which
    // registers later and wins, so `status` here was dead. orient owns it.
    aliases: ["stats"],
    help: "Show your profile — rank, location, session time, and benchmarks.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const rankVal = (entity.properties.rank as number) ?? 0;

      const roomShort = deps.getRoomShort(entity.room) ?? entity.room;
      const sessionTime = formatDuration(Date.now() - entity.createdAt);

      const activeQuest = entity.properties.active_quest as string | undefined;
      const completedQuests = (entity.properties.completed_quests as string[]) ?? [];
      const districts = (entity.properties.quest_districts as string[]) ?? [];

      const lines = [
        header(fmtEntity(entity.name)),
        separator(30),
        label("Rank", `${rank(rankVal)} ${dim(`(${rankVal})`)}`),
        label("Location", roomShort),
        label("Session", dim(sessionTime)),
        label("Objects", String(entity.inventory.length)),
      ];

      if (districts.length > 0) {
        lines.push(label("Districts", districts.join(", ")));
      }

      if (activeQuest) {
        lines.push(label("Active", activeQuest));
      }

      if (completedQuests.length > 0) {
        lines.push(label("Completed", `${completedQuests.length} objectives`));
      }

      const BENCH_LABELS: [string, string][] = [
        ["bench_navigation_best", "Navigation"],
        ["bench_retrieval_best", "Retrieval"],
        ["bench_codegen_best", "Code-Gen"],
        ["bench_coordination_best", "Coordination"],
        ["bench_adaptation_best", "Adaptation"],
        ["bench_memory_best", "Memory"],
        ["bench_selfmod_best", "Self-Modification"],
        ["bench_collaboration_best", "Collaboration"],
      ];
      const benchScores = BENCH_LABELS.map(
        ([key, lbl]) => [lbl, (entity.properties[key] as number) ?? 0] as const,
      ).filter(([, val]) => val > 0);
      if (benchScores.length > 0) {
        lines.push("", sectionHead("Benchmarks"));
        for (const [lbl, val] of benchScores) {
          lines.push(`  ${lbl}: ${progressBar(val, 100, 10)}`);
        }
      }

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
