// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Frozen factorial experiments: source and statistical effects are separated.
 * This module cannot sign, submit or promote a forecast. */
import { WorkBudget } from "../coordination/work-budget";
import { getErrorMessage } from "../engine/errors";
import type { ForecastLesson } from "../forecast/lessons";
import { evidenceHash, validateEvidence } from "../research/evidence";
import type { RoundForecast } from "./forecast";
import { PERSISTENCE_SD } from "./forecast";
import type { ResearchDossier } from "./formations";
import { auditForecastFreshness } from "./freshness";
import {
  arenaPortfolioPlan,
  type PortfolioComplete,
  type PortfolioNode,
  runArenaPortfolio,
} from "./portfolio";
import { horizonDays } from "./research/civiqs-horizon";
import { crpsNormal, skill } from "./score";
import type { ArenaLock, ArenaRound, Distribution } from "./types";
import { type CalibrationObservation, calibrateUncertainty } from "./uncertainty";

export const RESEARCH_ARMS = ["A", "B", "C", "D", "O", "L"] as const;
export type ResearchArm = (typeof RESEARCH_ARMS)[number];

export interface ResearchExperiment {
  version: 1;
  round: ArenaRound;
  lock: ArenaLock;
  capturedAt: string;
  starts: { control: RoundForecast; projected: RoundForecast };
  dossiers: { control: ResearchDossier; research: ResearchDossier };
  lessons: ForecastLesson[];
  calibration: CalibrationObservation[];
  settings: {
    arms: ResearchArm[];
    models: string[];
    /** Hash of the captured runner; compile it to include all application source. */
    implementation?: string;
    maxTokens: number;
    callsPerArm: number;
    timeoutMs: number;
    retriever: string;
    researchRounds: number;
    reader?: string;
    controlHorizon: unknown;
    projectedHorizon: unknown;
    /** Measured cost of capture, separate from each forecast arm. */
    captureCostUsd: number;
  };
  hash: string;
}

export interface ExperimentAttempt {
  inputHash: string;
  arm: ResearchArm;
  startedAt: string;
  completedAt: string;
  status: "complete" | "failed" | "late";
  forecast?: Distribution;
  raw?: Distribution;
  detail?: unknown;
  calibration?: ReturnType<typeof calibrateUncertainty>;
  error?: string;
  costUsd: number;
  calls: number;
}

export function experimentVariant(input: ResearchExperiment, arm: ResearchArm): string {
  const { captureCostUsd: _cost, ...settings } = input.settings;
  return `research-v1:${evidenceHash(settings)}:${arm}:raw`;
}

/** Production ensembles may degrade gracefully; a controlled experiment must retain failures. */
function incompleteFormation(detail: unknown): boolean {
  const nodes = (detail as { nodes?: Record<string, PortfolioNode> } | undefined)?.nodes;
  return Object.values(nodes ?? {}).some((node) => {
    const forecast = node.forecast as
      | (RoundForecast & { fallback?: string; rounds?: Array<{ status: string }> })
      | undefined;
    return !!(
      node.error ||
      forecast?.fallback ||
      forecast?.rounds?.some((step) => step.status !== "ok")
    );
  });
}

