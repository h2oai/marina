import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB, ProductivitySummary } from "../../persistence/database";
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

export function productivityCommand(db: MarinaDB): CommandDef {
  return {
    name: "productivity",
    aliases: ["impact"],
    category: "Coordination",
    help: "Outcome-level productivity. Usage: productivity [agent <name>|leaderboard|trend]",
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
      } else {
        const name = action === "agent" ? input.tokens.slice(1).join(" ") : undefined;
        lines.push(render(db.getProductivitySummary(name || undefined)));
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
