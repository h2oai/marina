// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Tool profiles: `createAllTools`, the profile name lists, the resident /
// deferred split with the `marina_tool_search` loader, execution-mode
// stamping (`applyToolExecutionModes`), strict-schema opt-in
// (`applyStrictToolSchemas`) and `createProfileToolset` / `createScopedTools`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentSupports } from "../agent-types";
import type { PlatformMemoryBackend } from "../memory-platform";
import { createCommandTool } from "./command";
import { createMediaTools } from "./media";
import { createMemoryTool } from "./memory";
import { createMemoryAssistanceTool } from "./memory-assistance";
import { createMemoryServiceTool } from "./memory-service";
import type { ToolContext } from "./shared";
import { createThinkTool } from "./think";
import { createWorldTools } from "./world";

// ─── All Tools ──────────────────────────────────────────────────────────────

export function createAllTools(
  ctx: ToolContext,
  platformMemory: PlatformMemoryBackend,
  _rosterMode: "compact" | "verbose" = "verbose",
): AgentTool[] {
  // AgentTool generic variance requires cast when combining different schema types
  return [
    createCommandTool(ctx) as unknown as AgentTool,
    ...createWorldTools(ctx),
    ...createMediaTools(ctx),
    createThinkTool() as unknown as AgentTool,
    createMemoryTool(platformMemory) as unknown as AgentTool,
    createMemoryServiceTool(ctx) as unknown as AgentTool,
    createMemoryAssistanceTool(ctx) as unknown as AgentTool,
  ];
}

/**
 * Tool profile — choose how much tool schema to send to the LLM.
 *
 * Smaller profiles reduce repeated schema input. `marina_command` retains
 * access to world commands in every profile.
 *
 * Profiles:
 *  - `"full"`    : Every typed tool. By default the CORE set below is resident
 *                  and the rest are DEFERRED — listed one line each inside
 *                  `marina_tool_search`, loaded by name for the rest of the
 *                  session (`MARINA_DEFERRED_TOOLS=off` restores all-resident).
 *  - `"crew"`    : the core set — command, code, tell, pool, brief, channel,
 *                  think, memory, memory service. Mid-tier for dispatchers.
 *  - `"minimal"` : command, think, memory, memory service. Functionally
 *                  complete via `command`; for Haiku-tier one-shot specialists.
 *
 * An agent config's `toolProfile` field selects; defaults to `"full"`.
 */
export type ToolProfile = "full" | "crew" | "minimal";

/**
 * Tool-name sets for each profile. Kept here so `worlds/seed.ts` and
 * future roles can reference by name instead of guessing.
 */
export const TOOL_PROFILE_NAMES: Record<ToolProfile, string[]> = {
  full: [], // empty = all tools (resident core + deferred rest)
  crew: [
    "marina_command",
    "marina_code",
    "marina_tell",
    "marina_pool",
    "marina_brief",
    "marina_channel",
    "think",
    "memory",
    "marina_memory_service",
  ],
  minimal: ["marina_command", "think", "memory", "marina_memory_service"],
};

/** Resident (always-sent) tools of the `full` profile when deferral is on —
 *  the crew core set. Everything else loads on demand. */
export const FULL_RESIDENT_TOOL_NAMES: readonly string[] = [...TOOL_PROFILE_NAMES.crew];

export const TOOL_SEARCH_NAME = "marina_tool_search";

/** `MARINA_DEFERRED_TOOLS=off` restores the pre-2026-09 all-schemas `full` profile. */
export function deferredToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARINA_DEFERRED_TOOLS ?? "").trim().toLowerCase() !== "off";
}

