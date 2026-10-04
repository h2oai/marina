// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  agreement,
  DEFAULT_TRUST,
  type FormationForecast,
  MAX_PROPOSAL_SD_MOVE,
  median,
  settle,
} from "./formations";
import type { Distribution } from "./types";

export interface SettlementPolicy {
  /** Multiplied by the proposals' agreement, as in the live median aggregator. */
  meanWeight: number;
  spreadWeight: number;
  sdScale?: number;
}

const valid = (d: Distribution | undefined): d is Distribution =>
  !!d && Number.isFinite(d.mean) && Number.isFinite(d.sd) && d.sd > 0;

/**
 * Shadow-only ablation of a complete recorded two-round Delphi run. Reuse the exact
 * proposals and settlement guardrails; change mean/spread shrinkage separately.
 * Reconstruct the original output first, refusing incompatible or partial traces.
 * This makes no model calls and does not establish timing/qualification: the
 * caller must record each derived candidate before lock, retaining its inputs.
 */
export function replayDelphiSettlement(
  base: Distribution,
  recorded: FormationForecast,
  policy: SettlementPolicy,
) {
  if (
    ![policy.meanWeight, policy.spreadWeight].every(
      (w) => Number.isFinite(w) && w >= 0 && w <= 1,
    ) ||
    !Number.isFinite(policy.sdScale ?? 1) ||
    (policy.sdScale ?? 1) < 0.5 ||
    (policy.sdScale ?? 1) > 2
  )
    throw new Error("invalid settlement policy");
  const proposals = Object.values(recorded.proposals ?? {});
  const steps = recorded.rounds ?? [];
  const members = new Set(steps.map((s) => s.member));
  if (
    !valid(base) ||
    !valid(recorded.topline) ||
    recorded.formation !== "delphi" ||
    recorded.fallback ||
    proposals.length === 0 ||
    members.size !== proposals.length ||
    steps.length !== 2 * members.size ||
    ["round1", "round2"].some(
      (stage) =>
        new Set(steps.filter((s) => s.stage === stage && s.status === "ok").map((s) => s.member))
          .size !== members.size,
    ) ||
    proposals.some(
      (p) => !valid(p) || Math.abs(p.mean - base.mean) > MAX_PROPOSAL_SD_MOVE * base.sd,
    )
  )
    throw new Error("requires a complete scalar Delphi trace");
  const agree = agreement(base, proposals);
  const move = median(proposals.map((p) => p.mean - base.mean));
  const proposedSd = median(proposals.map((p) => p.sd));
  const control = settle(base, move, proposedSd, DEFAULT_TRUST * agree);
  if (control.mean !== recorded.topline.mean || control.sd !== recorded.topline.sd)
    throw new Error("recorded forecast does not match the current settlement rule");
  const meanTrust = policy.meanWeight * agree;
  const spreadTrust = policy.spreadWeight * agree;
  return {
    control,
    forecast: {
      mean: settle(base, move, proposedSd, meanTrust).mean,
      sd: settle(base, move, proposedSd, spreadTrust, policy.sdScale).sd,
    },
    agreement: agree,
    meanTrust,
    spreadTrust,
    medianMove: move,
    medianSd: proposedSd,
  };
}
