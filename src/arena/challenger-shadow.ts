// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { getErrorMessage } from "../engine/errors";
import { type CovariateVintage, localLevel } from "../forecast/numeric";
import {
  type PopulationScenario,
  type PopulationStratum,
  populationScenario,
} from "../forecast/population";
import type { ArenaShadowRow } from "../persistence/db-arena";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import { evidenceHash } from "../research/evidence";
import { type MeasurementIdentity, normalizeIdentity } from "../research/measurement";
import { type AttentionEvent, trendsChallenger, wikipediaChallenger } from "./attention";
import type { ArenaData } from "./data";
import { outcomePublicBeforeLock, scoreShadow } from "./evaluate";
import { forecastRound, horizonSteps, type RoundForecast } from "./forecast";
import { requireFreshForecast } from "./freshness";
import { forecastAnswer } from "./portfolio";
import { arenaEvidenceTarget } from "./research/briefs";
import {
  nowcastForecaster,
  trendsBasketHistory,
  wikitopObservations,
} from "./research/civiqs-nowcast";
import { type ReadingVintage, revisionInventory } from "./revision-inventory";
import { crpsNormal } from "./score";
import { validateForecastBody } from "./submit";
import {
  DEFAULT_TABH2O_OPTIONS,
  lockSeries,
  type TabPredict,
  tabh2oForecastRound,
} from "./tabh2o-forecaster";
import type { CalibrationObservation } from "./uncertainty";

export interface ChallengerOptions {
  kind: "attention" | "numeric" | "uncertainty" | "population";
  entrant?: string;
  events?: AttentionEvent[];
  covariates?: CovariateVintage[];
  predict?: TabPredict;
  population?: {
    target: MeasurementIdentity;
    strata: PopulationStratum[];
    scenario: PopulationScenario;
    priorShare: number;
    priorStrength: number;
    commonSd: number;
  };
  now?: () => number;
}

/** One common frozen input, declared candidates, every failure retained. These
 * forecasts use the existing shadow/scoring ledger; this API cannot submit. */
