// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
  type ExperimentAttempt,
  qualifyResearchExperiments,
  type ResearchExperiment,
  runResearchArm,
  scoreResearchExperiment,
  validateExperiment,
} from "../src/arena/research-experiment";
import { evidenceHash } from "../src/research/evidence";

function fixture(): ResearchExperiment {
  const round = {
    round_id: "civiqs-test-econ-now",
    tracker: "civiqs",
    series: "civiqs_net_econ_now",
    target_type: "continuous_normal" as const,
    question: "Economic sentiment?",
    unit: "points",
    lock_at: "2026-10-14T14:00:00Z",
    release_at: "2026-10-16T14:00:00Z",
  };
  const lock = {
    round_id: round.round_id,
    history: [
      { date: "2026-10-05", value: 10 },
      { date: "2026-10-06", value: 11 },
    ],
  };
  const start = {
    note: "fixture",
    topline: { mean: 11, sd: 1 },
    rules: {},
    origins: {
      [round.series]: {
        selected: "daily" as const,
        targetDate: "2026-10-16",
        horizonDays: 10,
        mode: "off" as const,
        reason: "fixture",
        start: { mean: 11, sd: 1 },
        reading: { date: "2026-10-06", value: 11 },
      },
    },
  };
  const input = {
    version: 1 as const,
    round,
    lock,
    capturedAt: "2026-10-07T12:00:00Z",
    starts: { control: start, projected: { ...start, topline: { mean: 11.2, sd: 1 } } },
    dossiers: {
      control: { since: "2026-10-06", verified: "CONTROL", sources: 1, costUsd: 0 },
      research: { since: "2026-10-06", verified: "RESEARCH", sources: 2, costUsd: 0.2 },
    },
    lessons: [],
    calibration: [],
    settings: {
      arms: ["A", "B", "C", "D"] as ResearchExperiment["settings"]["arms"],
      models: ["mock/one", "mock/two"],
      maxTokens: 1000,
      callsPerArm: 32,
      timeoutMs: 1000,
      retriever: "fixture",
      researchRounds: 1,
      controlHorizon: { mode: "off" },
      projectedHorizon: { mode: "drift" },
      captureCostUsd: 0.2,
    },
  };
  return { ...input, hash: evidenceHash(input) } as ResearchExperiment;
}
const now = () => new Date("2026-10-07T13:00:00Z");

test("factorial arms use the registered start/evidence combination", async () => {
  const input = fixture();
  for (const arm of ["A", "B", "C", "D"] as const) {
    const prompts: string[] = [];
    const backend = {
      usage: { calls: 0, costUsd: 0 },
      complete: async (_m: string, _s: string, u: string) => {
        prompts.push(u);
        backend.usage.calls++;
        backend.usage.costUsd += 0.01;
        return '{"mean":11.1,"sd":1,"reason":"history"}';
      },
    };
    const attempt = await runResearchArm(input, arm, backend, { now });
    expect(attempt.status).toBe("complete");
    expect(
      prompts.every((p) => p.includes(arm === "A" || arm === "B" ? "CONTROL" : "RESEARCH")),
    ).toBe(true);
    const detail = attempt.detail as { inputs: { start: { topline: { mean: number } } } };
    expect(detail.inputs.start.topline.mean).toBe(arm === "A" || arm === "C" ? 11 : 11.2);
    expect(attempt.calls).toBe(4);
  }
  validateExperiment(input);
});

test("hash tampering and stale inputs stop before paid work", () => {
  const bad = fixture();
  bad.starts.control.topline!.mean = 99;
  expect(() => validateExperiment(bad)).toThrow("hash mismatch");
  const stale = fixture();
  stale.capturedAt = "2026-10-13T00:00:00Z";
  const { hash: _hash, ...value } = stale;
  stale.hash = evidenceHash(value);
  expect(() => validateExperiment(stale)).toThrow("stale");
});

