// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import type { ExerciseContext } from "./exercise";

/** Recruitment must lead to useful work by real running residents. */
export async function exerciseRecruitment(ctx: ExerciseContext) {
  const commands = ctx.inventory.commands
    .find((c) => c.name === "recruit")
    ?.forms?.map((f) => f.syntax);
  if (!ctx.live) {
    ctx.record({
      id: "recruitment:no-provider",
      status: "blocked",
      commands,
      detail: "Recruitment needs running model residents; no provider is configured.",
    });
    return;
  }
  const names = ["QaRecruitOne", "QaRecruitTwo"];
  const crew = "qa-recruited";
  await ctx.scenario(
    "real-recruitment",
    async () => {
      await ctx.command(
        "operator",
        `crew create ${crew} CleanOperator persist -- Compute independently checkable products`,
      );
      try {
        for (const name of names) {
          let spawned = "";
          const spawnDeadline = Date.now() + 5000;
          do {
            spawned = await ctx.command(
              "operator",
              `agent spawn ${name} model ${ctx.model} budget 30 goal Wait for assignment to crew ${crew}, then wait for a direct instruction. Do not spawn agents or change files.`,
            );
            if (!spawned.includes("Spawn cooldown")) break;
            await Bun.sleep(250);
          } while (Date.now() < spawnDeadline);
          assert.match(spawned, /spawned and running/);
        }
        let available = "";
        const deadline = Date.now() + 90000;
        do {
          available = await ctx.command("operator", "recruit available");
          if (names.every((name) => available.includes(name))) break;
          await Bun.sleep(100);
        } while (Date.now() < deadline);
        for (const name of names) assert.match(available, new RegExp(name));
        const candidates = await ctx.command(
          "operator",
          "recruit match compute arithmetic limit=5",
        );
        for (const name of names) assert.match(candidates, new RegExp(name));
        const named = await ctx.command("operator", `recruit ${names[0]} into ${crew}`);
        assert.match(named, new RegExp(names[0]!));
        const matched = await ctx.command(
          "operator",
          `recruit best into ${crew} for compute arithmetic count=1`,
        );
        assert.match(matched, new RegExp(names[1]!));
        await ctx.command(
          "operator",
          `crew dispatch ${crew} Wait for individually assigned arithmetic work.`,
        );
        const channel = ctx.db
          .query(
            "SELECT c.name FROM channels c JOIN crews cr ON cr.channel_id=c.id WHERE cr.name=?",
          )
          .get(crew) as { name: string } | null;
        assert(channel, "Dispatched crew has a durable channel");
        for (const [index, name] of names.entries()) {
          const expression = index ? "17 * 29" : "13 * 31";
          const expected = index ? "493" : "403";
          await ctx.command(
            "operator",
            `agent attention ${name} Calculate ${expression}, then use channel send ${channel.name} ${name}-result- followed by the numeric answer. This is your only task; do not change files or spawn agents.`,
          );
          let history = "";
          const taskDeadline = Date.now() + 90000;
          do {
            history = await ctx.command("operator", `channel history ${channel.name} 30`);
            if (new RegExp(`${name}-result-\\s*${expected}`).test(history)) break;
            await Bun.sleep(250);
          } while (Date.now() < taskDeadline);
          assert.match(history, new RegExp(`${name}-result-\\s*${expected}`));
        }
        const status = await ctx.command("operator", `crew info ${crew}`);
        for (const name of names) assert.match(status, new RegExp(name));
        return JSON.stringify({
          available,
          named,
          matched,
          status,
          scope:
            "Named and best-fit recruitment of two real residents followed by independently correct routed work; native supervision is a separate capability.",
        });
      } finally {
        for (const name of names) await ctx.command("operator", `agent stop ${name}`);
        await ctx.command("operator", `crew dissolve ${crew} qualification-finished`);
      }
    },
    commands,
  );
}
