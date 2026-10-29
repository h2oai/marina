// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { type ExerciseContext, exercises } from "./exercise";

export const receipt = (output: string) => {
  const marker = output.lastIndexOf("Memory service");
  const start = output.indexOf("{", Math.max(marker, 0));
  assert(start >= 0, output);
  return JSON.parse(output.slice(start)) as { id: string; version: number; space_id: string };
};
export async function exerciseMemoryAdvanced(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  const storedOutput = await check("memory remember qa-native-record-271", /"id"/, [
    "memory remember ",
  ]);
  const stored = receipt(storedOutput);
  stored.space_id = storedOutput.match(/space (\S+)/)![1]!;
  await check(`memory show ${stored.id}`, /qa-native-record-271/, ["memory show "]);
  await check(
    `memory api ${JSON.stringify({ operation: "get", id: stored.id })}`,
    /qa-native-record-271/,
    ["memory api "],
  );
  await check("memory guide", /memory|workflow|durable/i, ["memory guide"]);
  const recipe = {
    schema: "marina.memory.policy.v1",
    name: "qa-recipe",
    description: "Retrieve exact local evidence",
    retrieval: { selection: "records_first", max_results: 5, max_bytes: 2000 },
    prerequisites: ["Original evidence exists"],
    exceptions: ["Not a correctness verdict"],
    compatibility: "marina.memory.retrieval.v1",
    evidence: [],
  };
  const savedRecipe = receipt(
    await check(`memory recipe-save ${JSON.stringify(recipe)}`, /"id"/, ["memory recipe-save "]),
  );
  await check(
    `memory recipe ${savedRecipe.id} ${savedRecipe.version} qa-native-record-271`,
    /qa-native-record-271|evidence/,
    ["memory recipe "],
  );
  const rule = {
    schema: "marina.memory.rule.v1",
    name: "qa-active-status",
    query: {
      patterns: [
        {
          subject: "project:qa",
          predicate: "status",
          object: { kind: "literal", value: "active" },
        },
      ],
    },
    conclusion: {
      subject: "project:qa",
      predicate: "qaEligible",
      object: { kind: "literal", value: true },
    },
  };
  const savedRule = receipt(
    await check(`memory rule-save ${JSON.stringify({ rule })}`, /"id"/, ["memory rule-save "]),
  );
  const input = JSON.stringify({ id: savedRule.id, expected_version: savedRule.version });
  await check(`memory rule-run ${input}`, /qaEligible/, ["memory rule-run "]);
  const derivedOutput = await check(`memory rule-materialize ${input}`, /"records"/, [
    "memory rule-materialize ",
  ]);
  const derived = JSON.parse(derivedOutput.slice(derivedOutput.indexOf("{"))) as {
    records: Array<{ id: string; version: number }>;
  };
  assert(derived.records.length > 0);
  await check(`memory show ${derived.records[0]!.id}`, /qaEligible/, ["memory show "]);
  const recordOutput = await ctx.command("owner", `memory show ${derived.records[0]!.id}`);
  const record = JSON.parse(recordOutput.slice(recordOutput.indexOf("{"))) as {
    dependency_versions: Record<string, number>;
  };
  await check(
    `memory reaffirm ${derived.records[0]!.id} ${derived.records[0]!.version} ${JSON.stringify(record.dependency_versions)}`,
    /"id"|version/,
    ["memory reaffirm "],
  );
  const source = receipt(
    await check(
      `memory api ${JSON.stringify({ operation: "capture", input: { content: "qa-source-range-327 The controlled fixture answer is 437." } })}`,
      /"id"/,
      ["memory api "],
    ),
  );
  await check(`memory source ${source.id} 0 19`, /qa-source-range-327/, ["memory source "]);
  const across = 'memory across {"mounts":["qa-peer"],"query":"qa-native-record-271"}';
  const acrossOutput = await ctx.command("owner", across);
  ctx.record({
    id: "memory:across-prerequisite",
    status: "blocked",
    commands: ["memory across <JSON query>"],
    detail: JSON.stringify({
      input: across,
      output: acrossOutput,
      prerequisite:
        "The fresh server has no configured memory mounts; selecting an explicit alias must fail closed.",
    }),
  });
  // Clear only a disposable participant's KV; the owner retains continuity fixtures.
  await check(
    "memory kv set qa-clear-key disposable",
    /qa-clear-key/,
    ["memory kv set "],
    undefined,
    "worker",
  );
  await check("memory kv clear", /clear|deleted/i, ["memory kv clear"], undefined, "worker");
  await ctx.scenario("memory:kv-cleared", async () => {
    const out = await ctx.command("worker", "memory kv get qa-clear-key");
    assert.doesNotMatch(out, /disposable/);
    return out;
  });
}

/** Two actual client identities carry out the delegation protocol, without an LLM.
 * Autonomous model assistance is a separate scenario. */
export async function exerciseAssistance(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  const storedOutput = await check("memory remember qa-assistance-fact-421", /"id"/, [
    "memory remember ",
  ]);
  const stored = receipt(storedOutput);
  const space = storedOutput.match(/space (\S+)/)![1]!;
  for (const mode of ["answered", "abstained", "cancelled"] as const) {
    const job = receipt(
      await check(
        `memory assist librarian CleanWorker Verify qa-assistance-fact-421 (${mode})`,
        /"id"/,
        ["memory assist "],
      ),
    );
    await check(`memory assistance ${job.id}`, /librarian|qa-assistance-fact/, [
      "memory assistance ",
    ]);
    if (mode === "cancelled") {
      await check(`memory assist-cancel ${job.id}`, /cancelled|"id"/, ["memory assist-cancel "]);
      continue;
    }
    const claimed = await check(
      `memory api ${JSON.stringify({ operation: "assist_claim", id: job.id })}`,
      /lease_token/,
      ["memory api "],
      undefined,
      "worker",
    );
    const lease = (receipt(claimed) as unknown as { lease_token: string }).lease_token;
    assert(lease);
    await check(
      `memory api ${JSON.stringify({ operation: "assist_read", id: job.id, input: { lease_token: lease, request: { operation: "get", id: stored.id } } })}`,
      /qa-assistance-fact-421/,
      ["memory api "],
      undefined,
      "worker",
    );
    const completion =
      mode === "abstained"
        ? {
            status: "abstained",
            reason: "The fixture supplies no evidence for a broader correctness claim.",
          }
        : {
            status: "answered",
            answer: "The explicitly supplied fixture is qa-assistance-fact-421.",
            citations: [
              {
                kind: "record",
                space_id: space,
                id: stored.id,
                version: stored.version,
                quote: "qa-assistance-fact-421",
              },
            ],
          };
    await check(
      `memory api ${JSON.stringify({ operation: "assist_finish", id: job.id, input: { lease_token: lease, completion } })}`,
      new RegExp(mode),
      ["memory api "],
      undefined,
      "worker",
    );
    await check(
      `memory adopt ${job.id}${mode === "abstained" ? " confirm-abstention" : ""}`,
      /adopted|credited|"id"|record/,
      [mode === "abstained" ? "memory adopt <ID> confirm-abstention" : "memory adopt <ID> ["],
    );
  }
}
