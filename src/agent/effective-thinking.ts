// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The thinking level each running agent actually sends, by agent name — the
 * one answer to "did this agent think?" for surfaces that only hold a name
 * (work outcomes, `agent list`). A running agent registers its wire level
 * (`LeanAgentAdapter`, on spawn and on every reconfigure); a name with no
 * running agent falls back to its saved `agent_configs.thinking_level`, then
 * `MARINA_AGENT_THINKING`, then `off` — the order the adapter resolves it in.
 * Per process; labels only.
 */
import { type AgentThinkingLevel, parseAgentThinkingLevel } from "./agent-types";

const running = new Map<string, AgentThinkingLevel>();

/** Record the level `name` sends on the wire (`off` when its model takes none). */
export function noteEffectiveThinking(name: string, level: AgentThinkingLevel): void {
  running.set(name, level);
}

/** The level a running agent registered, if any. */
export function runningThinkingLevel(name: string): AgentThinkingLevel | undefined {
  return running.get(name);
}

/**
 * `name`'s effective thinking level: the running agent's wire level, else its
 * saved level, else the instance default, else `off`.
 */
export function effectiveThinkingLevel(
  name: string,
  saved: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AgentThinkingLevel {
  return (
    running.get(name) ??
    parseAgentThinkingLevel(saved ?? undefined) ??
    parseAgentThinkingLevel(env.MARINA_AGENT_THINKING) ??
    "off"
  );
}

/** Test hook. */
export function resetEffectiveThinkingForTests(): void {
  running.clear();
}
