// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { type ExerciseContext, exercises } from "./exercise";

const forms = (ctx: ExerciseContext, prefix: string) =>
  ctx.inventory.commands.flatMap((c) =>
    (c.forms ?? []).filter((f) => f.syntax.startsWith(prefix)).map((f) => f.syntax),
  );
async function until(predicate: () => boolean, ms = 90000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    assert(Date.now() < end, "Timed out waiting for durable terminal result");
    await Bun.sleep(100);
  }
}

export async function exerciseAgents(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  const name = "QaResident";
  const model = ctx.model ?? "openrouter/deepseek/deepseek-v4.1-flash";
  const input = `agent spawn ${name} model ${model} budget 1 goal Reply once with qa-resident-437 then rest; do not spawn agents or modify any files.`;
  const out = await ctx.command("operator", input);
  if (!ctx.live) {
    ctx.record({
      id: "agent:no-provider",
      status: "blocked",
      commands: forms(ctx, "agent spawn "),
      detail: JSON.stringify({
        input,
        out,
        prerequisite:
          "No provider credential is present; a durable resident lifecycle cannot be qualified by acceptance of a spawn request.",
      }),
    });
  } else {
    await ctx.scenario(
      "agent:real-model-call",
      async () => {
        assert.match(out, /spawn|Spawn/);
        await until(
          () =>
            !!ctx.db
              .query(
                "SELECT 1 FROM event_log WHERE data LIKE '%QaResident%' AND type='agent_turn_end' ",
              )
              .get(),
          45000,
        );
        return out;
      },
      forms(ctx, "agent spawn "),
    );
  }
  // Even a provider refusal may leave a genuine saved resident, useful for lifecycle checks.
  const saved = ctx.db.query("SELECT 1 FROM agent_configs WHERE name=?").get(name);
  await check("agent list", /agent|Agent|resident|Resident/, ["agent list"]);
  if (!saved) {
    for (const f of forms(ctx, "agent ").filter(
      (f) => !f.startsWith("agent spawn ") && f !== "agent list",
    ))
      ctx.record({
        id: `agent:prerequisite:${f}`,
        status: "blocked",
        commands: [f],
        detail: `The actual spawn attempt did not create ${name}; dependent lifecycle needs a saved/running resident. ${out}`,
      });
    return;
  }
  for (const [sub, arg, pattern] of [
    ["status", "", /QaResident/],
    ["diagnose", "", /QaResident/],
    ["attention", "qa-attention-437", /attention|Attention|sent|Sent/],
    ["attention-feedback", "noise", /threshold|learned/],
    ["attention-feedback", "useful", /threshold|learned/],
    ["attention-mode", "focused", /focused/],
    ["attention-mode", "balanced", /balanced/],
    ["attention-mode", "open", /open/],
    ["focus", "Only verify qa-resident-437", /focus|Focus/],
  ] as Array<[string, string, RegExp]>)
    await check(
      `agent ${sub} ${name} ${arg}`.trim(),
      pattern,
      sub === "attention-mode" || sub === "attention-feedback"
        ? [`agent ${sub} <name> ${arg}`]
        : [`agent ${sub} `],
      undefined,
      "operator",
    );
  for (const [field, val] of [
    ["model", model],
    ["role", "qa-child-role"],
    ["thinking", "off"],
  ])
    await check(
      `agent config ${name} ${field} ${val}`,
      /updated|reconfigured|Reconfiguring/,
      [`agent config <name> ${field} `, "agent config <name> .."],
      undefined,
      "operator",
    );
  for (const input of [`agent restart ${name}`, `agent failover ${name} ${model}`])
    await check(
      input,
      /restarted|failed over/,
      [input.startsWith("agent restart") ? "agent restart " : "agent failover "],
      undefined,
      "operator",
    );
  const relayInput = `agent attention-mode ${name} relay:explicit`;
  for (const prefix of [`@${name} `, `@${name},${name} `, "@all "]) {
    const input = `${prefix}qa-attention-prefix-934`;
    const output = await ctx.command("operator", input);
    ctx.record({
      id: `prefix-runtime:${prefix}`,
      status: /not running|No agents|Usage:/.test(output) ? "blocked" : "observed",
      detail: JSON.stringify({
        input,
        output,
        scope:
          "Runtime resident attention routing, not a direct-message alias. Final model response is not implied.",
      }),
    });
  }
  const relay = await ctx.command("operator", relayInput);
  ctx.record({
    id: "agent:supervised-relay-prerequisite",
    status: "blocked",
    commands: ["agent attention-mode <name> relay:all|explicit"],
    detail: JSON.stringify({
      input: relayInput,
      output: relay,
      prerequisite:
        "Relay selection applies to a supervised native resident. This arm runs built-in residents, not an external native supervisor.",
    }),
  });
  const keys = await ctx.command("operator", "key list");
  ctx.record({
    id: "agent:named-key-prerequisite",
    status: "blocked",
    commands: ["agent config <name> key <value>"],
    detail: JSON.stringify({
      input: "key list",
      output: keys,
      prerequisite:
        "The live credential is environment-only. No named valid credential is installed for key rebinding; synthetic credentials cannot qualify this path.",
    }),
  });
  await check(
    `agent stop ${name}`,
    /stopped|Stopped|stop sent/i,
    ["agent stop "],
    undefined,
    "operator",
  );
  await check(`agent disable ${name}`, /disabled/, ["agent disable "], undefined, "operator");
  await check(`agent enable ${name}`, /enabled/, ["agent enable "], undefined, "operator");
}

