// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TaskManager } from "../../coordination/task-manager";
import {
  bold,
  dim,
  id as fmtId,
  header,
  importance,
  label,
  progressBar,
  sectionHead,
  separator,
  status,
} from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { DAY_MS, HOUR_MS } from "../constants";
import { requiresPersistence } from "./command-messages";

function relativeTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < HOUR_MS) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  const days = Math.floor(diff / DAY_MS);
  return days === 1 ? "1d ago" : `${days}d ago`;
}

export function orientCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  getTotalRoomCount?: () => number;
}): CommandDef {
  return {
    name: "orient",
    aliases: ["status", "briefing"],
    help: "Memory health dashboard — core memory, notes, activity coverage, and knowledge gaps.\nUsage: orient",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("orient"));
        return;
      }
      const db = deps.db;
      const now = Date.now();
      const lines: string[] = [header("Orientation Briefing"), separator()];

      // Core memory (active beliefs & goals)
      const coreMemory = db.listCoreMemory(entity.name);
      if (coreMemory.length > 0) {
        lines.push(sectionHead("Core Memory"));
        for (const m of coreMemory) {
          const val = m.value.length > 60 ? `${m.value.slice(0, 60)}...` : m.value;
          lines.push(label(`${bold(m.key)} ${dim(`v${m.version}`)}`, val));
        }
        lines.push("");
      }

      // Recent notes (last 24h)
      const recentNotes = db.getNotesByEntity(entity.name, 100);
      const last24h = recentNotes.filter((n) => now - n.created_at < DAY_MS);
      const last7d = recentNotes.filter((n) => now - n.created_at < 7 * DAY_MS);
      if (last24h.length > 0) {
        lines.push(sectionHead(`Recent Notes (${last24h.length})`));
        for (const n of last24h.slice(0, 5)) {
          const age = dim(relativeTime(n.created_at, now));
          lines.push(
            `    ${fmtId(n.id)} ${importance(n.importance)} ${age} ${n.content.slice(0, 55)}`,
          );
        }
        if (last24h.length > 5) {
          lines.push(dim(`    ... and ${last24h.length - 5} more`));
        }
        lines.push("");
      }

      // High-importance notes (imp >= 8)
      const highImp = recentNotes.filter((n) => n.importance >= 8);
      if (highImp.length > 0) {
        lines.push(sectionHead(`High-Priority (${highImp.length})`));
        for (const n of highImp.slice(0, 5)) {
          lines.push(`    ${fmtId(n.id)} ${importance(n.importance)} ${n.content.slice(0, 55)}`);
        }
        if (highImp.length > 5) {
          lines.push(dim(`    ... and ${highImp.length - 5} more`));
        }
        lines.push("");
      }

      // Memory health: vitality zones
      const allNotes = recentNotes;
      const totalNotes = allNotes.length;
      let active = 0;
      let stale = 0;
      let fading = 0;
      for (const n of allNotes) {
        const lastTouch = n.last_accessed ?? n.created_at;
        const daysSince = (now - lastTouch) / DAY_MS;
        if (daysSince < 3 || n.importance >= 7) active++;
        else if (daysSince < 14 || n.importance >= 4) stale++;
        else fading++;
      }
      lines.push(sectionHead("Memory Health"));
      lines.push(`    Total notes: ${bold(String(totalNotes))}`);
      if (totalNotes > 0) {
        lines.push(
          `    ${status("Active", "active")} ${active}  ${status("Stale", "warn")} ${stale}  ${status("Fading", "fail")} ${fading}`,
        );
        lines.push(`    ${progressBar(active, totalNotes)} active`);
      }

      // Note types distribution
      const typeCounts = new Map<string, number>();
      for (const n of allNotes) {
        const t = n.note_type || "general";
        typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
      }
      if (typeCounts.size > 1) {
        const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
        lines.push(`    Types: ${sorted.map(([t, c]) => `${t}(${c})`).join(" ")}`);
      }

      // Knowledge graph stats
      const linkCount = db.countNoteLinks(entity.name);
      if (linkCount > 0) {
        lines.push(`    Graph links: ${linkCount}`);
      }
      lines.push("");

      // Activity stats
      const stats = db.getActivityStats(entity.name);
      if (stats.totalActions > 0) {
        lines.push("  Activity:");
        lines.push(
          `    ${stats.roomsVisited} rooms visited, ${stats.uniqueCommands} commands used, ${stats.entitiesInteracted} interactions`,
        );
        lines.push("");
      }

      // Week-over-week trend
      if (last7d.length > 0) {
        const avgImp = last7d.reduce((s, n) => s + n.importance, 0) / last7d.length;
        lines.push(`  7-Day Summary: ${last7d.length} notes, avg importance ${avgImp.toFixed(1)}`);
      }

      // Open bounties / tasks
      if (deps.taskManager) {
        const openTasks = deps.taskManager.list({
          status: "open",
          orderByStanding: true,
          limit: 5,
        });
        if (openTasks.length > 0) {
          lines.push("", sectionHead("Open Tasks"));
          for (const t of openTasks) {
            const bounty =
              t.validationMode === "bounty"
                ? ` ${status(`bounty${t.standing > 0 ? ` !${t.standing}` : ""}`, "warn")}`
                : "";
            const claims = deps.taskManager.getClaims(t.id);
            const submissions = claims.filter((c) => c.status === "submitted").length;
            const subLabel = submissions > 0 ? dim(` (${submissions} submissions)`) : "";
            lines.push(`    ${fmtId(t.id)} ${t.title}${bounty}${subLabel}`);
          }
        }

        // Show entity's own claimed tasks
        const allOpen = deps.taskManager.list({ status: "open", limit: 50 });
        const myClaims: string[] = [];
        for (const t of allOpen) {
          const claim = deps.taskManager.getClaim(t.id, input.entity);
          if (claim) {
            myClaims.push(`    #${t.id}: ${t.title} (${claim.status})`);
          }
        }
        if (myClaims.length > 0) {
          lines.push("", "  Your Claims:");
          lines.push(...myClaims);
        }

        // Entity's earned standing
        const standing = deps.taskManager.getEntityStanding(input.entity);
        if (standing > 0) {
          lines.push("", `  Your Standing: ${standing}`);
        }
      }

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
