// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type {
  MarinaDB,
  PrimitiveUsageSummary,
  ProductivitySummary,
} from "../../persistence/database";
import type { CommandDef } from "../../types";

function duration(ms: number): string {
  if (!ms) return "n/a";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function render(summary: ProductivitySummary): string {
  return [
    `${bold(summary.entityName ?? "World")} · ${summary.successes}/${summary.outcomes} successful (${Math.round(summary.successRate * 100)}%)`,
    `  median ${duration(summary.medianDurationMs)} · avg ${duration(summary.averageDurationMs)} · ${summary.averageToolCalls.toFixed(1)} tool calls/outcome · ${summary.averageHandoffs.toFixed(1)} handoffs/outcome · ${summary.outcomesLast7d} outcomes/7d`,
  ].join("\n");
}

function renderParticipation(summary: PrimitiveUsageSummary): string {
  const top = summary.topPrimitives.map((row) => `${row.primitive}:${row.count}`).join(" · ");
  return [
    `${bold(summary.entityName ?? "World")} · ${summary.meaningfulActions}/${summary.commands} meaningful (${Math.round(summary.meaningfulRate * 100)}%) · ${summary.primitiveDiversity} primitive families`,
    `  ${summary.worldActions} world actions · ${summary.communications} communications · ${summary.marinaToolCalls}/${summary.toolCalls} Marina tool calls · ${summary.reasoningOnlyCalls} think-only · ${summary.consequentialToolCalls} consequential · ${summary.untrustedToolCalls} trust-attributed`,
    top ? `  ${dim(`top: ${top}`)}` : `  ${dim("No meaningful primitive use recorded yet.")}`,
    summary.promptVersions.length
      ? `  ${dim(`prompt: ${summary.promptVersions.join(", ")}`)}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function productivityCommand(db: MarinaDB): CommandDef {
  return {
    name: "productivity",
    aliases: ["impact"],
    category: "Coordination",
    help: "Outcome and primitive evidence. Usage: productivity [agent <name>|leaderboard|trend|primitives [name]|prompts]",
    handler: (ctx, input) => {
      const action = input.tokens[0]?.toLowerCase();
      const lines = [header("Productivity Outcomes"), separator()];
      if (action === "leaderboard") {
        const rows = db.getProductivityLeaderboard();
        if (!rows.length) lines.push(dim("No completed outcome sessions yet."));
        else for (const [index, row] of rows.entries()) lines.push(`${index + 1}. ${render(row)}`);
      } else if (action === "trend") {
        const points = db.getProductivityTrend(undefined, 14);
        if (!points.length) lines.push(dim("No completed outcomes in the last 14 days."));
        else
          for (const point of points)
            lines.push(
              `${point.date} · ${point.successes}/${point.outcomes} successful · avg ${duration(point.averageDurationMs)} · ${point.averageToolCalls.toFixed(1)} tools · ${point.averageHandoffs.toFixed(1)} handoffs`,
            );
      } else if (action === "prompts") {
        const rows = db.getPromptOutcomeSummaries();
        if (!rows.length) lines.push(dim("No versioned prompt outcomes yet."));
        else
          for (const row of rows)
            lines.push(
              `${row.promptVersion} · ${row.successes}/${row.outcomes} successful (${Math.round(row.successRate * 100)}%) · ${row.agents} agents · ${row.meaningfulActions} meaningful actions · ${row.averageToolCalls.toFixed(1)} tools · ${Math.round(row.averageInputTokens + row.averageOutputTokens)} tokens · $${row.averageCostUsd.toFixed(4)}/outcome`,
            );
      } else if (action === "primitives" || action === "participation") {
        const name = input.tokens.slice(1).join(" ") || undefined;
        lines.push(renderParticipation(db.getPrimitiveUsageSummary(name)));
        if (!name) {
          const leaders = db.getPrimitiveUsageLeaderboard(10);
          for (const [index, row] of leaders.entries())
            lines.push(`${index + 1}. ${renderParticipation(row)}`);
        }
      } else {
        const name = action === "agent" ? input.tokens.slice(1).join(" ") : undefined;
        lines.push(render(db.getProductivitySummary(name || undefined)));
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
