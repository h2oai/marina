// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { isLocalProfile } from "./trust-profile";

/**
 * Whether seeded/saved agents respawn on boot (`AGENT_AUTORESPAWN`).
 *
 * Explicit `true` / `false` always wins. Unset means ON only for a local
 * install (the `local` trust profile: loopback bind, no external auth) that
 * has a usable provider (a key, a stored key, or a local runtime), so the
 * default world's Host / Builder / Critic / Chronicler answer out of the box —
 * bounded by the default daily spend cap. Shared and public deployments, and
 * installs with no provider (every call would fail), stay off unless an
 * operator opts in.
 */
export function autoRespawnEnabled(
  hasProvider: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.AGENT_AUTORESPAWN?.trim().toLowerCase();
  if (raw) return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
  return isLocalProfile(env) && hasProvider;
}

/**
 * Whether a saved agent config is respawned by the server at boot. A
 * supervised resident (`runtime = 'supervised'`, migration 172) is run by its
 * owner's local supervisor, never by this process: it stays offline until
 * that supervisor launches or resumes it.
 */
export function respawnsOnBoot(config: { runtime?: string | null }): boolean {
  return config.runtime !== "supervised";
}
