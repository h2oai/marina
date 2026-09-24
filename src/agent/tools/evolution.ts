// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `marina_evolve` — typed convenience over the `evolve` world command for an
// already-active native evolution protocol (attached by the adapter, not part
// of any profile set).

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { execCommand, type ToolContext } from "./shared";

const evolutionToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("analyze"),
    Type.Literal("propose"),
    Type.Literal("evaluate"),
    Type.Literal("decide"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("complete"),
  ]),
  experiment: Type.String({ description: "Existing experiment name" }),
  hypothesis: Type.Optional(Type.String()),
  candidateRef: Type.Optional(Type.String()),
  parentRunId: Type.Optional(Type.Integer({ minimum: 1 })),
  runId: Type.Optional(Type.Integer({ minimum: 1 })),
  evidence: Type.Optional(Type.String()),
  decision: Type.Optional(
    Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("inconclusive")]),
  ),
});

/** Typed convenience for an already-active native evolution protocol. Every
 * action maps to the same world command available to humans and external agents. */
export function createEvolutionTool(ctx: ToolContext): AgentTool<typeof evolutionToolSchema> {
  return {
    name: "marina_evolve",
    label: "Evolution Protocol",
    description:
      "Inspect or contribute to an active native evolution protocol. Records evidence and decisions only; cannot execute, activate, or promote a candidate.",
    parameters: evolutionToolSchema,
    execute: async (_id, params, signal) => {
      const experiment = evolutionToolParam(params.experiment, "experiment");
      let command: string;
      if (["status", "analyze", "pause", "resume", "complete"].includes(params.action)) {
        command = `evolve ${params.action} ${experiment}`;
      } else if (params.action === "propose") {
        const hypothesis = evolutionToolParam(params.hypothesis, "hypothesis");
        const candidate = evolutionToolParam(params.candidateRef, "candidateRef");
        command = `evolve propose ${experiment} | ${hypothesis} | ${candidate}`;
        if (params.parentRunId) command += ` | parent=${params.parentRunId}`;
      } else if (params.action === "evaluate") {
        if (!params.runId) throw new Error("runId is required for evaluate");
        command = `evolve evaluate ${experiment} ${params.runId} | ${evolutionToolParam(params.evidence, "evidence")}`;
      } else {
        if (!params.runId || !params.decision) {
          throw new Error("runId and decision are required for decide");
        }
        command = `evolve decide ${experiment} ${params.runId} ${params.decision}`;
      }
      return execCommand(ctx, command, signal);
    },
  };
}

function evolutionToolParam(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  if (/[\r\n|]/.test(trimmed)) throw new Error(`${name} must be a single value without pipes`);
  return trimmed;
}
