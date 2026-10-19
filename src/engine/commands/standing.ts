// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { deriveRankFromStanding, RANK_THRESHOLDS } from "../../agent/rank-progression";
import {
  ledgerFor,
  namedLeaderboard,
  STANDING_AMOUNTS,
  STANDING_HALF_LIFE_DAYS,
  standingOf,
  TASK_STANDING_MAX,
} from "../../agent/standing";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { gateNextStep, getGateProgress } from "../safety-gates";
import { requiresPersistence } from "./command-messages";

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
    usage: [
      { syntax: "standing", effect: "read" },
      { syntax: "standing show <name>", effect: "read" },
      { syntax: "standing top [N]", effect: "read" },
    ],
    name: "standing",
    aliases: [],
    category: "Civic",
    minRank: 0,
    help:
      "Civic standing — earned by verified work (60-day half-life).\n" +
      "Usage:\n" +
      "  standing                — your current standing + ledger\n" +
      "  standing show <name>    — another entity's standing (online or not)\n" +
      "  standing top [N]        — leaderboard\n" +
      "Standing is earned only when someone independent of you (not your account, not your spawn " +
      "lineage) verifies the work: " +
      `a task they approve (up to ${TASK_STANDING_MAX}), ` +
      `an approved Code Mode attempt whose checks passed (${STANDING_AMOUNTS.code_verified}), ` +
      `a forecast resolved by an independent source (up to ${STANDING_AMOUNTS.forecast_resolved} by skill, once a day), ` +
      `an experiment an independent party replicated (${STANDING_AMOUNTS.experiment_complete}), ` +
      `a proposal its requester adopts (${STANDING_AMOUNTS.assistance_adopted}), ` +
      `and an onboarding quest (${STANDING_AMOUNTS.quest_complete}). ` +
      "Being chronicled, pool notes, recalls, crew completions and helping acts no longer earn; " +
      "past rows decay out. " +
      "Decay floors at 0; rank 0–4 is derived from thresholds (5/15/40/100). " +
      "Above rank 4, capability is earned per-operation via the Capability gates shown in " +
      "your standing view — keep building standing, then perform each gated action under " +
      "supervision until it unlocks.",
    handler: (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("standing"));
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (sub === "top") {
        const limit = Math.max(1, Math.min(50, Number.parseInt(tokens[1] ?? "10", 10) || 10));
        const board = namedLeaderboard(db, limit);
        if (board.length === 0) {
          ctx.send(input.entity, "No standing earned yet.");
          return;
        }
        const lines = [header(`Standing leaderboard (top ${board.length})`), separator()];
        for (let i = 0; i < board.length; i++) {
          const row = board[i]!;
          const name = deps.getEntity(row.entityId)?.name ?? row.name;
          lines.push(
            `  ${dim(String(i + 1).padStart(2))}. ${bold(name)} ${dim(`— ${row.standing.toFixed(1)}`)}`,
          );
        }
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // standing | standing show <name>
      // Standing belongs to the durable world account, so `show` works for
      // entities that are offline (evicted) as long as the account exists.
      const targetName = sub === "show" ? tokens[1] : undefined;
      const liveTarget = targetName
        ? deps.findAgentByName(targetName)
        : deps.getEntity(input.entity);
      const account = targetName && !liveTarget ? db.getUserByName(targetName) : undefined;
      if (!liveTarget && !account) {
        ctx.send(input.entity, `Unknown entity: ${targetName ?? input.entity}`);
        return;
      }
      const target = liveTarget
        ? {
            id: liveTarget.id as string,
            name: liveTarget.name,
            rank: (liveTarget.properties.rank as number | undefined) ?? 0,
          }
        : { id: account!.id, name: account!.name, rank: account!.rank };

      const standing = standingOf(db, target.name, target.id);
      const derived = deriveRankFromStanding(standing);
      const currentRank = target.rank;
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
          "  per-operation: a held gated action runs once a person approves it, and",
          "  approved runs unlock it. Ranks 5+ are operator-conferred honorifics.",
        );
      }

      // ── Capability gates ──────────────────────────────────────────
      const gates = getGateProgress(db, target.id);
      lines.push("", dim("Capability gates:"));
      for (const g of gates) {
        const mark = g.status === "unlocked" ? "✓" : g.status === "supervised" ? "◐" : "🔒";
        lines.push(`  ${mark} ${g.id.padEnd(22)} ${gateNextStep(g)} ${dim(`— ${g.description}`)}`);
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