/** First sentence of a tool description, flattened and clamped — the catalog line. */
function toolCatalogLine(description: string, max = 64): string {
  const first = description.split(/(?<=[.!?])\s|\n/)[0] ?? description;
  const flat = first.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const toolSearchSchema = Type.Object({
  names: Type.Optional(Type.Array(Type.String(), { description: "Exact tool names to load" })),
  query: Type.Optional(
    Type.String({
      description: "Keyword matched against names/descriptions when unsure of the name",
    }),
  ),
});

/**
 * Load-on-demand tool loader (client-side deferred tools). pi-ai's native
 * deferred mode is Kimi-specific wire format, unusable through the generic
 * OpenAI-completions self-proxy, so Marina loads schemas itself: the
 * description carries the catalog (`name — one line`), a call resolves the
 * requested tools, hands them to `onLoad` (the adapter registers them for the
 * rest of the session), and the result names them via `addedToolNames`.
 */
export function createToolSearchTool(
  deferred: readonly AgentTool[],
  onLoad?: (tools: AgentTool[]) => void,
): AgentTool<typeof toolSearchSchema> {
  const catalog = deferred.map((t) => `${t.name} — ${toolCatalogLine(t.description)}`).join("\n");
  return {
    name: TOOL_SEARCH_NAME,
    label: "Load Tools",
    description: `Load typed tools not yet in your tool list; once loaded they stay callable for this session. Pass exact names (or a keyword query). Every world command also works through marina_command without loading anything.\nAvailable:\n${catalog}`,
    parameters: toolSearchSchema,
    execute: async (_id, params: Static<typeof toolSearchSchema>) => {
      const wanted = new Set((params.names ?? []).map((n) => n.trim()).filter(Boolean));
      const q = params.query?.trim().toLowerCase() ?? "";
      const byName = deferred.filter((t) => wanted.has(t.name));
      const byQuery =
        q.length > 0
          ? deferred
              .filter(
                (t) =>
                  !wanted.has(t.name) &&
                  (t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
              )
              .slice(0, 5)
          : [];
      const matches = [...byName, ...byQuery];
      const unknown = [...wanted].filter((n) => !deferred.some((t) => t.name === n));
      if (matches.length === 0) {
        throw new Error(
          `No deferred tool matched${unknown.length > 0 ? ` (unknown: ${unknown.join(", ")})` : ""}. Available:\n${catalog}`,
        );
      }
      onLoad?.(matches);
      const lines = matches.map((t) => `${t.name}: ${t.description}`);
      const tail = unknown.length > 0 ? `\nUnknown: ${unknown.join(", ")}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Loaded ${matches.length} tool(s) — call them directly now:\n${lines.join("\n")}${tail}`,
          },
        ],
        details: { loaded: matches.map((t) => t.name), unknown },
        addedToolNames: matches.map((t) => t.name),
      };
    },
  };
}

export interface ProfileToolset {
  /** Schemas sent on every request. */
  resident: AgentTool[];
  /** Loadable through `marina_tool_search`; empty when deferral is off or the profile is not `full`. */
  deferred: AgentTool[];
}

// ─── Tool execution ordering ────────────────────────────────────────────────
//
// pi-agent-core runs a multi-tool assistant turn in parallel by default. World
// mutations are order-sensitive (a `say` after a `move` must land in the new
// room; a `note` may cite a `pool` deposit from the same turn), so every tool
// that can change world state is stamped `executionMode: "sequential"`: the
// loop serialises any batch that contains one, while a batch made only of
// reads (look, who, examine, brief, feed, web, code read/search/diff …) still
// fans out. `MARINA_TOOL_EXECUTION=parallel` drops the stamps (library
// default everywhere); `sequential` also flips the Agent-level mode so even
// pure-read batches serialise.

export type ToolExecutionPolicy = "auto" | "sequential" | "parallel";

/** `MARINA_TOOL_EXECUTION` → policy; unset/invalid = `auto` (stamp mutators). */
export function toolExecutionPolicy(env: NodeJS.ProcessEnv = process.env): ToolExecutionPolicy {
  const raw = (env.MARINA_TOOL_EXECUTION ?? "").trim().toLowerCase();
  return raw === "sequential" || raw === "parallel" ? raw : "auto";
}

/** Tools that only observe (world, memory or workspace) — safe to run concurrently. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "marina_look",
  "marina_examine",
  "marina_inventory",
  "marina_who",
  "marina_help",
  "marina_brief",
  "marina_feed",
  "marina_novelty",
  "marina_web",
  "think",
  "marina_code_read_file",
  "marina_code_list_files",
  "marina_code_search",
  "marina_code_diff",
  "marina_code_history",
  "marina_code_summary",
  "marina_code_session_status",
  "marina_code_observe",
  "marina_code_artifacts",
  "marina_code_doctor",
  "marina_code_thread",
]);

/** Whether a tool by this name may change world state (anything not read-only). */
export function isMutatingToolName(name: string): boolean {
  return !READ_ONLY_TOOL_NAMES.has(name);
}

/**
 * Stamp per-tool `executionMode` according to the policy. `auto` marks every
 * mutating tool `sequential` and leaves reads unmarked (parallel by default);
 * `parallel` and `sequential` leave the tools untouched — the Agent-level
 * `toolExecution` option carries those (see `agentToolExecutionMode`).
 */
export function applyToolExecutionModes<T extends AgentTool>(
  tools: T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  if (toolExecutionPolicy(env) !== "auto") return tools;
  return tools.map((tool) =>
    isMutatingToolName(tool.name) && tool.executionMode === undefined
      ? { ...tool, executionMode: "sequential" as const }
      : tool,
  );
}

