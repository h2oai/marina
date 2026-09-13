// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MemoryRule } from "../../src/sdk/memory-symbolic";
import { createLiveMemoryRuntime, type LiveResult } from "./memory-live-runtime";
import { snapshotMemoryQualification } from "./memory-qualification-sources";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { directory: { type: "string" }, "budget-usd": { type: "string" } },
});
if (!values.directory)
  throw new Error("Supply --directory outside the public repository and --budget-usd");
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sources = snapshotMemoryQualification(directory),
  runtime = createLiveMemoryRuntime(directory, Number(values["budget-usd"]));
const rows: {
  scenario: string;
  phase: string;
  correct: boolean;
  operations: boolean;
  result: LiveResult;
}[] = [];
const publish = () =>
  writeFileSync(
    `${directory}/report.json`,
    JSON.stringify(
      {
        schema: "marina.memory.handoff.v1",
        complete: rows.length === 7,
        passed:
          rows.length === 7 &&
          rows.every((r) => r.correct && r.operations) &&
          new Set(rows.map((r) => r.result.pid)).size === rows.length,
        rows,
        sources,
        spending: runtime.spending,
        limits:
          "Two controlled workflows, three fresh agent handoffs each and one no-memory control. This does not establish multi-day autonomous work quality.",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
try {
  for (const scenario of ["release", "editorial"]) {
    const space = (await runtime.client.createSpace(scenario)).id;
    const source = await runtime.client.capture(
      space,
      `${scenario} source: Ada owns item:one; Grace owns item:two. item:one is approved; item:two is pending. Status claims may be corrected. An eligible owner owns an approved item.`,
    );
    const ownerIds = [];
    for (const [person, target] of [
      ["person:ada", "item:one"],
      ["person:grace", "item:two"],
    ])
      ownerIds.push(
        await runtime.client.remember(space, {
          content: `${person} owns ${target}`,
          source_ids: [source.id],
          claim: { subject: person!, predicate: "owns", object: { kind: "entity", id: target! } },
        }),
      );
    const statuses = [];
    for (const [target, status] of [
      ["item:one", "approved"],
      ["item:two", "pending"],
    ])
      statuses.push(
        await runtime.client.remember(space, {
          content: `${target} status ${status}`,
          source_ids: [source.id],
          claim: {
            subject: target!,
            predicate: "status",
            object: { kind: "literal", value: status! },
          },
        }),
      );
    const person = { variable: "person", type: "entity" as const },
      target = { variable: "item", type: "entity" as const };
    const rule: MemoryRule = {
      schema: "marina.memory.rule.v1",
      name: `${scenario} eligibility`,
      query: {
        patterns: [
          { subject: person, predicate: "owns", object: target },
          { subject: target, predicate: "status", object: { kind: "literal", value: "approved" } },
        ],
      },
      conclusion: { subject: person, predicate: "eligibleFor", object: target },
    };
    const saved = await runtime.client.saveRule(space, rule, { source_ids: [source.id] });
    const request = {
      task: `Continue the ${scenario} review using only the durable Marina service. Read rule ${saved.id} at its current version, execute it with run_rule, explicitly materialize its current conclusions, and read the created inference records. Do not reaffirm stale conclusions. Save checkpoint ${scenario}-handoff with the current eligible owner IDs in data.eligible. Read an existing checkpoint first; use its version, or expected_version 0 if missing. Finish with {eligible:[owner entity IDs sorted]}. Cite current evidence.`,
      contract: {
        schema: {
          type: "object" as const,
          properties: { eligible: { type: "array" as const, items: { type: "string" as const } } },
          required: ["eligible"],
          additionalProperties: false as const,
        },
        evidence: "required" as const,
      },
      instructions:
        "get uses id (omit input.version for current). run_rule/materialize_rule use input {id:RULE_ID,expected_version:CURRENT_RULE_VERSION}. checkpoint uses id=checkpoint name. save_checkpoint uses id=name and input {expected_version,data:{eligible:[...]}}. A materialize receipt lists records; get reads each receipt id. Query includes current assertions by default; stale conclusions are excluded.",
      operations: [
        "get",
        "run_rule",
        "materialize_rule",
        "checkpoint",
        "save_checkpoint",
        "query",
        "source_range",
        "review",
      ] as const,
      maxTurns: 24,
    };
    if (scenario === "release") {
      const result = await runtime.run(
        {
          ...request,
          operations: [...request.operations],
          contract: { ...request.contract, evidence: "optional" },
        },
        space,
        "none",
      );
      rows.push({
        scenario,
        phase: "no-memory",
        correct: result.status === "abstained",
        operations: true,
        result,
      });
      publish();
    }
    for (const phase of ["initial", "premise-correction", "rule-correction"]) {
      if (phase === "premise-correction") {
        const correction = await runtime.client.capture(
          space,
          `${scenario} correction: item:one is blocked; item:two is approved.`,
        );
        for (const [i, status] of ["blocked", "approved"].entries())
          await runtime.client.revise(space, statuses[i]!.id, 1, {
            content: `item:${i === 0 ? "one" : "two"} status ${status}`,
            source_ids: [correction.id],
            claim: {
              subject: `item:${i === 0 ? "one" : "two"}`,
              predicate: "status",
              object: { kind: "literal", value: status },
            },
          });
      }
      if (phase === "rule-correction") {
        const correction = await runtime.client.capture(
          space,
          `${scenario} review queue now selects blocked items; prior eligibleFor conclusions require review.`,
        );
        await runtime.client.saveRule(
          space,
          {
            ...rule,
            query: {
              patterns: [
                rule.query.patterns[0]!,
                {
                  subject: target,
                  predicate: "status",
                  object: { kind: "literal", value: "blocked" },
                },
              ],
            },
          },
          { id: saved.id, expected_version: 1, source_ids: [correction.id] },
        );
      }
      const result = await runtime.run({ ...request, operations: [...request.operations] }, space);
      const expected = phase === "premise-correction" ? ["person:grace"] : ["person:ada"];
      const answer =
        result.completion?.status === "answered"
          ? (result.completion.answer as { eligible?: unknown })
          : null;
      let checkpoint: unknown;
      try {
        checkpoint = (await runtime.client.checkpoint(space, `${scenario}-handoff`)).data.eligible;
      } catch {
        checkpoint = null;
      }
      const exercised = ["get", "run_rule", "materialize_rule", "save_checkpoint"].every((op) =>
        result.trace.some((t) => t.request.operation === op),
      );
      rows.push({
        scenario,
        phase,
        correct:
          JSON.stringify(answer?.eligible) === JSON.stringify(expected) &&
          JSON.stringify(checkpoint) === JSON.stringify(expected),
        operations: exercised,
        result,
      });
      publish();
    }
  }
} finally {
  publish();
  await runtime.close();
}
const passed = rows.length === 7 && rows.every((r) => r.correct && r.operations);
console.log(JSON.stringify({ passed, phases: rows.length }));
if (!passed) process.exitCode = 1;
