// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getStanding, ledgerFor } from "../../agent/standing";
import type { TaskManager } from "../../coordination/task-manager";
import { bold, category, dim, header, id, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";

/**
 * Debrief — end-of-session synthesis view. Shows what the entity recently
 * captured (notes), what they owe (claimed-but-unsubmitted tasks), and
 * where they stand civically. Nudges toward `reflect` when enough new
 * notes have accumulated to justify the cost.
 *
 * Read-only. No agent spawning, no reflection-on-behalf, no LLM. The
 * suggestion to reflect is the only prescription.
 */
export function debriefCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
}): CommandDef {
  return {
    name: "debrief",
    aliases: [],
    help: "Close-out view: recent notes, claimed tasks, current standing. Usage: debrief",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      if (!deps.db) {
        ctx.send(input.entity, "Debrief requires database support.");
        return;
      }

      const db = deps.db;
      const lines: string[] = [header(`Debrief: ${entity.name}`), separator()];

      const recentNotes = db.getNotesByEntity(entity.name, 10);
      if (recentNotes.length > 0) {
        lines.push(category(`Recent Notes (${recentNotes.length})`));
        for (const note of recentNotes.slice(0, 5)) {
          lines.push(`  ${id(note.id)} ${note.content}`);
        }
        if (recentNotes.length > 5) {
          lines.push(dim(`  …and ${recentNotes.length - 5} more — \`note list\` for all.`));
        }
      } else {
        lines.push(category("Recent Notes"));
        lines.push(dim("  None yet. Write what you learn with `note <observation>`."));
      }

      if (deps.taskManager) {
        const claimed = deps.taskManager
          .listClaimedBy(input.entity)
          .filter((t) => t.status === "claimed");
        if (claimed.length > 0) {
          lines.push(category(`Open Claims (${claimed.length})`));
          for (const task of claimed.slice(0, 5)) {
            lines.push(`  ${id(task.id)} ${task.title}`);
          }
          if (claimed.length > 5) {
            lines.push(dim(`  …and ${claimed.length - 5} more — \`task list mine\` for all.`));
          }
        }
      }

      const standing = getStanding(db, input.entity);
      const ledger = ledgerFor(db, input.entity, 5);
      lines.push(category("Standing"));
      lines.push(`  ${bold(standing.toFixed(1))} blended (decayed, half-life 60d)`);
      if (ledger.length > 0) {
        lines.push(dim("  Recent ledger:"));
        for (const row of ledger) {
          const sign = row.amount >= 0 ? "+" : "";
          lines.push(`    ${sign}${row.amount.toFixed(1)} ${row.kind} ${dim(row.ref)}`);
        }
      }

      // Reflect-on-N-new-notes nudge. Cheap heuristic: enough recent material
      // to make a reflection worth the model call. Doesn't auto-fire — the
      // agent decides.
      if (recentNotes.length >= 3) {
        lines.push("");
        lines.push(dim(`Suggestion: \`reflect\` — you have ${recentNotes.length} recent notes.`));
      }

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
