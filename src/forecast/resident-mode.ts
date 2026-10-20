// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The switch for residents as forecast analysts (`./resident-part.ts`), kept
 * dependency-free so a command can read it without loading the pipeline.
 */

/** `MARINA_FORECAST_RESIDENTS` — `on` lets residents be forecast analysts (default `off`). */
export function residentsMode(env: NodeJS.ProcessEnv = process.env): "off" | "on" {
  return env.MARINA_FORECAST_RESIDENTS?.trim().toLowerCase() === "on" ? "on" : "off";
}

/** A `marina:<crew>` or `role:<r>` analyst spec. */
export function isResidentSpec(spec: string): boolean {
  return /^(marina|role):\S+$/.test(spec.trim());
}
