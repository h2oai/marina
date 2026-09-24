// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM-callable tool definitions for the lean agent — entry point.
 * All tools conform to pi-agent-core's AgentTool interface.
 *
 * Most tools are thin wrappers around marina_command — they take typed
 * parameters and construct a command string. This keeps tool count high
 * (better for LLM tool selection) without duplicating logic.
 *
 * The implementations live in one module per concern behind a strict import
 * DAG rooted at `./shared` (`command`, `code`, `world`, `media`, `think`,
 * `memory`, `memory-service`, `memory-assistance`, `evolution`,
 * `profiles`); no module under `tools/` imports this file. Every symbol
 * consumed elsewhere (lean-agent-adapter, ops-api, worlds, tests) is
 * re-exported here so importers never need to know about the layout.
 */

export { COMMAND_ROSTER, createCommandTool, ECOLOGY_ROSTER } from "./command";
export { createEvolutionTool } from "./evolution";
export { createMemoryTool } from "./memory";
export { createMemoryServiceTool } from "./memory-service";
export {
  agentToolExecutionMode,
  applyStrictToolSchemas,
  applyToolExecutionModes,
  createAllTools,
  createProfileToolset,
  createScopedTools,
  createToolSearchTool,
  deferredToolsEnabled,
  FULL_RESIDENT_TOOL_NAMES,
  isMutatingToolName,
  isStrictSafeSchema,
  type ProfileToolset,
  READ_ONLY_TOOL_NAMES,
  TOOL_PROFILE_NAMES,
  TOOL_SEARCH_NAME,
  type ToolExecutionPolicy,
  type ToolProfile,
  toolExecutionPolicy,
} from "./profiles";
export type { ToolContext } from "./shared";
export { createThinkTool } from "./think";
export { createWorldTools } from "./world";
