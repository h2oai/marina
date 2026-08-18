// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Classifies an entity by how it came to exist in the world, so the roster can
 * colorize/group "things I launched" vs "the default system" vs "whoever
 * wandered in". Derived from kind + whether a runtime agent is attached +
 * AgentConfig.spawned_by (surfaced in the world snapshot).
 */
export type EntityOrigin = "manual" | "crew" | "system" | "player" | "joined";

export function entityOrigin(e: {
  kind: string;
  agentStatus?: unknown;
  spawnedBy?: string;
}): EntityOrigin {
  if (e.kind === "human") return "player"; // a person who joined
  if (e.kind !== "agent") return "system"; // npc / object — world fixtures
  if (!e.agentStatus) return "joined"; // agent connected externally, not runtime-managed
  const by = e.spawnedBy;
  if (!by || by === "system") return "system"; // world-seeded on boot
  if (by === "operator") return "manual"; // launched from the dashboard / CLI
  return "crew"; // spawned by another agent (by === that agent's name)
}

export const ORIGIN_META: Record<
  EntityOrigin,
  { label: string; color: string; title: string; rank: number }
> = {
  manual: {
    label: "manual",
    color: "var(--color-primary)",
    title: "Launched manually from the dashboard or CLI",
    rank: 0,
  },
  crew: {
    label: "crew",
    color: "#a78bfa",
    title: "Spawned by another agent (crew sub-agent)",
    rank: 1,
  },
  system: {
    label: "system",
    color: "var(--color-secondary)",
    title: "Part of the selected world — seeded on boot",
    rank: 2,
  },
  player: {
    label: "player",
    color: "var(--color-text-bright)",
    title: "A human who joined",
    rank: 3,
  },
  joined: {
    label: "joined",
    color: "#22c55e",
    title: "Connected opportunistically (external agent, not runtime-managed)",
    rank: 4,
  },
};
