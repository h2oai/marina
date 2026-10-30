// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type CompletionContract,
  evaluateCompletionPhase,
  qualifyTaskCompletion,
  validateCompletionContract,
} from "../benchmarks/task-completion";

const inputSchema = z.strictObject({
  planned: z.array(
    z.strictObject({ id: z.string(), caseId: z.string(), phases: z.array(z.number().int()) }),
  ),
  contracts: z.array(z.unknown()),
  attempts: z.array(
    z.strictObject({
      id: z.string(),
      evidence: z.strictObject({
        firstAttempt: z.boolean(),
        freshDatabase: z.boolean(),
        sourceIntegrity: z.boolean(),
        restart: z.boolean(),
        handoff: z.boolean(),
        executionComplete: z.boolean(),
      }),
      phases: z.array(
        z.strictObject({
          caseId: z.string(),
          phase: z.number().int(),
          submission: z.unknown().optional(),
          journal: z.string().optional(),
          review: z
            .strictObject({
              status: z.enum(["passed", "failed", "pending"]),
              findings: z.array(z.string()),
            })
            .optional(),
        }),
      ),
    }),
  ),
});

export function scoreTaskCompletionInput(raw: unknown) {
  const input = inputSchema.parse(raw);
  const contracts = input.contracts as CompletionContract[];
  const keys = new Set<string>();
  for (const contract of contracts) {
    validateCompletionContract(contract);
    const key = JSON.stringify([contract.caseId, contract.phase]);
    if (keys.has(key)) throw new Error(`Duplicate phase contract: ${key}`);
    keys.add(key);
  }
  for (const plan of input.planned)
    for (const phase of plan.phases)
      if (!keys.has(JSON.stringify([plan.caseId, phase])))
        throw new Error(`Missing planned contract: ${plan.caseId}/${phase}`);
  const attempts = input.attempts.map((attempt) => ({
    ...attempt,
    phases: attempt.phases.map((phase) => {
      const contract = contracts.find((c) => c.caseId === phase.caseId && c.phase === phase.phase);
      if (!contract) throw new Error(`Unknown phase contract: ${phase.caseId}/${phase.phase}`);
      return {
        ...evaluateCompletionPhase(contract, phase.submission, phase.journal),
        review: phase.review,
      };
    }),
  }));
  return { ...qualifyTaskCompletion(input.planned, attempts), attempts };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      input: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.input || !values.output)
    throw new Error("Usage: bun run qualify:tasks --input audited-input.json --output report.json");
  const report = scoreTaskCompletionInput(JSON.parse(readFileSync(values.input, "utf8")));
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      qualified: report.qualified,
      runsPassed: report.runsPassed,
      runsPlanned: report.runsPlanned,
      phasesPassed: report.phasesPassed,
      phasesPlanned: report.phasesPlanned,
    }),
  );
  process.exitCode = report.qualified ? 0 : 1;
}
