// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, progressBar, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { benchmarkExecution } from "../benchmark-execution";
import {
  benchmarkNoveltyOpportunities,
  type NoveltyCapability,
  type NoveltyOpportunity,
  noveltyOpportunities,
} from "../novelty";
import { getRank } from "../permissions";
import { requiresPersistence } from "./command-messages";

/**
 * Calculate entropy of a distribution (higher = more diverse).
 * Returns value 0-1 (normalized by log(n)).
 */
function entropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const n = counts.length;
  if (n <= 1) return 0;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(n); // Normalize to 0-1
}

export function noveltyCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  getTotalRoomCount?: () => number;
  /** The FULL command registry — the exploration surface must be able to name
   *  a command the agent has never been told about, or it isn't exploration. */
  getAllCommands?: () => NoveltyCapability[];
  getFocus?: (name: string) => string | undefined;
}): CommandDef {
  return {
    category: "Cognition",
    usage: [
      "novelty",
      "novelty stats",
      "novelty suggest [goal]",
      "novelty experiments [benchmark]",
    ],
    name: "novelty",
    aliases: [],
    help: "Ranked opportunities from activity, task outcomes and execution evidence. Advisory, bounded exploration; no activity rewards or automatic spawning. Usage: novelty | novelty stats | novelty suggest [goal] | novelty experiments [benchmark]",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("novelty tracking"));
        return;
      }
      const db = deps.db;
      const sub = input.tokens[0]?.toLowerCase();

      const stats = db.getActivityStats(entity.name);

      if (sub === "stats") {
        const totalRooms = deps.getTotalRoomCount?.() ?? 0;
        const worldPct = totalRooms > 0 ? Math.round((stats.roomsVisited / totalRooms) * 100) : 0;
        const lines = [
          header("Exploration Statistics"),
          separator(),
          `Rooms visited: ${bold(String(stats.roomsVisited))}${totalRooms > 0 ? ` / ${totalRooms} ${dim(`(${worldPct}%)`)}` : ""}`,
          `Unique commands used: ${bold(String(stats.uniqueCommands))}`,
          `Entities interacted with: ${bold(String(stats.entitiesInteracted))}`,
          `Total actions: ${dim(String(stats.totalActions))}`,
        ];

        // Show command diversity with proficiency
        const topCommands = db.getActivityByType(entity.name, "command", 10);
        if (topCommands.length > 0) {
          lines.push("", bold("Command proficiency:"));
          for (const cmd of topCommands.slice(0, 8)) {
            const total = cmd.successCount + cmd.failCount;
            const rate = total > 0 ? Math.round((cmd.successCount / total) * 100) : 0;
            const rateStr = total > 0 ? ` ${dim(`(${rate}% success)`)}` : "";
            lines.push(`  ${cmd.key}: ${dim(`${cmd.count}x`)}${rateStr}`);
          }
        }

        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "suggest" || sub === "experiments") {
        let opportunities: NoveltyOpportunity[];
        if (sub === "experiments") {
          const benchmark = input.tokens.slice(1).join(" ").trim() || undefined;
          // Explicit opt-in scan, capped to 20 latest completed runs. No model
          // calls or per-turn global benchmark scans.
          const runs = db.queryBenchmarkRuns({ benchmark, status: "completed", limit: 20 });
          opportunities = benchmarkNoveltyOpportunities(
            runs.map((r) => ({
              id: r.id,
              benchmark: r.benchmark,
              score: r.score,
              slice: r.slice_hash ?? null,
              judge: r.judge ?? null,
              execution: benchmarkExecution(db.getBenchmarkItems(r.id)),
            })),
          );
        } else {
          const goal =
            input.tokens.slice(1).join(" ").trim() ||
            deps.getFocus?.(entity.name) ||
            db
              .getActiveClaimsByName(entity.name)
              .map((c) => c.title)
              .join(" ");
          opportunities = noveltyOpportunities({
            now: Date.now(),
            participant: entity.name,
            rank: getRank(entity),
            goal,
            capabilities: deps.getAllCommands?.() ?? [],
            activity: db.getActivityByType(entity.name, "command", -1),
            outcomes: db.getProductivitySummary(entity.name),
            unexploredRooms: Math.max(0, (deps.getTotalRoomCount?.() ?? 0) - stats.roomsVisited),
          });
        }
        const lines = [
          header("Novelty Opportunities"),
          separator(),
          ...opportunities.map(
            (o, i) =>
              `  ${i + 1}. [${o.kind}] ${o.suggestion} Evidence: ${o.evidence} Inspect: ${o.next}`,
          ),
          ...(opportunities.length
            ? []
            : [
                "No evidence-backed opportunity identified. Continue useful work or choose a question to investigate.",
              ]),
          dim(
            "Advisory heuristic order, not a quality score. Stay within your task and budget; more actions or peers alone do not prove value.",
          ),
        ];
        ctx.send(input.entity, lines.join("\n"), "novelty", {
          novelty: {
            schema: "marina.novelty.v1",
            mode: sub,
            opportunities,
            ranking: "heuristic",
            advisory: true,
          },
        });
        return;
      }

      // Default: composite novelty score
      const scores: { label: string; score: number }[] = [];

      // Room novelty: how new is this room to the entity?
      const roomVisits = db.getRoomVisitCount(entity.name, input.room);
      const roomNovelty = roomVisits === 0 ? 100 : Math.max(0, 100 - roomVisits * 20);
      scores.push({ label: "Room", score: roomNovelty });

      // Action diversity: entropy of command distribution
      const commandDist = db.getActivityByType(entity.name, "command", 50);
      const commandCounts = commandDist.map((c) => c.count);
      const actionEntropy = commandCounts.length > 0 ? entropy(commandCounts) : 0;
      // Low entropy = high novelty need (actions are repetitive)
      const actionNovelty = Math.round((1 - actionEntropy) * 100);
      scores.push({ label: "Action diversity need", score: actionNovelty });

      // Knowledge novelty: how many notes relate to current room?
      const roomNotes = db.getNotesByRoom(input.room, 50);
      const knowledgeNovelty =
        roomNotes.length === 0 ? 100 : Math.max(0, 100 - roomNotes.length * 15);
      scores.push({ label: "Knowledge gap", score: knowledgeNovelty });

      // Social novelty: have we interacted with entities here?
      const socialNovelty =
        stats.entitiesInteracted < 2 ? 80 : Math.max(0, 60 - stats.entitiesInteracted * 10);
      scores.push({ label: "Interaction", score: socialNovelty });

      // Composite
      const composite = Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length);

      const lines = [
        header("Novelty Score"),
        separator(),
        `Exploration need: ${bold(`${composite}/100`)}`,
        dim("A coverage heuristic, not a quality, intelligence, or useful-emergence score."),
        "",
        ...scores.map((s) => `  ${s.label}: ${progressBar(s.score, 100, 12)}`),
      ];
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
