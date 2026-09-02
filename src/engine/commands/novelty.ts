// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, progressBar, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { getRank } from "../permissions";

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
  getAllCommands?: () => Array<{ name: string; minRank?: number }>;
}): CommandDef {
  return {
    name: "novelty",
    aliases: ["proficiency"],
    help: "Activity proficiency and exploration coverage. Shows command success rates, coverage gaps, and suggestions for underused capabilities. Usage: novelty | novelty suggest | novelty stats",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Novelty requires database support.");
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

      if (sub === "suggest") {
        const suggestions: string[] = [];

        // Check for repetitive behavior (boredom detection)
        const topCommands = db.getActivityByType(entity.name, "command", 20);
        if (topCommands.length > 0) {
          const commandCounts = topCommands.map((c) => c.count);
          const actionEntropy = commandCounts.length > 0 ? entropy(commandCounts) : 0;

          if (actionEntropy < 0.3) {
            const topCmd = topCommands[0];
            if (topCmd) {
              const total = topCommands.reduce((s, c) => s + c.count, 0);
              const topPct = Math.round((topCmd.count / total) * 100);
              suggestions.push(
                `Action entropy is low (${Math.round(actionEntropy * 100)}%) — '${topCmd.key}' is ${topPct}% of activity`,
              );
            }
          }

          // Find commands with low success rates
          const struggling = topCommands.filter((c) => {
            const total = c.successCount + c.failCount;
            return total >= 3 && c.failCount / total > 0.4;
          });
          if (struggling.length > 0) {
            const cmd = struggling[0]!;
            const total = cmd.successCount + cmd.failCount;
            const failPct = Math.round((cmd.failCount / total) * 100);
            suggestions.push(`'${cmd.key}' has a ${failPct}% failure rate (${total} attempts)`);
          }
        }

        // Find unexplored territory — OUTSIDE the has-activity branch, because
        // a brand-new entity is exactly who needs the map most. Drawn from the
        // FULL registry (filtered to what this entity's rank can run) — a
        // hardcoded subset here once made "exploration" structurally unable to
        // suggest anything the agent hadn't already been told about. Rotates
        // daily per entity so repeated asks reveal different corners.
        {
          const usedCommands = new Set(topCommands.map((c) => c.key));
          const rank = getRank(entity);
          const registry = deps.getAllCommands?.() ?? [];
          const unexplored = registry
            .filter((c) => (c.minRank ?? 0) <= rank && !usedCommands.has(c.name))
            .map((c) => c.name)
            .sort();
          if (unexplored.length > 0) {
            const daySeed = Math.floor(Date.now() / 86_400_000) + entity.name.length;
            const start = daySeed % unexplored.length;
            const rotated = [...unexplored.slice(start), ...unexplored.slice(0, start)];
            suggestions.push(
              `Unexplored commands (${unexplored.length} you've never used): ${rotated.slice(0, 5).join(", ")} — \`help <command>\` explains any of them, \`help all\` is the full map.`,
            );
          }
        }

        // Knowledge gaps
        if (stats.roomsVisited > 0) {
          const totalRooms = deps.getTotalRoomCount?.() ?? 0;
          if (totalRooms > 0) {
            const unexplored = totalRooms - stats.roomsVisited;
            if (unexplored > 0) {
              suggestions.push(`${unexplored} rooms unexplored out of ${totalRooms}`);
            }
          }
        }

        if (suggestions.length === 0) {
          suggestions.push("Activity is diverse and well-distributed.");
        }

        const lines = [
          header("Novelty Analysis"),
          separator(),
          ...suggestions.slice(0, 4).map((s, i) => `  ${i + 1}. ${s}`),
        ];
        ctx.send(input.entity, lines.join("\n"));
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
        `Composite: ${bold(`${composite}/100`)}`,
        "",
        ...scores.map((s) => `  ${s.label}: ${progressBar(s.score, 100, 12)}`),
      ];
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
