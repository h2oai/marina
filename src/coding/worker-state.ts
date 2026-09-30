// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentHandle } from "../agent/agent-types";
import { type AgentPauseState, operatorStatusOf } from "../agent/lean-agent-adapter";

/** An observation of the existing worker, not a task transition or a second pause policy. */
export interface CodingWorkerState {
  workerState:
    | "working"
    | "waiting"
    | "paused"
    | "recovering"
    | "unavailable"
    | "stopped"
    | "unknown";
  workerReason?: string;
  workerPauseKind?: AgentPauseState["kind"];
  workerObservedAt: number;
  workerModelCalls?: number;
  workerBudgetCalls?: number;
}

export function codingWorkerState(handle: AgentHandle | undefined): CodingWorkerState {
  const observed: CodingWorkerState = { workerState: "unknown", workerObservedAt: Date.now() };
  if (!handle)
    return {
      ...observed,
      workerState: "unavailable",
      workerReason: "Worker is unavailable. Inspect the attempt before stopping or retrying.",
    };
  const status = handle.getStatus();
  observed.workerModelCalls = status.modelCalls;
  observed.workerBudgetCalls = status.budgetCalls;
  if (["stopped", "stopping"].includes(status.state))
    return {
      ...observed,
      workerState: "stopped",
      workerReason: status.errorReason ?? `Worker ${status.state}.`,
    };
  const pause = operatorStatusOf(handle)?.paused;
  if (pause)
    return {
      ...observed,
      workerState: pause.kind === "upstream-errors" ? "recovering" : "paused",
      workerReason: pause.reason,
      workerPauseKind: pause.kind,
    };
  if (status.budgetExhausted)
    return {
      ...observed,
      workerState: "paused",
      workerPauseKind: "budget",
      workerReason:
        "Model-call budget exhausted. Inspect agent status; this task has not completed.",
    };
  if (status.state === "error")
    return {
      ...observed,
      workerState: "unavailable",
      workerReason: status.errorReason ?? "Worker reported an error. Inspect agent status.",
    };
  if (status.healthState === "busy") return { ...observed, workerState: "working" };
  if (status.healthState === "recovering")
    return {
      ...observed,
      workerState: "recovering",
      workerReason: status.diagnosis ?? "Worker is recovering.",
    };
  if (status.healthState === "degraded")
    return {
      ...observed,
      workerState: "waiting",
      workerReason: status.diagnosis ?? "Worker needs attention. Inspect agent status.",
    };
  if (status.state === "starting")
    return { ...observed, workerState: "waiting", workerReason: "Worker is starting." };
  if (
    status.healthState === "waiting" ||
    status.healthState === "ready" ||
    status.state === "idle" ||
    status.state === "connected"
  )
    return {
      ...observed,
      workerState: "waiting",
      workerReason: status.diagnosis ?? "Waiting for the worker's next turn.",
    };
  return observed;
}
