// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export function researchFeatures(env: NodeJS.ProcessEnv) {
  const rounds = Number(env.MARINA_RESEARCH_LOOP_ROUNDS ?? 1);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 3)
    throw new Error("MARINA_RESEARCH_LOOP_ROUNDS must be 1–3");
  return {
    capture: env.MARINA_RESEARCH_EVIDENCE?.trim().toLowerCase() === "on" || rounds > 1,
    rounds,
    reviewer: env.MARINA_RESEARCH_LOOP_MODEL?.trim() || undefined,
    reader: env.MARINA_READ_SWARM_READER?.trim() || undefined,
  };
}
