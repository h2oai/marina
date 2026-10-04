// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  parseRouteEvidence,
  type RouteEvidence,
  type RoutingTask,
  routingEvidence,
  selectTaskRoute,
} from "../src/coordination/task-routing";
import { WorkBudget } from "../src/coordination/work-budget";
import type { DecisionProvider } from "../src/decisions/types";

const task: RoutingTask = {
  benchmark: "arena",
  item: "future",
  skills: ["verification"],
  asOf: "2026-02-01",
  features: {},
};
const options = [
  { id: "control", fingerprint: "a", description: "control" },
  { id: "layered", fingerprint: "b", description: "layered" },
];
const observation: RouteEvidence = {
  version: 1,
  id: "one",
  benchmark: "arena",
  cohort: "scalar-v1",
  item: "past",
  skills: ["verification"],
  candidate: "b",
  control: "a",
  metric: "crps-skill",
  higherIsBetter: true,
  candidateValue: -10,
  controlValue: -20,
  predictedAt: "2026-01-01",
  availableAt: "2026-01-05",
  status: "completed",
  prospective: true,
};

test("routing preserves native negative scores; cross-benchmark evidence remains a separate hypothesis", () => {
  const summary = routingEvidence(
    task,
    [
      observation,
      {
        ...observation,
        id: "swe",
        benchmark: "swebench",
        cohort: "patches-v1",
        metric: "resolved",
        candidateValue: 1,
        controlValue: 0,
      },
    ],
    options,
  );
  expect(summary).toHaveLength(2);
  expect(summary[0]?.meanImprovement).toBe(10);
  expect(summary[0]?.transferHypothesis).toBe(false);
  expect(summary[1]?.meanImprovement).toBe(1);
  expect(summary[1]?.transferHypothesis).toBe(true);
});

test("rejects future, same-question, retrospective, unrelated and changed-plan priors", () => {
  const excluded = [
    { ...observation, availableAt: task.asOf },
    { ...observation, item: task.item },
    { ...observation, prospective: false },
    { ...observation, skills: ["translation"] },
    { ...observation, candidate: "changed-models" },
  ];
  expect(routingEvidence(task, excluded, options)).toEqual([]);
  expect(() =>
    routingEvidence(task, [observation, { ...observation, id: "duplicate" }], options),
  ).toThrow("duplicate");
  expect(() => parseRouteEvidence([{ ...observation, candidateValue: Number.NaN }])).toThrow();
  expect(() =>
    parseRouteEvidence([{ ...observation, predictedAt: observation.availableAt }]),
  ).toThrow();
});

test("failed trials remain visible and are never assigned invented scores", () => {
  const summaries = routingEvidence(
    task,
    [{ ...observation, status: "failed", candidateValue: undefined }],
    options,
  );
  expect(summaries[0]).toMatchObject({ failed: 1, completed: 0, meanImprovement: null });
});

test("a shared strategy can transfer between adapters without equating their configuration fingerprints", () => {
  const opts = options.map((o) => ({ ...o, strategy: "verify-v1" }));
  const transfer = {
    ...observation,
    benchmark: "swebench",
    candidate: "patch-toolchain-v2",
    strategy: "verify-v1",
    metric: "resolved",
    controlValue: 0,
    candidateValue: 1,
  };
  expect(routingEvidence(task, [transfer], opts)[0]?.transferHypothesis).toBe(true);
  expect(routingEvidence(task, [{ ...transfer, benchmark: "arena" }], opts)).toEqual([]);
  expect(routingEvidence(task, [{ ...transfer, strategy: "changed-policy" }], opts)).toEqual([]);
});

test("lower-is-better metrics retain their native direction", () => {
  const evidence = [
    { ...observation, metric: "crps", higherIsBetter: false, controlValue: 2, candidateValue: 1 },
  ];
  expect(routingEvidence(task, evidence, options)[0]?.meanImprovement).toBe(1);
});

test("selector sees only eligible evidence, cannot invent plans and preserves the control on failure", async () => {
  let chosen = "layered";
  const provider: DecisionProvider = {
    kind: "test",
    model: "classifier",
    ask: async (request) => {
      expect(Object.keys(request.questions)).toEqual(["route"]);
      return {
        answers: { route: { type: "choice", choice: chosen, confidence: 0.99 } },
        model: "classifier",
        provider: "test",
        latencyMs: 1,
      };
    },
  };
  expect((await selectTaskRoute(task, options, "control", [observation], provider)).selected).toBe(
    "layered",
  );
  chosen = "shell-execution";
  const fallback = await selectTaskRoute(task, options, "control", [observation], provider);
  expect(fallback.selected).toBe("control");
  expect(fallback.reason).toContain("ineligible");
  expect((await selectTaskRoute(task, options, "control", [])).selected).toBe("control");
});

test("global admission limits include failed attempts and abort waiting work", async () => {
  const budget = new WorkBudget({ calls: 2, concurrency: 1, timeoutMs: 5000 });
  await expect(
    budget.run(async () => {
      throw new Error("network failed");
    }),
  ).rejects.toThrow("network failed");
  await budget.run(async () => "ok");
  await expect(budget.run(async () => "never")).rejects.toThrow("budget exhausted");
  expect(budget.snapshot().attempted).toBe(2);
  expect(budget.signal.aborted).toBe(true);
});

test("waiting calls are cancelled without dispatch or a leaked admission slot", async () => {
  const budget = new WorkBudget({ calls: 10, concurrency: 1, timeoutMs: 5000 });
  let release!: () => void;
  const first = budget
    .run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .catch((error) => error);
  let dispatched = false;
  const second = budget.run(async () => {
    dispatched = true;
  });
  budget.cancel(new Error("cancelled"));
  await expect(second).rejects.toThrow("cancelled");
  expect((await first).message).toBe("cancelled");
  expect(budget.snapshot().active).toBe(1);
  release();
  await Promise.resolve();
  expect(dispatched).toBe(false);
  expect(budget.snapshot()).toMatchObject({ attempted: 1, active: 0 });
});
