// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export const CONFIGURATION_PRESETS = ["minimal", "workbench", "shared-team"] as const;
export type ConfigurationPreset = (typeof CONFIGURATION_PRESETS)[number];

/** Presets choose desired capabilities; trust policy remains an independent explicit setting. */
export function configurationPreset(name: string): Record<string, string> {
  if (!CONFIGURATION_PRESETS.includes(name as ConfigurationPreset))
    throw new Error(`Unknown preset ${name}; choose ${CONFIGURATION_PRESETS.join(", ")}`);
  const local = {
    WS_HOST: "127.0.0.1",
    TELNET_PORT: "0",
    MARINA_TRADING_ENABLED: "false",
    MARINA_OPEN_API: "false",
    MARINA_ALLOW_INSECURE_PUBLIC: "false",
  };
  // Cost-controlled presets pin agents off explicitly. The workbench preset
  // leaves them to the runtime defaults: room agents on, and seeded agents
  // auto-respawn under the local profile once a provider is configured —
  // bounded by the default daily spend cap (MARINA_DAILY_SPEND_CAP_USD, $50).
  const agentsOff = { MARINA_ROOM_AGENTS: "false", AGENT_AUTORESPAWN: "false" };
  if (name === "minimal")
    return { ...local, ...agentsOff, MARINA_WORLD: "empty", MCP_PORT: "0", LOG_PORT: "0" };
  if (name === "workbench") return { ...local, MARINA_WORLD: "default" };
  return {
    ...local,
    ...agentsOff,
    MARINA_WORLD: "commons",
    MARINA_PROFILE: "shared",
    MARINA_AUTH: "better-auth",
    DB_PATH: "data/marina.db",
    BETTER_AUTH_DB_PATH: "data/marina-auth.db",
    ASSETS_DIR: "data/assets",
  };
}

export function validateConfiguration(values: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const key of ["WS_PORT", "TELNET_PORT", "MCP_PORT", "LOG_PORT"]) {
    if (values[key] !== undefined && (!/^\d+$/.test(values[key]!) || Number(values[key]) > 65535))
      problems.push(`${key} must be an integer from 0 to 65535`);
  }
  if (values.MARINA_AUTH === "better-auth" && (values.BETTER_AUTH_SECRET?.length ?? 0) < 32)
    problems.push("BETTER_AUTH_SECRET must contain at least 32 characters when sign-in is enabled");
  if (values.MARINA_PROFILE && !["local", "shared", "public"].includes(values.MARINA_PROFILE))
    problems.push("MARINA_PROFILE must be local, shared or public");
  return problems;
}
