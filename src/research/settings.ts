// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { advisoryMode } from "../decisions/advisory";

export function researchFeatures(env: NodeJS.ProcessEnv) {
  const rounds = Number(env.MARINA_RESEARCH_LOOP_ROUNDS ?? 1);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 3)
    throw new Error("MARINA_RESEARCH_LOOP_ROUNDS must be 1–3");
  return {
    capture:
      env.MARINA_RESEARCH_EVIDENCE?.trim().toLowerCase() === "on" ||
      !!env.MARINA_RESEARCH_SURVEY_FILE?.trim() ||
      !!env.MARINA_RESEARCH_CALENDAR_FILE?.trim() ||
      rounds > 1 ||
      advisoryMode(env.MARINA_RESEARCH_TARGET_EVIDENCE) !== "off",
    targetEvidence: advisoryMode(env.MARINA_RESEARCH_TARGET_EVIDENCE),
    advice: advisoryMode(env.MARINA_RESEARCH_ADVICE),
    surveys: !!env.MARINA_RESEARCH_SURVEY_FILE?.trim(),
    calendar: !!env.MARINA_RESEARCH_CALENDAR_FILE?.trim(),
    rounds,
    reviewer: env.MARINA_RESEARCH_LOOP_MODEL?.trim() || undefined,
    reader: env.MARINA_READ_SWARM_READER?.trim() || undefined,
  };
}