/**
 * Opt closed, all-required object schemas into provider-side constrained
 * sampling (`strict: true` on OpenAI-style function tools). pi-ai's
 * openai-completions path already sends `strict: false` on every function
 * tool, so the field itself is tolerated by every upstream; `strict: true`
 * only changes behaviour where the provider implements it (OpenAI, vLLM) and
 * is ignored by llama.cpp / Ollama. The proxy's Anthropic translation keeps
 * only `parameters`, so nothing reaches Anthropic.
 *
 * Only schemas whose shape is unchanged by strict mode qualify: pi-ai's
 * `makeStrictJsonSchema` turns every OPTIONAL property into
 * `anyOf: [T, null]` + required, which would hand handlers `null` where they
 * expect `undefined`. `strict: "prefer"` lets pi-ai fall back silently when a
 * provider (or an unsupported keyword) rejects it. `MARINA_STRICT_TOOLS=off`
 * disables the stamp.
 */
export function applyStrictToolSchemas<T extends AgentTool>(
  tools: T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  if ((env.MARINA_STRICT_TOOLS ?? "").trim().toLowerCase() === "off") return tools;
  return tools.map((tool) =>
    tool.constrainedSampling === undefined && isStrictSafeSchema(tool.parameters)
      ? {
          ...tool,
          constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
        }
      : tool,
  );
}

/** Keywords OpenAI strict mode rejects (mirrors pi-ai's `UNSUPPORTED_STRICT_SCHEMA_KEYS`). */
const STRICT_UNSUPPORTED_KEYS = [
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
];

/**
 * A closed object schema (`type: "object"`, `additionalProperties` absent or
 * `false`) whose EVERY property is required, recursively, with no keyword
 * strict mode rejects — i.e. one that strict sampling leaves semantically
 * unchanged. Exported for tests.
 */
export function isStrictSafeSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const node = schema as Record<string, unknown>;
  if (STRICT_UNSUPPORTED_KEYS.some((key) => node[key] !== undefined)) return false;
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.every(
      (variant) =>
        typeof variant === "object" &&
        variant !== null &&
        (variant as Record<string, unknown>).type !== "object" &&
        (variant as Record<string, unknown>).type !== "array" &&
        (variant as Record<string, unknown>).properties === undefined &&
        (variant as Record<string, unknown>).items === undefined,
    );
  }
  if (node.type === "array")
    return node.items === undefined ? false : isStrictSafeSchema(node.items);
  if (node.type !== "object") return node.properties === undefined;
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) return false;
  const properties =
    typeof node.properties === "object" && node.properties !== null
      ? (node.properties as Record<string, unknown>)
      : {};
  const names = Object.keys(properties);
  const required = new Set(Array.isArray(node.required) ? (node.required as unknown[]) : []);
  if (!names.every((name) => required.has(name))) return false;
  return names.every((name) => isStrictSafeSchema(properties[name]));
}

/** The Agent-level `toolExecution` option for the policy (undefined = library default). */
export function agentToolExecutionMode(
  env: NodeJS.ProcessEnv = process.env,
): "sequential" | "parallel" | undefined {
  const policy = toolExecutionPolicy(env);
  return policy === "auto" ? undefined : policy;
}

/**
 * Build the resident + deferred tool sets for a profile. `full` with deferral
 * on = core set + `marina_tool_search`; the rest are deferred. `onLoadTools`
 * is how loaded schemas reach the agent's live tool list.
 */

export function createProfileToolset(
  ctx: ToolContext,
  platformMemory: PlatformMemoryBackend,
  profile: ToolProfile,
  supports: AgentSupports = { text: true },
  options?: { onLoadTools?: (tools: AgentTool[]) => void },
): ProfileToolset {
  const all = applyStrictToolSchemas(
    applyToolExecutionModes(
      createAllTools(ctx, platformMemory).filter((tool) => {
        if (!supports.image && tool.name === "marina_generate_image") return false;
        if (!supports.video && tool.name === "marina_generate_video") return false;
        return true;
      }),
    ),
  );
  if (profile !== "full") {
    const want = new Set(TOOL_PROFILE_NAMES[profile]);
    return { resident: all.filter((t) => want.has(t.name)), deferred: [] };
  }
  if (!deferredToolsEnabled()) return { resident: all, deferred: [] };
  const residentNames = new Set(FULL_RESIDENT_TOOL_NAMES);
  const resident = all.filter((t) => residentNames.has(t.name));
  const deferred = all.filter((t) => !residentNames.has(t.name));
  resident.push(
    ...applyToolExecutionModes([
      createToolSearchTool(deferred, options?.onLoadTools) as unknown as AgentTool,
    ]),
  );
  return { resident, deferred };
}

/**
 * Resident tools for a profile (see `createProfileToolset`). Unknown names in
 * a profile list are silently dropped — log is the caller's responsibility.
 */
export function createScopedTools(
  ctx: ToolContext,
  platformMemory: PlatformMemoryBackend,
  profile: ToolProfile,
  supports: AgentSupports = { text: true },
  options?: { onLoadTools?: (tools: AgentTool[]) => void },
): AgentTool[] {
  return createProfileToolset(ctx, platformMemory, profile, supports, options).resident;
}
