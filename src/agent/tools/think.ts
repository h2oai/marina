// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `think` — zero-side-effect structured reasoning; resident in every profile.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

// ─── Think Tool (zero side effects) ────────────────────────────────────────

const thinkSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("plan"),
      Type.Literal("analyze"),
      Type.Literal("reflect"),
      Type.Literal("hypothesize"),
    ],
    { description: "Type of reasoning: plan, analyze, reflect, hypothesize" },
  ),
  thought: Type.String({ description: "Your detailed reasoning." }),
  steps: Type.Optional(Type.Array(Type.String(), { description: "Action steps (for plan)" })),
  subject: Type.Optional(Type.String({ description: "Topic being analyzed" })),
  conclusion: Type.Optional(Type.String({ description: "Key takeaway or decision" })),
});

export function createThinkTool(): AgentTool<typeof thinkSchema> {
  return {
    name: "think",
    label: "Structured Reasoning",
    description:
      "Zero-side-effect reasoning tool. Use to think deeply before acting on complex problems. " +
      "Does NOT execute commands. Actions: plan (multi-step), analyze (deep-dive), reflect (evaluate), hypothesize (theory).",
    parameters: thinkSchema,
    execute: async (_id, params: Static<typeof thinkSchema>) => {
      const { action, thought, steps, subject, conclusion } = params;
      const sep = "\u2500".repeat(50);
      const label = action.toUpperCase();
      const parts = [sep, `${label}${subject ? `: ${subject}` : ""}`, sep, "", thought];

      if (steps && steps.length > 0) {
        parts.push("", "Steps:", ...steps.map((s, i) => `  ${i + 1}. ${s}`));
      }
      if (conclusion) parts.push("", `Conclusion: ${conclusion}`);
      parts.push("", sep);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { action, subject, stepCount: steps?.length ?? 0 },
      };
    },
  };
}