export async function exerciseBenchmarks(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  for (const [input, expected, selectors] of [
    ["benchmark list", /smoke/, ["benchmark list"]],
    ["benchmark defaults", /default|Default|slot|Slot/, ["benchmark defaults"]],
    [
      "benchmark orchestrations",
      /orchestration|Orchestration|formation|Formation/,
      ["benchmark orchestrations"],
    ],
    ["benchmark reference", /reference|Reference/, ["benchmark reference"]],
    [
      "benchmark reference benchmark",
      /reference|Reference|benchmark|Benchmark/,
      ["benchmark reference benchmark"],
    ],
    ["benchmark reference model", /reference|Reference|model|Model/, ["benchmark reference model"]],
    ["benchmark kit list", /kit|Kit|setup|Setup/, ["benchmark kit [list]"]],
    [
      "benchmark kit doctor",
      /Model tier: [\s\S]*\[(?:ok\s*|warn|MISS)\] Model access/,
      ["benchmark kit doctor "],
    ],
    ["benchmark kit status", /kit|Kit|No|no/, ["benchmark kit status "]],
    ["benchmark compare-run status", /No|comparison|Comparison/, ["benchmark compare-run status "]],
  ] as Array<[string, RegExp, string[]]>)
    await check(input, expected, selectors, undefined, "operator");
  const ids: string[] = [];
  for (const seed of [317, 319]) {
    const input = `benchmark run smoke model:${ctx.model ?? "openrouter/deepseek/deepseek-v4.1-flash"} --limit 1 --seed ${seed} --concurrency 1 cap:5`;
    const out = await ctx.command("operator", input);
    const id = out.match(/\bid:\s+(\S+)/)?.[1];
    if (!id) {
      ctx.record({
        id: `benchmark:start:${seed}`,
        status: "blocked",
        commands: forms(ctx, "benchmark run "),
        detail: JSON.stringify({ input, out }),
      });
      continue;
    }
    ids.push(id);
    await until(
      () =>
        !!ctx.db
          .query(
            "SELECT 1 FROM benchmark_runs WHERE id=? AND status NOT IN ('running','pending','queued')",
          )
          .get(id),
      150000,
    );
    const run = ctx.db.query("SELECT * FROM benchmark_runs WHERE id=?").get(id) as {
      status: string;
      answered: number;
    };
    const items = ctx.db.query("SELECT * FROM benchmark_items WHERE run_id=?").all(id);
    ctx.record({
      id: `benchmark:terminal:${seed}`,
      status:
        run.status === "completed" && run.answered > 0 && items.length > 0
          ? "works"
          : ctx.live
            ? "failed"
            : "blocked",
      commands: forms(ctx, "benchmark run "),
      detail: JSON.stringify({
        input,
        out,
        run,
        items,
        scope:
          "One real item, terminal durable scoring receipt. No statistical productivity claim.",
      }),
    });
    await check(`benchmark result ${id}`, new RegExp(id), ["benchmark result "]);
    await check(`benchmark replicates ${id}`, /replicate|Replicate|run|Run/, [
      "benchmark replicates ",
    ]);
    await check(
      `benchmark invalidate ${id} reason:qualification-fixture`,
      /invalid|Invalid/,
      ["benchmark invalidate "],
      undefined,
      "operator",
    );
    await check(
      `benchmark revalidate ${id} reason:retained-audit`,
      /valid|Valid/,
      ["benchmark revalidate "],
      undefined,
      "owner",
    );
  }
  if (ids.length === 2)
    await check(
      `benchmark compare ${ids[0]} ${ids[1]}`,
      /smoke|Compare|comparison|incompatible|same/i,
      ["benchmark compare "],
    );
  for (const sub of ["runs", "leaderboard", "participants", "frontier"]) {
    const input = `benchmark ${sub}${sub === "runs" ? " --benchmark smoke" : " smoke"}`;
    await check(input, /smoke|No|no|Frontier|frontier|participant|Participant|Benchmark/, [
      `benchmark ${sub} `,
    ]);
  }
  if (ids[0])
    for (const sub of ["challenge", "promote"]) {
      const input = `benchmark ${sub} qualification:fixture ${ids[0]}`;
      const out = await ctx.command("operator", input);
      ctx.record({
        id: `benchmark:${sub}:insufficient`,
        status: "observed",
        commands: forms(ctx, `benchmark ${sub} `),
        detail: JSON.stringify({
          input,
          out,
          scope:
            "A one-item sample cannot qualify a statistically justified promotion. This records the actual admission result.",
        }),
      });
    }
  await check(
    "benchmark purge-content-notes confirm:yes",
    /purged|Purge|purge|No|no/,
    ["benchmark purge-content-notes "],
    undefined,
    "operator",
  );
}

