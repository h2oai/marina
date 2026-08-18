// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export type TaskNodeType = "bundle" | "action" | "decide" | "gate" | "agent" | "leaf";

const MARKER_RE = /^\s*\[(bundle|action|decide|gate|agent)\]\s*/i;

export function parseTaskNodeType(title: string): TaskNodeType {
  const match = title.match(MARKER_RE);
  if (!match?.[1]) return "leaf";
  return match[1].toLowerCase() as TaskNodeType;
}

export const TASK_NODE_TYPE_MEANING: Record<Exclude<TaskNodeType, "leaf">, string> = {
  bundle: "container for child tasks; never claim directly",
  action: "deterministic command or skill execution",
  decide: "LLM judgment or classification step",
  gate: "approval gate before downstream work proceeds",
  agent: "open-loop, agent-driven exploration",
};
