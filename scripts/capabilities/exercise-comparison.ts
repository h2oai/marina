// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { ExerciseContext } from "./exercise";

/** A matched real-provider plumbing comparison; this micro-eval is not a productivity study. */
export async function exerciseComparison(ctx: ExerciseContext) {
  const commands = ctx.inventory.commands
    .flatMap((c) => c.forms ?? [])
    .filter((f) => f.syntax.startsWith("benchmark compare-run <"))
    .map((f) => f.syntax);
  if (!ctx.live) {
    ctx.record({
      id: "comparison:no-provider",
      status: "blocked",
      commands,
      detail: "Both arms require a provider.",
    });
    return;
  }
  await ctx.scenario(
    "comparison:bare-on",
    async () => {
      const input = `benchmark compare-run smoke arms:bare,on cap:10 replicates:3 limit:15 model:${ctx.model} concurrency:2`;
      const started = await ctx.command("operator", input);
      const deadline = Date.now() + 600000;
      let rows: Array<{
        id: string;
        status: string;
        replicate_group: string;
        answered: number;
        total: number;
        cost_usd: number;
        config_json: string;
      }> = [];
      while (Date.now() < deadline) {
        rows = ctx.db
          .query(
            "SELECT * FROM benchmark_runs WHERE replicate_group LIKE 'cmp:%' ORDER BY started_at,id",
          )
          .all() as typeof rows;
        if (
          rows.length === 6 &&
          rows.every((r) => !["pending", "running", "queued"].includes(r.status))
        )
          break;
        await Bun.sleep(250);
      }
      assert.equal(rows.length, 6, started);
      assert(
        rows.every((r) => r.status === "completed" && r.answered === 15),
        JSON.stringify(rows),
      );
      const groups = [...new Set(rows.map((r) => r.replicate_group))];
      assert.equal(groups.length, 2);
      const ids = rows.map((r) => r.id);
      const items = ctx.db
        .query(
          `SELECT * FROM benchmark_items WHERE run_id IN (${ids.map(() => "?").join(",")}) ORDER BY run_id,item_id`,
        )
        .all(...ids);
      assert.equal(items.length, 90);
      const status = await ctx.command("operator", "benchmark compare-run status");
      assert.doesNotMatch(status, /distinct identity|failed/i);
      return JSON.stringify({
        input,
        started,
        rows,
        items,
        status,
        scope:
          "Three matched replicates per arm, same 15 fixed smoke items. Plumbing and descriptive accuracy/cost only; no held-out productivity or learned benefit claim.",
      });
    },
    commands,
  );
}
