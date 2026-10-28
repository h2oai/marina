// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseCodeDelivery(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  await check("code start Qualification delivery", /session|started/i, ["code start "]);
  await check("code", /Code|code|session/, ["code"]);
  const finished = async (out: string) => {
    const request = out.match(/Verification started: (\S+)/)?.[1];
    if (!request) return out;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const row = ctx.db
        .query("SELECT status,metadata_json FROM coding_artifacts WHERE id=?")
        .get(request) as { status: string; metadata_json: string } | null;
      const result = row ? JSON.parse(row.metadata_json).resultArtifactId : undefined;
      if (result) return ctx.command("owner", `code show ${result}`);
      await Bun.sleep(100);
    }
    throw new Error(`Verification ${request} did not produce a terminal receipt`);
  };
  for (const [input, selectors] of [
    ["code verify start", ["code verify start"]],
    ["code verify candidate", ["code verify candidate"]],
    ["code verify candidate dependencies:auto", ["code verify candidate dependencies:auto"]],
    ["code verify scope:changed+full budget:10m", ["code verify scope:changed+full budget:10m"]],
  ] as Array<[string, string[]]>) {
    const out = await ctx.command("owner", input);
    const status = await finished(out);
    ctx.record({
      id: `delivery:${input}`,
      status:
        /passed|verified|succeeded/i.test(status + out) &&
        !/failed|unavailable|Refused|no active/i.test(status + out)
          ? "works"
          : "failed",
      commands: selectors,
      detail: JSON.stringify({
        input,
        out,
        status,
        scope:
          "Bounded finite checks on the controlled local fixture; no inference about arbitrary projects.",
      }),
    });
  }
  writeFileSync(
    join(ctx.workspace, "delivery.json"),
    JSON.stringify({
      files: ["package.json", "arithmetic.test.ts"],
      checks: ["bun test"],
      requirements: [{ text: "19 times 23 equals437", checks: [0] }],
    }),
  );
  const input = "code verify delivery manifest:delivery.json";
  const out = await ctx.command("owner", input);
  const status = await finished(out);
  ctx.record({
    id: "delivery:manifest",
    status:
      /passed|verified|succeeded/i.test(status + out) && !/failed|Refused/i.test(status + out)
        ? "works"
        : "failed",
    commands: ["code verify delivery manifest:<path>"],
    detail: JSON.stringify({ input, out, status }),
  });
  const request = await check(
    "code review request CleanWorker -- Verify the arithmetic fixture and its explicit checks",
    /review_[a-z0-9]+/,
    ["code review request "],
  );
  const review = request.match(/review_[a-z0-9]{12}/)?.[0];
  if (review) {
    await check(
      `code review ${review}`,
      /arithmetic|Review|review/,
      ["code review <review_id>"],
      undefined,
      "worker",
    );
    await check(
      `code review verdict ${review} approve -- The controlled test proves only19*23=437.`,
      /approve|verdict|recorded/i,
      ["code review verdict "],
      undefined,
      "worker",
    );
    await check(
      `code review approve ${review}`,
      /approv|closed|merged/i,
      ["code review approve|reject <review_id>"],
      undefined,
      "operator",
    );
  }
  await check("code stop", /stop|Stopped|No active/i, ["code stop"]);
  await ctx.command("owner", "code exit");
  // Creator-owned person session verifies explicit local execution opt-in.
  await check(
    "code start Operator execution fixture",
    /session|started/i,
    ["code start "],
    undefined,
    "operator",
  );
  await check("code exec-mode auto", /exec-mode: auto/, ["code exec-mode "], undefined, "operator");
  await check(
    "code run printf qa-execution-437",
    /qa-execution-437/,
    ["code run <"],
    undefined,
    "operator",
  );
  await check(
    "code exec-mode prompt",
    /exec-mode: prompt/,
    ["code exec-mode "],
    undefined,
    "operator",
  );
  await check("code exec-mode off", /disabled/, ["code exec-mode "], undefined, "operator");
  await ctx.command("operator", "code exit");
  // No provider is available for a VM. Actually invoke every advertised lifecycle guard.
  for (const tail of [
    "start",
    "use",
    "resume",
    "hibernate",
    "stop confirm",
    "stop discard confirm",
    "ops inventory",
    "ops metrics",
    "ops reconcile",
    "ops reclaim confirm",
    "ops hibernate CleanOwner confirm",
    "ops revoke CleanOwner confirm",
    "ops stop CleanOwner confirm",
  ]) {
    const input = `code sandbox ${tail}`;
    const out = await ctx.command("operator", input);
    const prefix = `code sandbox ${tail
      .split(" ")
      .slice(0, tail.startsWith("ops") ? 2 : 1)
      .join(" ")}`;
    const commands = ctx.inventory.commands
      .find((c) => c.name === "code")!
      .forms!.filter((f) => f.syntax === prefix || f.syntax.startsWith(`${prefix} `))
      .map((f) => f.syntax);
    assert(commands.length, input);
    ctx.record({
      id: `sandbox-prerequisite:${tail}`,
      status: "blocked",
      commands,
      detail: JSON.stringify({
        input,
        out,
        prerequisite:
          "No VM sandbox provider configured. Local execution tests are not sandbox qualification.",
      }),
    });
  }
}
