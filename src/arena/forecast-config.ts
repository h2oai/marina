// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { researchFeatures } from "../research/settings";
import { horizonOptionsFromEnv } from "./research/civiqs-horizon";

/** Explicit allowlist: never persist process.env or API keys in a forecast trace. */
export function forecastSettings(spec: string, env: NodeJS.ProcessEnv, weight?: number) {
  const settings = {
    version: 2,
    research: researchFeatures(env),
    signals: env.MARINA_ARENA_RESEARCH_SIGNALS ?? "off",
    formationLessons: env.MARINA_ARENA_FORMATION_LESSONS ?? "observe",
    spec,
    routes: spec === "routed" ? (env.MARINA_ARENA_ROUTES ?? "*=nowcast") : undefined,
    horizon: horizonOptionsFromEnv(env),
    live: env.MARINA_ARENA_CIVIQS_LIVE?.trim().toLowerCase() !== "off",
    lookups: env.MARINA_ARENA_RESEARCH_LOOKUPS ?? "off",
    judge: env.MARINA_ARENA_RESEARCH_JUDGE ?? "jev",
    researchTrust: env.MARINA_ARENA_RESEARCH_TRUST ?? "0.5",
    weight: weight ?? 0.5,
  };
  return {
    ...settings,
    fingerprint: createHash("sha256").update(JSON.stringify(settings)).digest("hex"),
  };
}
