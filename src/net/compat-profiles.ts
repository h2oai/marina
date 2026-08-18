// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compat profiles — passthru-layer model-id aliases for OpenAI-compatible clients.
 *
 * Marina plays three roles in its relationship with agents:
 *   1. Participant — agents inside Marina doing work in worlds (worlds/*.ts)
 *   2. Consumer    — Marina's agents calling out to upstream LLMs (model channel + connectors)
 *   3. Passthru    — external clients (editors, OpenAI SDKs, …) calling in
 *                    via OpenAI-compat /v1/* endpoints and ACP
 *
 * This file owns the passthru surface: it lets an external client point at
 * Marina under a familiar model id by registering an alias (e.g. a client
 * configured for the model id "assistant" finds it in /v1/models). Aliases all
 * resolve to the default "model" channel — same agents, same routing, just a
 * familiar id.
 *
 * Adding a compat profile is a one-line change here. These passthru aliases are
 * self-contained — they only register model-id aliases on /v1/models and are
 * independent of which world is loaded.
 *
 * Defaults: all profiles enabled. Aliases use names that don't collide with stock
 * model ids ("marina", "marina:<crew>"). Override with the MARINA_COMPAT
 * env var: comma-separated profile names, or "none" to disable all.
 */

export interface CompatProfile {
  /** Stable profile name; matches MARINA_COMPAT entries. */
  name: string;
  /** One-line description, surfaced in docs/diagnostics. */
  description: string;
  /** Model ids this profile claims. Each resolves to the default "model" channel. */
  modelAliases?: string[];
}

export const COMPAT_PROFILES: CompatProfile[] = [
  {
    name: "openai",
    description: 'Generic OpenAI-SDK drop-in — exposes "assistant" as a model id alias',
    modelAliases: ["assistant"],
  },
];

/** Resolve which profiles are active. Default = all; MARINA_COMPAT=none = disable; */
/* otherwise comma-separated allow-list of profile names. */
export function getEnabledProfiles(): CompatProfile[] {
  const raw = process.env.MARINA_COMPAT?.trim();
  if (!raw) return COMPAT_PROFILES;
  if (raw === "none") return [];
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return COMPAT_PROFILES.filter((p) => wanted.has(p.name));
}

/** Build alias → channel-name map. Every alias resolves to the default "model" channel. */
export function buildAliasMap(
  profiles: CompatProfile[] = getEnabledProfiles(),
): Map<string, string> {
  const map = new Map<string, string>();
  for (const profile of profiles) {
    for (const alias of profile.modelAliases ?? []) {
      map.set(alias, "model");
    }
  }
  return map;
}

/** Flat list of every alias from the active profiles. */
export function getActiveAliases(): string[] {
  return [...buildAliasMap().keys()];
}
