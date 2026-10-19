// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { researchFeatures } from "../research/settings";
import { proposalJudgeMode, proposalJudgeModel } from "./proposal-judge";
import { horizonOptionsFromEnv } from "./research/civiqs-horizon";

/** Explicit allowlist: never persist process.env or API keys in a forecast trace. */
export function forecastSettings(spec: string, env: NodeJS.ProcessEnv, weight?: number) {
  const settings = {
    version: 2,
    research: researchFeatures(env),
    researchRequired: env.MARINA_ARENA_RESEARCH_REQUIRED === "on",
    evidenceRefresh: env.MARINA_ARENA_EVIDENCE_REFRESH === "on",
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
    // Only where a delphi / symbiosis formation can run, so other specs keep their fingerprint.
    ...(spec === "routed" || /formation:(delphi|symbiosis)\b/i.test(spec)
      ? {
          proposalJudge: proposalJudgeMode(env),
          proposalJudgeModel: proposalJudgeModel(env),
        }
      : {}),
    // Only for the wiki-events card, so every other spec keeps its fingerprint.
    ...(spec.includes("research:wiki-events")
      ? { wikiEventsMaxInsert: env.MARINA_ARENA_WIKI_EVENTS_MAX_INSERT ?? "3" }
      : {}),
  };
  return {
    ...settings,
    fingerprint: createHash("sha256").update(JSON.stringify(settings)).digest("hex"),
  };
}