export async function recordChallengers(
  store: ArenaStore,
  source: ArenaData,
  roundId: string,
  opts: ChallengerOptions,
) {
  const now = opts.now ?? Date.now;
  const data = source.frozen();
  const round = await data.round(roundId);
  if (!round || now() >= Date.parse(round.lock_at) - 300_000)
    throw new Error("unknown round or less than five minutes before lock");
  let lock = await data.lock(roundId);
  if (round.tracker === "google_trends") {
    const history = await trendsBasketHistory(data, round, true);
    if (history) lock = { ...lock, answer_history_by_cell: history };
  }
  if (round.tracker === "wikipedia")
    lock = { ...lock, answer_obs: await wikitopObservations(data, round) };
  let start: RoundForecast = await nowcastForecaster(data, forecastRound)(round, lock);
  let estimator = "nowcast-v1";
  if (opts.kind === "uncertainty") {
    if (!opts.entrant) throw new Error("uncertainty requires an entrant's accepted final forecast");
    const accepted = store.acceptedArenaSubmission(opts.entrant, roundId);
    if (!accepted) throw new Error("no accepted forecast to compare");
    const detail = JSON.parse(accepted.detail);
    const body = JSON.parse(accepted.body);
    if (
      !detail.forecast?.topline ||
      !detail.config?.fingerprint ||
      detail.forecast.fallback ||
      detail.forecast.rounds?.some((step: { status: string }) => step.status !== "ok") ||
      detail.forecast.dossier?.status === "failed" ||
      detail.forecast.dossier?.error ||
      detail.forecast.dossier?.researchLoop?.costFinal === false ||
      body.topline?.mean !== detail.forecast.topline.mean ||
      body.topline?.sd !== detail.forecast.topline.sd
    )
      throw new Error("no complete final-estimator trace");
    start = detail.forecast;
    estimator = detail.config.fingerprint;
  }
  const capturedAt = new Date(now()).toISOString();
  requireFreshForecast(round, lock, start, capturedAt);
  const candidates = new Map<string, () => RoundForecast | Promise<RoundForecast>>([
    ["control", () => structuredClone(start)],
  ]);
  if (opts.kind === "attention") {
    if (round.tracker === "google_trends") {
      candidates.set("recency", () =>
        trendsChallenger(round, lock, start, { asOf: capturedAt, seasonalWeight: 0 }),
      );
      candidates.set("seasonal", () =>
        trendsChallenger(round, lock, start, {
          asOf: capturedAt,
          seasonalWeight: 0.5,
          partialWeight: 0.3,
          availableAt: capturedAt,
        }),
      );
      if (opts.events?.length)
        candidates.set("event-seasonal", () =>
          trendsChallenger(round, lock, start, {
            asOf: capturedAt,
            seasonalWeight: 0.5,
            partialWeight: 0.3,
            availableAt: capturedAt,
            events: opts.events,
          }),
        );
    } else if (round.tracker === "wikipedia")
      candidates.set("trajectory", () =>
        wikipediaChallenger(round, lock, start, { asOf: capturedAt, events: opts.events }),
      );
    else throw new Error("attention requires a Trends or Wikipedia round");
  } else if (opts.kind === "numeric") {
    if (!start.topline) throw new Error("numeric comparison requires a scalar round");
    const points =
      (round.series ? start.origins?.[round.series]?.daily : undefined) ??
      lock.answer_history ??
      lock.history ??
      [];
    for (const alpha of [0.25, 0.5])
      candidates.set(`local-level-${alpha}`, () => ({
        ...start,
        topline: localLevel(
          points,
          horizonSteps(points, round.release_at),
          start.topline!.sd,
          alpha,
        ),
        note: "Local-level challenger; shadow only",
      }));
    if (opts.predict)
      candidates.set("tabh2o-covariates", () =>
        tabh2oForecastRound(
          round,
          lock,
          start,
          { mode: "regression", nowcast: false },
          {
            predict: opts.predict!,
            seriesFor: async () =>
              lockSeries(round, { ...lock, answer_history: points })?.map((s) => ({
                ...s,
                covariates: opts.covariates,
                asOf: capturedAt,
              })),
          },
          DEFAULT_TABH2O_OPTIONS,
        ),
      );
  } else if (opts.kind === "uncertainty") {
    if (!start.topline) throw new Error("uncertainty comparison requires a scalar round");
    for (const scale of [0.65, 0.8, 1.25, 1.5])
      candidates.set(`sd-scale-${scale}`, () => ({
        ...start,
        topline: { mean: start.topline!.mean, sd: start.topline!.sd * scale },
      }));
    // Floors are declared in the target's own units, never inferred from judge confidence.
    if (round.tracker === "civiqs")
      for (const floor of [0.25, 0.5])
        candidates.set(`sd-floor-${floor}`, () => ({
          ...start,
          topline: { mean: start.topline!.mean, sd: Math.max(floor, start.topline!.sd) },
        }));
  } else if (opts.kind === "population") {
    if (!opts.population || !start.topline)
      throw new Error("population comparison needs measured strata and a scalar target");
    const p = opts.population;
    candidates.set(`simulation-${p.scenario.id}`, () => {
      const target = arenaEvidenceTarget(round);
      if (
        target.unit !== "percent" ||
        !target.population ||
        !target.response ||
        !p.target ||
        ["measure", "unit", "population", "response", "subgroup"].some((field) => {
          const key = field as keyof MeasurementIdentity;
          return normalizeIdentity(p.target[key] ?? "") !== normalizeIdentity(target[key] ?? "");
        }) ||
        p.strata.some(
          (s) => normalizeIdentity(s.population) !== normalizeIdentity(target.population!),
        )
      )
        throw new Error("population scenario identity does not match the arena target");
      const simulation = populationScenario(p.strata, p.scenario, {
        asOf: capturedAt,
        priorShare: p.priorShare,
        priorStrength: p.priorStrength,
        commonSd: p.commonSd,
      });
      return {
        ...start,
        topline: simulation.topline,
        note: `Population simulation ${simulation.scenario}; unqualified shadow`,
        simulation,
      };
    });
  }
  const batchId = randomUUID();
  const inputs = {
    round,
    lock,
    start,
    estimator,
    capturedAt,
    events: opts.events,
    covariates: opts.covariates,
    population: opts.population,
  };
  const inputHash = evidenceHash(inputs);
  const policy = {
    version: 1,
    kind: opts.kind,
    estimator,
    candidates: [...candidates.keys()],
    covariates: [...new Set(opts.covariates?.map((c) => c.name) ?? [])].sort(),
    ...(opts.population
      ? {
          population: {
            target: opts.population.target,
            priorStrength: opts.population.priorStrength,
            commonSd: opts.population.commonSd,
            scenario: opts.population.scenario.id,
          },
        }
      : {}),
  };
  const attempts = [];
  for (const [candidate, run] of candidates) {
    let forecast: RoundForecast | undefined;
    let error: string | undefined;
    try {
      if (now() >= Date.parse(round.lock_at)) throw new Error("comparison passed lock");
      forecast = await run();
      const invalid = validateForecastBody(round, {
        round_id: roundId,
        entrant: "shadow",
        ...forecastAnswer(forecast),
      });
      const fallback = (forecast as { fallback?: string }).fallback;
      if (invalid || fallback) throw new Error(invalid ?? fallback);
      if (now() >= Date.parse(round.lock_at)) throw new Error("candidate completed after lock");
    } catch (e) {
      error = getErrorMessage(e);
    }
    const attempt = {
      candidate,
      status: error ? "failed" : "complete",
      completedAt: new Date(now()).toISOString(),
      error,
      forecast,
    };
    const costUsd = (forecast as { costUsd?: number } | undefined)?.costUsd ?? 0;
    store.recordArenaShadow({
      roundId,
      forecaster: `challenger-v1#${evidenceHash(policy)}:${candidate}`,
      forecast: JSON.stringify(!error && forecast ? forecastAnswer(forecast) : {}),
      detail: JSON.stringify({ challenger: { batchId, inputHash, inputs, policy, ...attempt } }),
      costUsd,
    });
    attempts.push(attempt);
  }
  return { batchId, inputHash, policy, attempts, promotion: "none" };
}

