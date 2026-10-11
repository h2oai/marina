// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { evidenceHash, validateEvidence } from "../research/evidence";
import type { researchHypotheses } from "../research/hypotheses";
import type { RoundForecast } from "./forecast";
import type { ArenaLock, ArenaRound } from "./types";

export interface PortfolioResearchCapture {
  version: 1;
  round: ArenaRound;
  lock: ArenaLock;
  start: RoundForecast;
  paths: Awaited<ReturnType<typeof researchHypotheses>>;
  capturedAt: string;
  hash: string;
}

export function freezePortfolioResearch(
  input: Omit<PortfolioResearchCapture, "hash" | "version">,
): PortfolioResearchCapture {
  const payload = { version: 1 as const, ...structuredClone(input) };
  return { ...payload, hash: evidenceHash(payload) };
}

/** Same captured sources AND numeric anchor for both research-isolation arms. */
export function validatePortfolioResearch(
  capture: PortfolioResearchCapture,
  round: ArenaRound,
  now: string,
) {
  const { hash, ...payload } = capture;
  if (
    capture.version !== 1 ||
    evidenceHash(payload) !== hash ||
    evidenceHash(capture.round) !== evidenceHash(round) ||
    !Number.isFinite(Date.parse(capture.capturedAt)) ||
    Date.parse(capture.capturedAt) > Date.parse(now) ||
    Date.parse(now) >= Date.parse(round.lock_at) ||
    !capture.paths.complete ||
    capture.paths.budget.active > 0
  )
    throw new Error("invalid, incomplete or expired paired research capture");
  for (const name of ["measurement", "mechanism", "challenge"] as const) {
    const report = capture.paths.paths[name]?.report;
    if (!report?.evidence || report.researchLoop?.error || report.researchLoop?.costFinal === false)
      throw new Error("paired research needs complete captured evidence on every path");
    validateEvidence(report.evidence);
    if (
      report.evidence.brief.roundId !== round.round_id ||
      Date.parse(report.evidence.cutoff) > Date.parse(capture.capturedAt) ||
      Date.parse(report.evidence.capturedAt) > Date.parse(capture.capturedAt)
    )
      throw new Error("paired evidence target or cutoff mismatch");
  }
  return structuredClone(capture);
}
