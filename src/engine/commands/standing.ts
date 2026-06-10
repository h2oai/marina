import { deriveRankFromStanding, RANK_THRESHOLDS } from "../../agent/rank-progression";
import { getStanding, leaderboard, ledgerFor, STANDING_HALF_LIFE_DAYS } from "../../agent/standing";
import { bold, dim, header, separator } from "../../net/ansi";
import { getGateProgress } from "../safety-gates";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";

interface StandingDeps {
  db?: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
  findAgentByName: (name: string) => Entity | undefined;
}

function fmtAge(ms: number): string {
  const d = ms / 86_400_000;
  if (d < 1) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (d < 30) return `${d.toFixed(1)}d`;
  return `${(d / 30).toFixed(1)}mo`;
}

export function standingCommand(deps: StandingDeps): CommandDef {
  return {
    name: "standing",
    aliases: [],
    minRank: 0,
    help:
      "Civic standing — your blended contribution metric (60-day half-life).\n" +
      "Usage:\n" +
      "  standing                — your current standing + ledger\n" +
      "  standing show <name>    — another entity's standing\n" +
      "  standing top [N]        — leaderboard\n" +
      "Standing accrues from task completion, pool notes, crew leadership, and helping acts. " +
      "Decay floors at 0; rank 0–4 is derived from thresholds (5/15/40/100). " +
      "Above rank 4, capability is earned per-operation via the Capability gates shown in " +
      "your standing view — keep building standing, then perform each gated action under " +
      "supervision until it unlocks.",
    handler: (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, "Standing requires database support.");
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (sub === "top") {
        const limit = Math.max(1, Math.min(50, Number.parseInt(tokens[1] ?? "10", 10) || 10));
        const board = leaderboard(db, limit);
        if (board.length === 0) {
          ctx.send(input.entity, "No standing earned yet.");
          return;
        }
        const lines = [header(`Standing leaderboard (top ${board.length})`), separator()];
        for (let i = 0; i < board.length; i++) {
          const row = board[i]!;
          const entity = deps.getEntity(row.entityId);
          const name = entity?.name ?? row.entityId;
          lines.push(
            `  ${dim(String(i + 1).padStart(2))}. ${bold(name)} ${dim(`— ${row.standing.toFixed(1)}`)}`,
          );
        }
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // standing | standing show <name>
      const targetName = sub === "show" ? tokens[1] : undefined;
      const target = targetName ? deps.findAgentByName(targetName) : deps.getEntity(input.entity);
      if (!target) {
        ctx.send(input.entity, `Unknown entity: ${targetName ?? input.entity}`);
        return;
      }

      const standing = getStanding(db, target.id);
      const derived = deriveRankFromStanding(standing);
      const currentRank = (target.properties.rank as number | undefined) ?? 0;
      const ledger = ledgerFor(db, target.id, 12);

      const lines: string[] = [
        header(`Standing: ${target.name}`),
        separator(),
        `  ${bold(standing.toFixed(1))} ${dim(`(half-life ${STANDING_HALF_LIFE_DAYS}d)`)}`,
        `  ${dim("derived rank:")} ${derived}  ${dim("stored:")} ${currentRank}`,
      ];
      // ── Path forward ──────────────────────────────────────────────
      // The rank ladder tops out at 4 (Builder). Below that, show the gap to
      // the next tier; at/above it, explain that further capability is earned
      // per-operation (safety gates) — not by more rank — and show that ladder.
      // This is the fix for "no way to advance past a certain point": the path
      // past rank 4 was real but invisible.
      lines.push("", dim("Path forward:"));
      if (derived < 4) {
        const next = RANK_THRESHOLDS.find((t) => t.rank === ((derived + 1) as typeof derived));
        if (next) {
          const remaining = Math.max(0, next.min - standing);
          lines.push(
            `  ${standing.toFixed(1)}/${next.min} standing — ${remaining.toFixed(1)} more to reach rank ${next.rank}.`,
          );
        }
      } else {
        lines.push(
          `  ${bold("Rank 4 (Builder)")} is the top auto-rank. Beyond it, capability is earned`,
          "  per-operation: keep building standing, then perform each gated action under",
          "  supervision until it unlocks. Ranks 5+ are operator-conferred honorifics.",
        );
      }

      // ── Capability gates ──────────────────────────────────────────
      const gates = getGateProgress(db, target.id);
      lines.push("", dim("Capability gates:"));
      for (const g of gates) {
        if (g.status === "unlocked") {
          lines.push(`  ✓ ${g.id.padEnd(18)} unlocked — ${dim(g.description)}`);
        } else if (g.status === "supervised") {
          lines.push(
            `  ◐ ${g.id.padEnd(18)} ${g.demonstrations}/${g.demoThreshold} demos — attempt under supervision to unlock ${dim(`(${g.description})`)}`,
          );
        } else {
          const remaining = (g.minStanding - g.standing).toFixed(1);
          lines.push(
            `  🔒 ${g.id.padEnd(18)} standing ${g.standing.toFixed(1)}/${g.minStanding} (${remaining} more) ${dim(`— ${g.description}`)}`,
          );
        }
      }

      if (ledger.length > 0) {
        lines.push("", dim("Recent ledger entries:"));
        const now = Date.now();
        for (const entry of ledger) {
          const sign = entry.amount >= 0 ? "+" : "";
          lines.push(
            `  ${sign}${entry.amount.toFixed(1).padStart(6)}  ${entry.kind.padEnd(28)}  ${dim(fmtAge(now - entry.earnedAt))}`,
          );
        }
      } else {
        lines.push("", dim("No ledger entries yet."));
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