/** Latest WHOLE batch per configuration/round, never the luckiest candidate from
 * different batches. Failures and missing writes remain denominators in the audit. */
export async function scoreChallengers(data: ArenaData, rows: ArenaShadowRow[], asOf?: string) {
  data = data.frozen();
  if (asOf && !Number.isFinite(Date.parse(asOf))) throw new Error("invalid scoring cutoff");
  type Stored = {
    batchId: string;
    inputHash: string;
    inputs: {
      round: import("./types").ArenaRound;
      lock: import("./types").ArenaLock;
      start: RoundForecast;
      estimator: string;
      capturedAt: string;
    };
    policy: { candidates: string[]; kind: string };
    candidate: string;
    status: string;
    error?: string;
    completedAt: string;
  };
  const batches = new Map<
    string,
    { lastId: number; batchId: string; records: Array<{ row: ArenaShadowRow; stored: Stored }> }
  >();
  const invalid: Array<{ id: number; error: string }> = [];
  for (const row of rows) {
    if (!row.forecaster.startsWith("challenger-v1#")) continue;
    try {
      const stored = JSON.parse(row.detail).challenger as Stored;
      if (
        !stored ||
        stored.inputHash !== evidenceHash(stored.inputs) ||
        stored.inputs.round.round_id !== row.round_id ||
        !Array.isArray(stored.policy.candidates) ||
        !stored.policy.candidates.includes(stored.candidate) ||
        !Number.isFinite(Date.parse(stored.inputs.round.lock_at)) ||
        (stored.status === "complete" &&
          validateForecastBody(stored.inputs.round, {
            ...JSON.parse(row.forecast),
            round_id: row.round_id,
            entrant: "shadow",
          })) ||
        row.forecaster !== `challenger-v1#${evidenceHash(stored.policy)}:${stored.candidate}`
      )
        throw new Error("invalid challenger evidence");
      const key = JSON.stringify([row.round_id, evidenceHash(stored.policy)]);
      const previous = batches.get(key);
      if (!previous || (previous.batchId !== stored.batchId && row.id > previous.lastId))
        batches.set(key, { lastId: row.id, batchId: stored.batchId, records: [{ row, stored }] });
      else if (previous.batchId === stored.batchId) {
        if (
          previous.records.some(
            (r) =>
              r.stored.inputHash !== stored.inputHash || r.stored.candidate === stored.candidate,
          )
        )
          throw new Error("inconsistent or duplicate candidate in comparison batch");
        previous.records.push({ row, stored });
        previous.lastId = Math.max(previous.lastId, row.id);
      }
    } catch (error) {
      invalid.push({ id: row.id, error: getErrorMessage(error) });
    }
  }
  const resolutions = await data.resolutions();
  const site = [...batches.values()].some(
    (batch) => batch.records[0]!.stored.inputs.round.target_type !== "continuous_normal",
  )
    ? await data.siteRounds()
    : [];
  const observedAt = new Date().toISOString();
  asOf ??= observedAt;
  const comparisons = [];
  const calibrationObservations: CalibrationObservation[] = [];
  const vintages: ReadingVintage[] = [];
  for (const batch of batches.values()) {
    const shared = batch.records[0]!.stored;
    const { round, start, lock } = shared.inputs;
    const resolution = resolutions[round.round_id];
    const status = (record: (typeof batch.records)[number] | undefined) => {
      if (!record) return "missing";
      const c = record.stored;
      if (c.status !== "complete") return "failed";
      if (
        ![c.completedAt, c.inputs.capturedAt].every((t) => Number.isFinite(Date.parse(t))) ||
        Date.parse(c.inputs.capturedAt) > Date.parse(c.completedAt) ||
        Date.parse(c.completedAt) >= Date.parse(round.lock_at) ||
        record.row.created_at >= Date.parse(round.lock_at)
      )
        return "ineligible";
      if (resolution && outcomePublicBeforeLock(round, resolution.observed_date))
        return "ineligible";
      if (
        resolution?.resolved_at &&
        Date.parse(resolution.resolved_at) <= Date.parse(round.lock_at)
      )
        return "ineligible";
      if (Date.parse(asOf!) <= Date.parse(round.lock_at)) return "unresolved";
      if (round.target_type !== "continuous_normal")
        return Date.parse(asOf!) < Date.parse(observedAt) ||
          site.find((s) => s.round_id === round.round_id)?.status !== "resolved"
          ? "unresolved"
          : "resolved";
      if (!resolution?.resolved_at || Date.parse(resolution.resolved_at) >= Date.parse(asOf!))
        return "unresolved";
      return "resolved";
    };
    const valid = batch.records.filter((r) => status(r) === "resolved");
    const scores = await scoreShadow(
      data,
      valid.map((r) => r.row),
    );
    const control = batch.records.find((r) => r.stored.candidate === "control");
    const controlScore = control && scores.find((s) => s.forecaster === control.row.forecaster);
    for (const candidate of shared.policy.candidates) {
      const record = batch.records.find((r) => r.stored.candidate === candidate);
      const scored = record && scores.find((s) => s.forecaster === record.row.forecaster);
      comparisons.push({
        roundId: round.round_id,
        tracker: round.tracker,
        lockAt: round.lock_at,
        batchId: batch.batchId,
        policy: evidenceHash(shared.policy),
        candidate,
        status: status(record) === "resolved" && !scored ? "unscorable" : status(record),
        error: record?.stored.error,
        controlSkill: controlScore?.skill,
        skill: scored?.skill,
        loss: scored?.loss,
        persistenceLoss: scored?.persistenceLoss,
        metric: scored?.metric,
        improvement: controlScore && scored ? scored.skill - controlScore.skill : undefined,
        costUsd: record?.row.cost_usd,
      });
    }
    if (
      control &&
      status(control) === "resolved" &&
      start.topline &&
      typeof resolution?.value === "number" &&
      resolution.resolved_at &&
      Date.parse(resolution.resolved_at) > Date.parse(round.lock_at)
    ) {
      const reading = round.series ? start.origins?.[round.series]?.reading : undefined;
      const anchor = (lock.answer_history ?? lock.history)?.at(-1);
      if (anchor)
        calibrationObservations.push({
          roundId: round.round_id,
          variant: shared.inputs.estimator,
          family: round.tracker,
          unit: round.unit ?? "unspecified",
          asOf: shared.inputs.capturedAt,
          lockAt: round.lock_at,
          availableAt: resolution.resolved_at,
          horizon: Math.max(
            0,
            (Date.parse(round.release_at) - Date.parse(reading?.date ?? anchor.date)) / 86_400_000,
          ),
          sourceAge: Math.max(
            0,
            (Date.parse(shared.inputs.capturedAt) - Date.parse(reading?.date ?? anchor.date)) /
              86_400_000,
          ),
          forecast: start.topline,
          outcome: resolution.value,
          persistenceCrps: crpsNormal(anchor.value, 1.5, resolution.value),
        });
    }
    for (const [series, origin] of Object.entries(start.origins ?? {}))
      if (origin.fetchedAt && origin.source)
        for (const point of origin.daily ?? [origin.reading])
          vintages.push({ series, ...point, availableAt: origin.fetchedAt, source: origin.source });
  }
  const groups = new Map<string, typeof comparisons>();
  for (const c of comparisons) {
    const key = JSON.stringify([c.policy, c.tracker, c.candidate]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const summaries = [...groups.values()].map((group) => {
    const paired = group.filter(
      (r) => r.improvement !== undefined && Number.isFinite(r.improvement),
    );
    return {
      policy: group[0]!.policy,
      tracker: group[0]!.tracker,
      candidate: group[0]!.candidate,
      attempts: group.length,
      paired: paired.length,
      status: Object.fromEntries(
        [...new Set(group.map((r) => r.status))].map((s) => [
          s,
          group.filter((r) => r.status === s).length,
        ]),
      ),
      meanImprovement: paired.length
        ? paired.reduce((s, r) => s + r.improvement!, 0) / paired.length
        : undefined,
      costUsd: group.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    };
  });
  return {
    comparisons,
    summaries,
    invalid,
    calibrationObservations,
    revisions: revisionInventory(vintages, asOf),
    promotion: "none",
    note: "Prospective shadows only; inspect failed/missing attempts and use chronological matched-estimator qualification before changing routes.",
  };
}