export function validateExperiment(input: ResearchExperiment): void {
  const { hash, ...value } = input;
  if (input.version !== 1 || evidenceHash(value) !== hash)
    throw new Error("experiment input hash mismatch");
  if (input.round.target_type !== "continuous_normal" || input.round.tracker !== "civiqs")
    throw new Error("this experiment requires a Civiqs scalar target");
  if (
    !Number.isFinite(Date.parse(input.capturedAt)) ||
    !Number.isFinite(Date.parse(input.round.lock_at)) ||
    Date.parse(input.capturedAt) >= Date.parse(input.round.lock_at)
  )
    throw new Error("experiment capture is not prospective");
  for (const f of Object.values(input.starts)) {
    if (
      !f.topline ||
      !Number.isFinite(f.topline.mean) ||
      !Number.isFinite(f.topline.sd) ||
      !(f.topline.sd > 0)
    )
      throw new Error("invalid experiment start");
    const fresh = auditForecastFreshness(input.round, input.lock, f, input.capturedAt);
    if (!fresh.ok) throw new Error(`experiment has stale inputs: ${fresh.issues.join("; ")}`);
  }
  for (const d of Object.values(input.dossiers)) if (d.evidence) validateEvidence(d.evidence);
  const s = input.settings;
  if (
    !s.arms.includes("A") ||
    new Set(s.arms).size !== s.arms.length ||
    s.arms.some((a) => !RESEARCH_ARMS.includes(a))
  )
    throw new Error("experiment arms must include one control and no duplicates");
  if (
    !s.models.length ||
    s.models.length > 8 ||
    !Number.isSafeInteger(s.maxTokens) ||
    s.maxTokens < 1 ||
    s.maxTokens > 8000 ||
    !Number.isSafeInteger(s.callsPerArm) ||
    s.callsPerArm < 1 ||
    !Number.isFinite(s.timeoutMs) ||
    s.timeoutMs <= 0
  )
    throw new Error("invalid experiment model settings");
}

export async function runResearchArm(
  input: ResearchExperiment,
  arm: ResearchArm,
  backend: { complete: PortfolioComplete; usage: { costUsd: number; calls: number } },
  opts: { now?: () => Date; onStart?: (attempt: ExperimentAttempt) => Promise<void> } = {},
): Promise<ExperimentAttempt> {
  validateExperiment(input);
  if (!input.settings.arms.includes(arm)) throw new Error("arm was not registered at capture");
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  if (Date.parse(startedAt) >= Date.parse(input.round.lock_at))
    throw new Error("round is already locked");
  const pending: ExperimentAttempt = {
    inputHash: input.hash,
    arm,
    startedAt,
    completedAt: startedAt,
    status: "failed",
    error: "interrupted before completion",
    costUsd: 0,
    calls: 0,
  };
  await opts.onStart?.(pending);
  const start = structuredClone(
    arm === "A" || arm === "C" ? input.starts.control : input.starts.projected,
  );
  const dossier = structuredClone(
    arm === "A" || arm === "B" ? input.dossiers.control : input.dossiers.research,
  );
  if (dossier.error || dossier.status === "failed")
    return { ...pending, error: "research capture failed" };
  if (arm !== "A" && arm !== "B" && !dossier.verified.trim())
    return { ...pending, error: "research treatment has no verified evidence" };
  const before = { ...backend.usage };
  const budget = new WorkBudget({
    calls: input.settings.callsPerArm,
    concurrency: 3,
    timeoutMs: Math.max(
      1,
      Math.min(input.settings.timeoutMs, Date.parse(input.round.lock_at) - Date.parse(startedAt)),
    ),
  });
  let result: Omit<ExperimentAttempt, keyof typeof pending> & Partial<ExperimentAttempt> = {};
  try {
    const plan = arenaPortfolioPlan(arm === "O" ? "layered" : "control", input.settings.models);
    const run = await runArenaPortfolio(
      plan,
      { round: input.round, lock: input.lock, start, dossier },
      budget,
      async (model, system, user, signal) =>
        backend.complete(
          model,
          system,
          arm === "L"
            ? `${user}\nJudged lessons known at capture (advice only):\n${input.lessons
                .filter(
                  (l) => Date.parse(l.resolvedAt) <= Date.parse(input.capturedAt) && !l.observed,
                )
                .map((l) => `- ${l.text}`)
                .join("\n")}`
            : user,
          signal,
        ),
    );
    result.detail = run;
    if (!run.complete || !run.result?.topline) throw new Error(run.error ?? "incomplete forecast");
    if (incompleteFormation(run))
      throw new Error("formation had failed or invalid responses; attempt retained but ineligible");
    const raw = run.result.topline;
    const anchor =
      start.origins?.[input.round.series ?? ""]?.reading.date ??
      (input.lock.answer_history ?? input.lock.history)?.at(-1)?.date ??
      input.capturedAt.slice(0, 10);
    const calibration = calibrateUncertainty(
      raw,
      {
        roundId: input.round.round_id,
        variant: experimentVariant(input, arm),
        family: input.round.tracker,
        unit: input.round.unit ?? "points",
        asOf: input.capturedAt,
        horizon: horizonDays(anchor, input.round.release_at),
        sourceAge: horizonDays(anchor, input.capturedAt),
      },
      input.calibration,
    );
    const apply = ["B", "D", "O", "L"].includes(arm);
    result = {
      status: "complete",
      raw,
      forecast: apply ? calibration.forecast : raw,
      ...(apply ? { calibration } : {}),
      detail: run,
      error: undefined,
    };
  } catch (e) {
    result = { ...result, status: "failed", error: getErrorMessage(e) };
  }
  const completedAt = now().toISOString();
  return {
    ...pending,
    ...result,
    completedAt,
    ...(Date.parse(completedAt) >= Date.parse(input.round.lock_at)
      ? { status: "late" as const }
      : {}),
    costUsd: Math.max(0, backend.usage.costUsd - before.costUsd),
    calls: Math.max(0, backend.usage.calls - before.calls),
  };
}

