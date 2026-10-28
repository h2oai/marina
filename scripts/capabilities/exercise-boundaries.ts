// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { type ExerciseContext, exercises } from "./exercise";

/** Exercise concrete external/model admissions without equating an acknowledgement,
 * catalog, queue entry, empty result or provider refusal with completed work. */
export async function exerciseBoundaries(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  const run = async (input: string, selectors: string[], prerequisite?: string) => {
    const commands = ctx.inventory.commands.flatMap((c) =>
      (c.forms ?? [])
        .filter((f) =>
          selectors.some((s) =>
            ctx.inventory.commands.some((c) => c.forms?.some((f) => f.syntax === s))
              ? f.syntax === s
              : f.syntax.startsWith(s),
          ),
        )
        .map((f) => f.syntax),
    );
    assert(commands.length, input);
    try {
      const output = await ctx.command("operator", input);
      ctx.record({
        id: `boundary:${input}`,
        status:
          prerequisite ||
          /unavailable|not configured|no provider|missing.*key|requires.*key|failed to fetch|unable to connect|ENOTFOUND|ECONNREFUSED|blocked|not found|no .*available/i.test(
            output,
          )
            ? "blocked"
            : "observed",
        commands,
        detail: JSON.stringify({
          input,
          output,
          prerequisite,
          scope:
            "Actual execution/admission evidence only. This does not qualify the requested final result without a checked artifact.",
        }),
      });
    } catch (error) {
      ctx.record({
        id: `boundary:${input}`,
        status: /not running|active task|approval withheld|No LLM provider|not configured/.test(
          String(error),
        )
          ? "blocked"
          : "failed",
        commands,
        detail: JSON.stringify({
          input,
          error: String(error),
          scope:
            "Actual command threw or exceeded its deadline; inspect the exact error before attributing the cause.",
        }),
      });
    }
  };
  const model = ctx.model ?? "openrouter/deepseek/deepseek-v4.1-flash";
  for (const [input, selectors] of [
    ["arena status", ["arena [status]"]],
    ["arena health", ["arena health"]],
    ["arena rounds 1", ["arena rounds "]],
    ["arena submissions", ["arena submissions"]],
    ["arena discover n:1", ["arena discover "]],
    ["arena evaluate baseline limit:1", ["arena evaluate "]],
    ["arena backtest 1", ["arena backtest "]],
    ["arena signals", ["arena signals "]],
    ["arena shadow list", ["arena shadow [list]"]],
    ["arena shadow run due", ["arena shadow run "]],
    ["arena shadow score", ["arena shadow score"]],
    ["data sources", ["data sources"]],
    ["data markets Federal Reserve", ["data markets "]],
    ["data odds americanfootball_nfl", ["data odds <sport_key>"]],
    ["data odds Chiefs", ["data odds <team"]],
    ["data series UNRATE", ["data series <id|query>", "data series UNRATE"]],
    ["data series CPIAUCSL asof:2026-06-30", ["data series CPIAUCSL asof:2026-06-30"]],
    ["data polls approval Donald Trump", ["data polls "]],
    ["data crowd Federal Reserve", ["data crowd "]],
    ["web fetch https://example.com", ["web fetch <url>"]],
    ["web fetch https://example.com asof:2026-06-30", ["web fetch <url> asof:"]],
    ["web search limit:1 Marina agent memory", ["web search <query>", "web search [engines:"]],
    ["web search limit:5 Marina agent memory", ["web search limit:5 "]],
    ["web search before:2026-06-30 Marina agent memory", ["web search before:"]],
    ["web search engines:web,academic agent memory", ["web search engines:web,academic "]],
    [
      "web multisearch agent memory | agent coordination | long horizon tasks",
      ["web multisearch "],
    ],
    ["web swarm docs:1 agent memory", ["web swarm ["]],
    ["web swarm engines:corpus:qualification agent memory", ["web swarm engines:corpus:"]],
    ["market list", ["market list"]],
    ["market list open", ["market list open"]],
    ["market list resolved", ["market list resolved"]],
    ["market leaderboard", ["market leaderboard"]],
    ["market score CleanOwner", ["market score "]],
    ["market search Federal Reserve", ["market search "]],
    ["market live kalshi 1h 1", ["market live "]],
    ["demo preflight", ["demo preflight"]],
    ["demo qualify", ["demo qualify"]],
    ["demo status", ["demo status"]],
    ["demo recover", ["demo recover"]],
    ["demo reset", ["demo reset"]],
    ["demo warm", ["demo warm"]],
    ["build command", ["build command", "build command [args]"]],
    ["pool qa-pool ratify 1", ["pool <name> ratify"]],
    ["probe", ["probe"]],
    ["novelty suggest Verify arithmetic", ["novelty suggest "]],
    ["decision check Compute 19*23 | 19*23=438", ["decision check "]],
    ["decision choose What is19*23? | 437 | 438", ["decision choose "]],
    ["decision qualify", ["decision qualify"]],
    ["evolve qualify", ["evolve qualify"]],
    [
      "forecast retriever:search -- Is19 times23 equal to437?",
      ["forecast <question> [resolves:", "forecast [formation:"],
    ],
    [
      "forecast Is19 times23 equal to437? type:choice options:yes,no",
      ["forecast <question> type:"],
    ],
    [
      "forecast Is19 times23 equal to437? crew:qa-crew residents:1 measure:yes",
      ["forecast <question> crew:"],
    ],
    [
      "forecast Is19 times23 equal to437? role:qa-child-role residents:1 measure:yes",
      ["forecast <question> role:"],
    ],
    ["triage What is19 times23?", ["triage "]],
    [
      "research ask mode:retrieve retriever:search budget:2 -- What is19 times23?",
      ["research ask "],
    ],
    [
      `benchmark compare-run smoke arms:bare,on cap:5 replicates:1 limit:1 model:${model} concurrency:1`,
      ["benchmark compare-run <"],
    ],
    [
      "benchmark kit ifbench arms:bare replicates:1 limit:1 budget:5 dry-run",
      ["benchmark kit <setup>"],
    ],
    ["benchmark sweep smoke --limit 1 --seed 317", ["benchmark sweep "]],
  ] as Array<[string, string[]]>)
    await run(input, selectors);
  // Recipes create durable projects/tasks and may start residents. Bound their
  // observation period and explicitly retain unfinished work as unqualified.
  for (const name of [
    "desire",
    "dig",
    "explore",
    "plan",
    "solve",
    "research",
    "debate",
    "monitor",
  ]) {
    const before = new Set(
      (ctx.db.query("SELECT name FROM agent_configs").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    await run(
      `${name} Verify19 times23 equals437 using calc; report the result and stop. Do not spawn further agents.`,
      [`${name} <`],
    );
    if (ctx.live) {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const pending = ctx.db
          .query("SELECT count(*) AS n FROM task_claims WHERE status='claimed'")
          .get() as { n: number };
        if (!pending.n && Date.now() > deadline - 15_000) break;
        await Bun.sleep(250);
      }
    }
    for (const row of ctx.db.query("SELECT name FROM agent_configs").all() as Array<{
      name: string;
    }>) {
      if (!before.has(row.name)) await ctx.command("operator", `agent stop ${row.name}`);
    }
  }
  await run("pattern run ensemble budget:5 -- Verify19 times23 equals437", ["pattern run "]);
  // No image, speech or video provider is selected by the one-text-model arm.
  for (const [input, selectors] of [
    ["image generate A blue square width:64 height:64 style:synthwave", ["image generate "]],
    ["video generate A blue square --duration 1 --fps 1", ["video generate "]],
    ["audio speak format:wav -- Qualification arithmetic is437.", ["audio speak "]],
  ] as Array<[string, string[]]>)
    await run(
      input,
      selectors,
      "Only the configured cheap text model is authorized; no media-generation provider credential is present.",
    );
  await check(
    "key add qa-synthetic anthropic qualification-invalid-fixture",
    /added|stored|saved/i,
    ["key add "],
    undefined,
    "operator",
  );
  await check("key list", /qa-synthetic/, ["key list"], undefined, "operator");
  await run(
    "key test qa-synthetic",
    ["key test "],
    "Synthetic invalid credential: connectivity/authentication rejection only; no valid Anthropic provider is configured.",
  );
  await check(
    "key delete qa-synthetic",
    /deleted|removed/i,
    ["key delete "],
    undefined,
    "operator",
  );
  await run("witness", ["witness"]);
  await run("witness queue", ["witness queue"]);
  await run("witness request shell.exec", ["witness request "]);
  await run("witness grant CleanWorker shell.exec", ["witness grant "]);
  await run("recruit CleanOwner,CleanWorker into qa-recruit role=qa-child-role", [
    "recruit <a,b,c>",
  ]);
  await run("recruit best into qa-recruit-best for Verify arithmetic count=1", ["recruit best "]);
  // Keep valid model-facing requests in an actual open coding session.
  await ctx.command(
    "operator",
    `agent spawn QaCoder model ${model} budget 2 goal Read the controlled arithmetic fixture only when assigned. Do not spawn agents or edit files.`,
  );
  await ctx.command("operator", "code start Model admission fixture");
  for (const [input, selectors] of [
    ["code ask Explain the arithmetic.test.ts fixture", ["code ask "]],
    [
      "code do verification:candidate budget:3m -- Read arithmetic.test.ts and verify19*23=437. Do not change files.",
      ["code do "],
    ],
    ["code assign QaCoder Verify19*23=437", ["code assign <agent> <req>"]],
    [
      "code assign QaCoder verification:candidate -- Verify19*23=437",
      ["code assign <agent> verification:"],
    ],
    ["code crew Verify the arithmetic fixture with CleanOwner,CleanWorker", ["code crew "]],
    ["code assume The task is the controlled arithmetic fixture", ["code assume "]],
    ["code blocked kind:decision Human review required", ["code blocked "]],
    ["code review", ["code review"]],
    ["code review approve", ["code review approve"]],
    ["code review reject", ["code review reject"]],
    ["code run app test", ["code run app "]],
    ["code spawn qa-child-role Verify arithmetic and stop", ["code spawn <role>"]],
  ] as Array<[string, string[]]>) {
    // Separate positive assignment admission from the preceding active task.
    if (input.startsWith("code assign")) await ctx.command("operator", "code stop");
    await run(input, selectors);
  }
  await ctx.command("operator", "code stop");
  await ctx.command("operator", "code exit");
  // All resident calls created by these bounded attempts stop before continuity checks.
  for (const row of ctx.db.query("SELECT name FROM agent_configs").all() as Array<{ name: string }>)
    await ctx.command("operator", `agent stop ${row.name}`);
}
