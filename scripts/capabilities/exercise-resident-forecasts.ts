// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { ExerciseContext } from "./exercise";

/** Keep the real responder alive until both endpoint and role paths have settled. */
export async function exerciseResidentForecasts(ctx: ExerciseContext) {
  const commands = ctx.inventory.commands.flatMap((c) =>
    (c.forms ?? [])
      .filter((f) => /forecast <question> (crew|role):/.test(f.syntax))
      .map((f) => f.syntax),
  );
  if (!ctx.live) {
    ctx.record({
      id: "resident-forecasts:no-provider",
      status: "blocked",
      commands,
      detail: "No provider configured; live resident answers require a provider.",
    });
    return;
  }
  const name = "QaForecast",
    crew = "qa-forecast-crew",
    role = "qa-forecast-role";
  await ctx.command(
    "operator",
    `role create ${role} guidelines Answer routed forecast requests using the requested response schema; use evidence and respect the as-of fence. tone concise`,
  );
  await ctx.command("operator", `channel create model-${crew}`);
  let spawned = "";
  const spawnDeadline = Date.now() + 5000;
  do {
    spawned = await ctx.command(
      "operator",
      `agent spawn ${name} model ${ctx.model} role ${role} budget 80 goal Join channel model-${crew}, then wait for model requests. Answer each model request in its requested schema, encoded as the string content of a model_response envelope with the exact request id. Do not spawn agents or change files.`,
    );
    if (!spawned.includes("Spawn cooldown")) break;
    await Bun.sleep(250);
  } while (Date.now() < spawnDeadline);
  assert.match(spawned, /spawned and running/);
  try {
    const deadline = Date.now() + 90000;
    while (
      !ctx.db
        .query(
          "SELECT 1 FROM channel_members m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.entity_id WHERE c.name=? AND u.name=?",
        )
        .get(`model-${crew}`, name)
    ) {
      assert(Date.now() < deadline, "Resident did not join its live model endpoint");
      await Bun.sleep(100);
    }
    await ctx.command(
      "operator",
      `crew create ${crew} ${name} formation:solo -- Answer forecast requests`,
    );
    await ctx.command(
      "operator",
      `agent attention ${name} Accept your invitation to crew ${crew}; continue serving model-${crew}.`,
    );
    await ctx.command("operator", `channel leave model-${crew}`);
    for (const selector of [`role:${role}`, `crew:${crew}`]) {
      await ctx.scenario(
        `resident-forecasts:${selector}`,
        async () => {
          const input = `forecast What is 19 times 23? type:number ${selector} residents:1 retriever:closed-book`;
          const output = await ctx.command("operator", input);
          const id = output.match(/saved as forecast #(\d+)/)?.[1];
          assert(id, output);
          const row = ctx.db.query("SELECT * FROM forecast_answers WHERE id=?").get(Number(id)) as {
            mean: number;
            answer_json: string;
          };
          assert.equal(row.mean, 437, output);
          assert.match(row.answer_json, new RegExp(name));
          assert.match(row.answer_json, /requestId|request_id|req-/);
          return JSON.stringify({
            input,
            output,
            row,
            scope:
              "Live resident numeric completion and provenance. Historical evidence filtering is qualified separately.",
          });
        },
        commands.filter((f) => f.includes(selector.startsWith("role:") ? "role:" : "crew:")),
      );
    }
  } finally {
    await ctx.command("operator", `agent stop ${name}`);
    await ctx.command("operator", `crew dissolve ${crew} qualification-finished`);
  }
}