export interface ExperimentScore {
  roundId: string;
  series: string;
  cohort: string;
  arm: ResearchArm;
  lockAt: string;
  status: "pending" | "resolved" | "invalid";
  gain?: number;
  skill?: number;
  controlSkill?: number;
  meanError?: number;
  covered80?: boolean;
  reason?: string;
}

export function scoreResearchExperiment(
  input: ResearchExperiment,
  attempts: ExperimentAttempt[],
  resolution: { value?: unknown; resolved_at?: string },
  asOf: string,
) {
  validateExperiment(input);
  const control = attempts.find((a) => a.arm === "A");
  const last = (input.lock.answer_history ?? input.lock.history)?.at(-1);
  const observations: CalibrationObservation[] = [];
  const scores: ExperimentScore[] = [];
  for (const arm of input.settings.arms) {
    const attempt = attempts.find((a) => a.arm === arm)!;
    const base: ExperimentScore = {
      roundId: input.round.round_id,
      series: input.round.series ?? "",
      cohort: `${experimentVariant(input, arm)}:${input.round.tracker}:${input.round.unit ?? "points"}`,
      arm,
      lockAt: input.round.lock_at,
      status: "pending",
    };
    const invalid = [attempt, control].some(
      (a) =>
        !a ||
        a.inputHash !== input.hash ||
        a.status !== "complete" ||
        incompleteFormation(a.detail) ||
        !a.forecast ||
        !Number.isFinite(a.forecast.mean) ||
        !Number.isFinite(a.forecast.sd) ||
        a.forecast.sd <= 0 ||
        !Number.isFinite(Date.parse(a.completedAt)) ||
        !Number.isFinite(Date.parse(a.startedAt)) ||
        Date.parse(a.startedAt) < Date.parse(input.capturedAt) ||
        Date.parse(a.completedAt) < Date.parse(a.startedAt) ||
        Date.parse(a.completedAt) >= Date.parse(input.round.lock_at),
    );
    if (invalid || !last) {
      scores.push({
        ...base,
        status: "invalid",
        reason: "missing, failed, late or mismatched paired attempt",
      });
      continue;
    }
    if (
      typeof resolution.value !== "number" ||
      !Number.isFinite(resolution.value) ||
      !resolution.resolved_at ||
      Date.parse(resolution.resolved_at) > Date.parse(asOf)
    ) {
      scores.push(base);
      continue;
    }
    if (
      !Number.isFinite(Date.parse(resolution.resolved_at)) ||
      Date.parse(resolution.resolved_at) <=
        Math.max(Date.parse(attempt.completedAt), Date.parse(input.round.lock_at))
    ) {
      scores.push({
        ...base,
        status: "invalid",
        reason: "outcome was already available or has invalid availability",
      });
      continue;
    }
    const persistenceCrps = crpsNormal(last.value, PERSISTENCE_SD, resolution.value);
    const own = skill(
      crpsNormal(attempt.forecast!.mean, attempt.forecast!.sd, resolution.value),
      persistenceCrps,
    );
    const ref = skill(
      crpsNormal(control!.forecast!.mean, control!.forecast!.sd, resolution.value),
      persistenceCrps,
    );
    scores.push({
      ...base,
      status: "resolved",
      gain: own - ref,
      skill: own,
      controlSkill: ref,
      meanError: attempt.forecast!.mean - resolution.value,
      covered80:
        Math.abs(attempt.forecast!.mean - resolution.value) <= 1.281552 * attempt.forecast!.sd,
    });
    if (attempt.raw) {
      const start = arm === "A" || arm === "C" ? input.starts.control : input.starts.projected;
      const anchor = start.origins?.[input.round.series ?? ""]?.reading.date ?? last.date;
      observations.push({
        roundId: input.round.round_id,
        variant: experimentVariant(input, arm),
        family: input.round.tracker,
        unit: input.round.unit ?? "points",
        asOf: attempt.completedAt,
        lockAt: input.round.lock_at,
        availableAt: resolution.resolved_at,
        forecast: attempt.raw,
        outcome: resolution.value,
        persistenceCrps,
        horizon: horizonDays(anchor, input.round.release_at),
        sourceAge: horizonDays(anchor, input.capturedAt),
      });
    }
  }
  return { scores, calibrationObservations: observations };
}

