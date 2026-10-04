// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RouteEvidence } from "../coordination/task-routing";
import type { ArenaShadowRow } from "../persistence/db-arena";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import type { ArenaData } from "./data";
import { outcomePublicBeforeLock, scoreShadow } from "./evaluate";
import { forecastAnswer, portfolioHash, type runArenaPortfolio } from "./portfolio";

export type PortfolioRun = Awaited<ReturnType<typeof runArenaPortfolio>>;

/** Append the whole comparison atomically in the existing shadow ledger. A
 * failed/late run remains visible; it cannot replace a live submission. */
export function recordPortfolioShadow(
  store: Pick<ArenaStore, "recordArenaShadow">,
  run: PortfolioRun,
  metadata: {
    capturedAt: string;
    completedAt: string;
    costUsd: number;
    costFinal?: boolean;
    selection?: unknown;
    settings?: unknown;
  },
) {
  const invalidTime =
    !Number.isFinite(Date.parse(metadata.capturedAt)) ||
    !Number.isFinite(Date.parse(metadata.completedAt));
  if (invalidTime) throw new Error("invalid portfolio capture/completion timestamps");
  const eligible =
    run.complete &&
    Date.parse(metadata.capturedAt) <= Date.parse(metadata.completedAt) &&
    Date.parse(metadata.completedAt) < Date.parse(run.inputs.round.lock_at);
  if (
    !store.recordArenaShadow({
      roundId: run.inputs.round.round_id,
      forecaster: `portfolio-v1#${portfolioHash({ plan: run.plan, settings: metadata.settings })}`,
      forecast: JSON.stringify(run.result ? forecastAnswer(run.result) : {}),
      detail: JSON.stringify({ portfolio: { ...run, ...metadata, eligible } }),
      costUsd: metadata.costUsd,
    })
  )
    throw new Error("could not persist portfolio shadow");
  return { eligible };
}

/** Latest attempt per round/configuration wins, INCLUDING failures. This prevents
 * silently selecting an earlier lucky run. Comparisons use identical resolved
 * rounds and the arena's native score, never selector confidence. */
export async function scorePortfolioShadows(data: ArenaData, rows: ArenaShadowRow[]) {
  const latestRows = new Map<string, ArenaShadowRow>();
  for (const row of rows) {
    if (!row.forecaster.startsWith("portfolio-v1#")) continue;
    const key = JSON.stringify([row.round_id, row.forecaster]);
    if (!latestRows.has(key) || latestRows.get(key)!.id < row.id) latestRows.set(key, row);
  }
  const latest = new Map<
    string,
    {
      row: ArenaShadowRow;
      run: PortfolioRun & {
        eligible: boolean;
        capturedAt: string;
        completedAt: string;
        settings?: unknown;
      };
    }
  >();
  let invalid = 0;
  for (const row of latestRows.values()) {
    try {
      const run = JSON.parse(row.detail).portfolio;
      if (
        run.version !== 1 ||
        run.inputHash !== portfolioHash(run.inputs) ||
        run.planHash !== portfolioHash(run.plan) ||
        run.inputs.round.round_id !== row.round_id
      )
        throw new Error("invalid portfolio record");
      const key = JSON.stringify([row.round_id, row.forecaster]);
      if (!latest.has(key) || latest.get(key)!.row.id < row.id) latest.set(key, { row, run });
    } catch {
      invalid++;
    }
  }
  const comparisons = [];
  const evidence: RouteEvidence[] = [];
  const resolutions = await data.resolutions();
  for (const { row, run } of latest.values()) {
    const round = run.inputs.round;
    const completed = Date.parse(run.completedAt);
    const lockAt = Date.parse(round.lock_at);
    const timely =
      completed < lockAt && row.created_at < lockAt && Date.parse(run.capturedAt) <= completed;
    const control = run.nodes.control?.forecast;
    if (!timely || !control) {
      comparisons.push({
        roundId: row.round_id,
        config: row.forecaster,
        status: "ineligible",
        error: run.error ?? "late, incomplete or missing control",
      });
      continue;
    }
    const resolution = resolutions[row.round_id];
    if (resolution && outcomePublicBeforeLock(round, resolution.observed_date)) {
      comparisons.push({
        roundId: row.round_id,
        config: row.forecaster,
        status: "ineligible",
        error: "outcome public before lock",
      });
      continue;
    }
    const candidate = run.eligible && run.complete && run.result;
    const scores = await scoreShadow(data, [
      { ...row, forecaster: "control", forecast: JSON.stringify(forecastAnswer(control)) },
      ...(candidate
        ? [{ ...row, forecaster: "candidate", forecast: JSON.stringify(forecastAnswer(candidate)) }]
        : []),
    ]);
    const a = scores.find((s) => s.forecaster === "control");
    const b = scores.find((s) => s.forecaster === "candidate");
    const fallbackNodes = Object.entries(run.nodes)
      .filter(([, n]) => n.forecast && "fallback" in n.forecast)
      .map(([id]) => id);
    comparisons.push({
      roundId: row.round_id,
      config: row.forecaster,
      status: !candidate ? "failed" : a && b ? "resolved" : "unresolved",
      error: run.error,
      controlSkill: a?.skill,
      candidateSkill: b?.skill,
      improvement: a && b ? b.skill - a.skill : undefined,
      costUsd: row.cost_usd,
      fallbackNodes,
    });
    if (
      a &&
      (b || !candidate) &&
      resolution?.resolved_at &&
      Date.parse(resolution.resolved_at) > completed
    ) {
      evidence.push({
        version: 1,
        id: `arena-shadow:${portfolioHash([row.round_id, row.forecaster, run.inputHash, run.completedAt])}`,
        benchmark: "social-simulation-arena",
        cohort: `${round.tracker}/${round.target_type}/${portfolioHash(run.settings ?? {})}`,
        item: row.round_id,
        skills: ["forecasting", "uncertainty", "evidence-verification"],
        candidate: run.planHash,
        strategy: run.plan.score.id,
        control: portfolioHash(run.plan.operations.control),
        metric: round.target_type === "profile_energy" ? "energy-skill" : "crps-skill",
        higherIsBetter: true,
        controlValue: a.skill,
        candidateValue: b?.skill,
        status: b ? "completed" : "failed",
        predictedAt: run.completedAt,
        availableAt: resolution.resolved_at,
        prospective: true,
      });
    }
  }
  return {
    comparisons,
    evidence,
    invalid,
    note: "Shadow comparisons only. Unresolved/failed/late runs provide no evidence of improvement. No automatic promotion.",
  };
}