export async function exerciseInquiry(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  for (const kind of ["predict", "research"]) {
    const input = `inquiry ${kind} ${kind === "predict" ? "runs:1 " : ""}-- In this controlled qualification, is 19 times 23 equal to 437?`;
    const out = await ctx.command("owner", input);
    const caseId = out.match(/Case (\S+)/)?.[1],
      attempt = out.match(/Attempt (\S+)/)?.[1];
    if (!caseId || !attempt) {
      ctx.record({
        id: `inquiry:${kind}:admission`,
        status: "failed",
        commands: forms(ctx, `inquiry ${kind} `),
        detail: JSON.stringify({ input, out }),
      });
      continue;
    }
    await check("inquiry list", new RegExp(caseId), ["inquiry list"]);
    await check(`inquiry grant ${caseId} CleanWorker read`, /granted/, ["inquiry grant "]);
    await check(`inquiry show ${caseId}`, /437/, ["inquiry show "], undefined, "worker");
    await check(`inquiry revoke ${caseId} CleanWorker`, /revoked/, ["inquiry revoke "]);
    await check(
      `inquiry review ${attempt} -- This is a controlled arithmetic fixture, not a real-world prediction.`,
      /Review added/,
      ["inquiry review "],
    );
    // Allow the production ten-minute work limit plus settlement time. Read
    // lifecycle state from its receipt; completed reports can include failures
    // of individual research sections without failing the whole attempt.
    const end = Date.now() + (ctx.live ? 660000 : 8000);
    let state = "";
    let lifecycle = "";
    while (Date.now() < end) {
      const view = await ctx.command("owner", `inquiry show ${caseId}`);
      state = view;
      lifecycle =
        (
          ctx.db.query("SELECT state FROM investigation_attempts WHERE id=?").get(attempt) as {
            state: string;
          } | null
        )?.state ?? "missing";
      if (!["queued", "running"].includes(lifecycle)) break;
      await Bun.sleep(500);
    }
    ctx.record({
      id: `inquiry:${kind}:result`,
      status: lifecycle === "completed" ? "observed" : ctx.live ? "failed" : "blocked",
      commands: forms(ctx, `inquiry ${kind} `),
      detail: JSON.stringify({
        input,
        out,
        state,
        lifecycle,
        scope:
          "Case persistence and execution inspected; an answer requires an independent correctness check before works.",
      }),
    });
    for (const sub of ["why", "sources", "report"])
      await check(
        `inquiry ${sub} ${caseId}`,
        /437|source|Source|report|Report|attempt|Attempt|evidence|Evidence|state|State|queued|failed|running/,
        [`inquiry ${sub} `],
      );
    await check(`inquiry events ${attempt}`, /Cursor/, ["inquiry events "]);
    await check(`inquiry select ${attempt}`, /437|attempt|Attempt/, ["inquiry select "]);
    await check(`inquiry cancel ${attempt}`, /Cancelled/, ["inquiry cancel "]);
    const resolveInput = `inquiry resolve ${attempt} -- {"type":"binary","value":true}`;
    const resolveOut = await ctx.command("owner", resolveInput);
    ctx.record({
      id: `inquiry:${kind}:resolve`,
      status: "observed",
      commands: forms(ctx, "inquiry resolve "),
      detail: JSON.stringify({
        input: resolveInput,
        out: resolveOut,
        scope:
          "Actual outcome admission on this attempt; no fabricated answer or outcome inserted.",
      }),
    });
    await check(`inquiry delete ${caseId}`, /erased/, ["inquiry delete "]);
  }
}