/** Conservative existing 12 / 8 / 4 gate, with entire lock waves held out. */
export function qualifyResearchExperiments(scores: ExperimentScore[]) {
  const groups = new Map<string, ExperimentScore[]>();
  for (const s of scores) {
    const rows = groups.get(s.cohort) ?? [];
    if (rows.some((r) => r.roundId === s.roundId))
      throw new Error("duplicate round in qualification cohort");
    rows.push(s);
    groups.set(s.cohort, rows);
  }
  return [...groups].map(([cohort, rows]) => {
    const resolved = rows.filter((r) => r.status === "resolved");
    const waves = [...new Set(resolved.map((r) => r.lockAt))].sort();
    const held = new Set(waves.slice(-Math.max(1, Math.ceil(waves.length / 3))));
    const discovery = resolved.filter((r) => !held.has(r.lockAt));
    const holdout = resolved.filter((r) => held.has(r.lockAt));
    const mean = (xs: ExperimentScore[]) =>
      xs.length ? xs.reduce((s, x) => s + x.gain!, 0) / xs.length : null;
    const reasons = [];
    if (rows.some((r) => r.status === "invalid"))
      reasons.push("invalid or failed attempts retained");
    if (resolved.length < 12 || discovery.length < 8 || holdout.length < 4 || waves.length < 2)
      reasons.push(
        "need 12 distinct resolved rounds with 8 discovery and 4 later holdout rounds in whole waves",
      );
    if ((mean(discovery) ?? -Infinity) < 0) reasons.push("discovery does not improve");
    if ((mean(holdout) ?? -Infinity) < 0.02 || holdout.some((r) => r.gain! < 0))
      reasons.push("holdout needs two skill points average improvement and no losing question");
    return {
      cohort,
      attempted: rows.length,
      resolved: resolved.length,
      discoveryGain: mean(discovery),
      holdoutGain: mean(holdout),
      economics: rows.filter((r) => /econ/.test(r.series)),
      reasons,
      status: reasons.length ? "retain-current-strategy" : "eligible-for-review",
    };
  });
}