test("failure is checkpointed before calls and cannot masquerade as a control fallback", async () => {
  let checkpoint = false;
  const attempt = await runResearchArm(
    fixture(),
    "C",
    {
      usage: { calls: 0, costUsd: 0 },
      complete: async () => {
        expect(checkpoint).toBe(true);
        throw new Error("outage");
      },
    },
    {
      now,
      onStart: async (a) => {
        expect(a.status).toBe("failed");
        checkpoint = true;
      },
    },
  );
  expect(attempt.status).toBe("failed");
});

test("scoring retains missing arms and counts only genuinely later outcomes", () => {
  const input = fixture();
  const attempt: ExperimentAttempt = {
    inputHash: input.hash,
    arm: "A",
    startedAt: now().toISOString(),
    completedAt: now().toISOString(),
    status: "complete",
    forecast: { mean: 11, sd: 1 },
    raw: { mean: 11, sd: 1 },
    costUsd: 0.1,
    calls: 4,
  };
  const scored = scoreResearchExperiment(
    input,
    [attempt],
    { value: 11.3, resolved_at: "2026-10-16T14:00:00Z" },
    "2026-10-17T00:00:00Z",
  );
  expect(scored.scores).toHaveLength(4);
  expect(scored.scores[0]!.status).toBe("resolved");
  expect(scored.scores.slice(1).every((s) => s.status === "invalid")).toBe(true);
  expect(scored.calibrationObservations).toHaveLength(1);
  const pending = scoreResearchExperiment(
    input,
    [attempt],
    { value: 11.3, resolved_at: "2026-10-16T14:00:00Z" },
    "2026-10-15T00:00:00Z",
  );
  expect(pending.scores[0]!.status).toBe("pending");
  const leaked = scoreResearchExperiment(
    input,
    [attempt],
    { value: 11.3, resolved_at: "2026-10-07T12:00:00Z" },
    "2026-10-17T00:00:00Z",
  );
  expect(leaked.scores[0]!.status).toBe("invalid");
  // Older runners called degraded ensembles complete; scoring still rejects their traces.
  const degraded = scoreResearchExperiment(
    input,
    [
      {
        ...attempt,
        detail: {
          nodes: { control: { forecast: { rounds: [{ status: "error: provider credits" }] } } },
        },
      },
    ],
    {},
    now().toISOString(),
  );
  expect(degraded.scores.every((s) => s.status === "invalid")).toBe(true);
});

test("one surviving panelist cannot qualify a degraded experiment", async () => {
  const input = fixture();
  const attempt = await runResearchArm(
    input,
    "A",
    {
      usage: { calls: 0, costUsd: 0 },
      complete: async (model) => {
        if (model === "mock/two") throw new Error("402 provider credits");
        return '{"mean":11.1,"sd":1,"reason":"history"}';
      },
    },
    { now },
  );
  expect(attempt.status).toBe("failed");
  expect(attempt.error).toContain("failed or invalid");
  expect(attempt.detail).toBeDefined();
  expect(JSON.stringify(attempt.detail)).toContain("402 provider credits");
  await expect(
    runResearchArm(
      input,
      "L",
      {
        usage: { calls: 0, costUsd: 0 },
        complete: async () => {
          throw new Error("must not call");
        },
      },
      { now },
    ),
  ).rejects.toThrow("not registered");
});

test("qualification holds out entire waves and cannot ignore a failed attempt", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    roundId: `r${i}`,
    series: "econ",
    cohort: "c",
    arm: "C" as const,
    lockAt: `2026-10-${String(7 + Math.floor(i / 4) * 7).padStart(2, "0")}T12:00:00Z`,
    status: "resolved" as const,
    gain: 0.05,
  }));
  expect(qualifyResearchExperiments(rows)[0]!.status).toBe("eligible-for-review");
  expect(qualifyResearchExperiments(rows.slice(0, 3))[0]!.status).toBe("retain-current-strategy");
  expect(
    qualifyResearchExperiments([...rows, { ...rows[0]!, roundId: "failed", status: "invalid" }])[0]!
      .status,
  ).toBe("retain-current-strategy");
  expect(() => qualifyResearchExperiments([...rows, rows[0]!])).toThrow("duplicate");
});
