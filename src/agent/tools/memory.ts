// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `memory` — the platform (legacy notes) memory tool over
// `PlatformMemoryBackend`; resident in every profile.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { PlatformMemoryBackend } from "../memory-platform";

// ─── Memory Tool (platform-only) ───────────────────────────────────────────

const memorySchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("write"),
      Type.Literal("search"),
      Type.Literal("reflect"),
      Type.Literal("orient"),
      Type.Literal("skill_store"),
      Type.Literal("skill_search"),
    ],
    { description: "write, search, reflect, orient, skill_store, skill_search" },
  ),
  content: Type.Optional(Type.String({ description: "Content (for write/reflect)" })),
  query: Type.Optional(Type.String({ description: "Search query (for search/skill_search)" })),
  trusted: Type.Optional(
    Type.Boolean({
      description:
        "Strict (for search): returns only verified or high-confidence sourced notes; empty when none qualify. Omit trusted to include unverified notes.",
    }),
  ),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal("observation"),
        Type.Literal("inference"),
        Type.Literal("decision"),
        Type.Literal("fact"),
        Type.Literal("principle"),
        Type.Literal("episode"),
      ],
      { description: "Note type (for write)" },
    ),
  ),
  importance: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description: "Importance level (for write)",
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (for write)" })),
  skill_name: Type.Optional(Type.String({ description: "Skill name (for skill_store)" })),
  skill_description: Type.Optional(
    Type.String({ description: "Skill description (for skill_store)" }),
  ),
  skill_actions: Type.Optional(Type.String({ description: "Skill actions (for skill_store)" })),
});

export function createMemoryTool(
  platformMemory: PlatformMemoryBackend,
): AgentTool<typeof memorySchema> {
  return {
    name: "memory",
    label: "Platform Memory",
    description:
      "Platform memory — all data persists on the server across sessions.\n" +
      "Actions: write (save note), search (recall), reflect (synthesize), orient (health), " +
      "skill_store (save skill), skill_search (find skills).\n" +
      "Use trusted=true for decisions. For provenance use marina_command: note claim/source/derive/verify/explain.",
    parameters: memorySchema,
    execute: async (_id, params: Static<typeof memorySchema>) => {
      try {
        switch (params.action) {
          case "write": {
            if (!params.content) {
              return {
                content: [{ type: "text", text: "Error: content required for write" }],
                details: { success: false },
              };
            }
            const r = await platformMemory.write(
              params.category ?? "observation",
              params.content,
              params.importance ?? "medium",
              params.tags ?? [],
            );
            return {
              content: [
                {
                  type: "text",
                  text: r.noteId
                    ? `Note #${r.noteId} | ${params.category ?? "observation"} | ${params.content.slice(0, 80)}`
                    : r.text,
                },
              ],
              details: { success: r.success, noteId: r.noteId },
            };
          }

          case "search": {
            if (!params.query) {
              return {
                content: [{ type: "text", text: "Error: query required for search" }],
                details: { success: false },
              };
            }
            const r = await platformMemory.search(params.query, { trusted: params.trusted });
            if (!r.results || r.results.length === 0) {
              return {
                content: [{ type: "text", text: `No notes found for "${params.query}"` }],
                details: { success: true, count: 0 },
              };
            }
            const lines = r.results
              .slice(0, 10)
              .map(
                (n) =>
                  `#${n.id} [imp=${n.importance} score=${n.score?.toFixed(2) ?? "?"}]: ${n.content}`,
              );
            return {
              content: [
                { type: "text", text: `Found ${r.results.length} notes:\n${lines.join("\n")}` },
              ],
              details: { success: true, count: r.results.length },
            };
          }

          case "reflect": {
            const r = await platformMemory.reflect(params.content);
            return {
              content: [
                {
                  type: "text",
                  text: `Reflection created${r.noteId ? ` (Note #${r.noteId})` : ""}\n${r.text.slice(0, 200)}`,
                },
              ],
              details: { success: r.success, noteId: r.noteId },
            };
          }

          case "orient": {
            const r = await platformMemory.orient();
            return {
              content: [{ type: "text", text: r.text }],
              details: { success: r.success },
            };
          }

          case "skill_store": {
            if (!params.skill_name || !params.skill_description || !params.skill_actions) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: skill_name, skill_description, skill_actions all required",
                  },
                ],
                details: { success: false },
              };
            }
            const r = await platformMemory.storeSkill(
              params.skill_name,
              params.skill_description,
              params.skill_actions,
            );
            return {
              content: [
                {
                  type: "text",
                  text: r.noteId
                    ? `Skill #${r.noteId}: ${params.skill_name}`
                    : `Skill stored: ${params.skill_name}`,
                },
              ],
              details: { success: r.success, noteId: r.noteId },
            };
          }

          case "skill_search": {
            if (!params.query) {
              return {
                content: [{ type: "text", text: "Error: query required for skill_search" }],
                details: { success: false },
              };
            }
            const r = await platformMemory.searchSkills(params.query);
            if (!r.results || r.results.length === 0) {
              return {
                content: [{ type: "text", text: `No skills found for "${params.query}"` }],
                details: { success: true, count: 0 },
              };
            }
            const lines = r.results
              .slice(0, 5)
              .map(
                (s) =>
                  `#${s.id} [imp=${s.importance} score=${s.score?.toFixed(2) ?? "?"}]: ${s.content}`,
              );
            return {
              content: [
                { type: "text", text: `Found ${r.results.length} skills:\n${lines.join("\n")}` },
              ],
              details: { success: true, count: r.results.length },
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${params.action}` }],
              details: { success: false },
            };
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Memory operation failed: ${msg}` }],
          details: { success: false, error: msg },
        };
      }
    },
  };
}
