// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { getErrorMessage } from "../engine/errors";
import type { ArenaShadowRow } from "../persistence/db-arena";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import type { ArenaData } from "./data";
import { outcomePublicBeforeLock } from "./evaluate";
import { forecastRound, PERSISTENCE_SD, type RoundForecast } from "./forecast";
import { forecastSettings } from "./forecast-config";
import { buildDossier, type ResearchDossier } from "./formations";
import { auditForecastInputs } from "./input-audit";
import { horizonDays, horizonOptionsFromEnv } from "./research/civiqs-horizon";
import { type LiveCiviqs, nowcastForecaster } from "./research/civiqs-nowcast";
import { arenaResearchLookups, withDataLookups } from "./research/data-evidence";
import { retrieverFromSpec, withProvidedText } from "./research/retrieve";
import { crpsNormal, skill } from "./score";
import { type FormationInputs, forecasterFor, lockForModels } from "./service";
import type { ArenaLock, ArenaRound, Distribution } from "./types";
import {
  type CalibrationContext,
  type CalibrationObservation,
  calibrateUncertainty,
} from "./uncertainty";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CANDIDATES = ["start", "delphi", "fred", "calibrated"] as const;
type Candidate = (typeof CANDIDATES)[number];

interface SharedInputs {
  round: ArenaRound;
  lock: ArenaLock;
  start: RoundForecast;
  dossier: ResearchDossier;
  context: CalibrationContext;
}
interface Comparison {
  version: 1;
  id: string;
  candidate: Candidate;
  inputHash: string;
  completedAt: string;
  shared: SharedInputs;
  error?: string;
}
function comparison(row: ArenaShadowRow): Comparison | undefined {
  try {
    const c = JSON.parse(row.detail).comparison as Comparison | undefined;
    return c?.version === 1 &&
      CANDIDATES.includes(c.candidate) &&
      c.shared?.context &&
      c.shared.round?.round_id === row.round_id &&
      c.inputHash === digest(c.shared)
      ? c
      : undefined;
  } catch {
    return undefined; // Historical non-comparison rows cannot establish paired evidence.
  }
}

/** Only prospectively recorded, resolved errors of this exact final estimator. */
export async function calibrationHistory(data: ArenaData, rows: ArenaShadowRow[]) {
  const resolutions = await data.resolutions();
  const out: CalibrationObservation[] = [];
  for (const row of rows) {
    const c = comparison(row);
    if (c?.candidate !== "fred" || c.error || row.created_at >= Date.parse(c.shared.round.lock_at))
      continue;
    const r = resolutions[row.round_id];
    if (
      !r?.resolved_at ||
      typeof r.value !== "number" ||
      outcomePublicBeforeLock(c.shared.round, r.observed_date)
    )
      continue;
    const forecast = (JSON.parse(row.forecast) as { topline?: Distribution }).topline;
    const last = (c.shared.lock.answer_history ?? c.shared.lock.history)?.at(-1);
    if (!forecast || !last) continue;
    out.push({
      ...c.shared.context,
      asOf: new Date(row.created_at).toISOString(),
      lockAt: c.shared.round.lock_at,
      availableAt: r.resolved_at,
      forecast,
      outcome: r.value,
      persistenceCrps: crpsNormal(last.value, PERSISTENCE_SD, r.value),
    });
  }
  return out;
}

/**
 * Four candidates, one captured start/lock and one verified FRED dossier. No
 * filings or policy promotion. A failed candidate is retained, so paired scores
 * cannot silently discard its failures and select an easier set of rounds.
 */
export async function recordPairedShadow(
  store: Pick<ArenaStore, "recordArenaShadow" | "listArenaShadow">,
  source: ArenaData,
  roundId: string,
  spec: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    live?: LiveCiviqs;
    /** Deterministic seams for qualification; the production path uses the same formation runner. */
    run?: (inputs: FormationInputs) => Promise<RoundForecast & { costUsd?: number }>;
    dossier?: (shared: {
      round: ArenaRound;
      lock: ArenaLock;
      start: RoundForecast;
    }) => Promise<ResearchDossier>;
  } = {},
) {
  if (!/^formation:delphi:[^+]+$/.test(spec))
    throw new Error(
      "comparison requires a single formation:delphi:<models> without research suffix",
    );
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const data = source.frozen();
  const round = await data.round(roundId);
  if (round?.target_type !== "continuous_normal")
    throw new Error("paired comparison requires a scalar round");
  if (now() >= Date.parse(round.lock_at) - 300_000)
    throw new Error("less than five minutes before lock");
  const lock = await lockForModels(data, round, await data.lock(roundId));
  const audit = auditForecastInputs(round, lock);
  if (!audit.ok) throw new Error(`input audit failed: ${audit.issues.join("; ")}`);
  if (!opts.run) await forecasterFor(spec, { env }); // Validate provider configuration before retrieval.
  const start = await nowcastForecaster(data, forecastRound, {
    live: opts.live,
    daily: 21,
    horizon: horizonOptionsFromEnv(env),
  })(round, lock);
  const dossier = opts.dossier
    ? await opts.dossier({ round, lock, start })
    : await (async () => {
        const research = withProvidedText(
          withDataLookups(
            retrieverFromSpec("closed-book", {}),
            arenaResearchLookups({ ...env, MARINA_ARENA_RESEARCH_LOOKUPS: "fred" }),
          ),
          async () => undefined,
        );
        return buildDossier(round, lock, start, research.retriever, research.pageText);
      })();
  const capturedAt = new Date(now()).toISOString();
  const settings = forecastSettings(spec, {
    ...env,
    MARINA_ARENA_RESEARCH_LOOKUPS: "fred",
    MARINA_ARENA_CIVIQS_LIVE: opts.live ? "on" : "off",
  });
  const variant = `paired-v1:${settings.fingerprint}`;
  const reading = round.series ? start.origins?.[round.series]?.reading : undefined;
  const anchor = reading ?? (lock.answer_history ?? lock.history)!.at(-1)!;
  const context: CalibrationContext = {
    roundId,
    variant,
    family: round.tracker,
    unit: round.unit ?? "unspecified",
    asOf: capturedAt,
    horizon: horizonDays(anchor.date, round.release_at),
    sourceAge: horizonDays(anchor.date, capturedAt),
  };
  const shared: SharedInputs = { round, lock, start, dossier, context };
  const inputHash = digest(shared);
  const id = randomUUID();
  const history = await calibrationHistory(data, store.listArenaShadow({ limit: 2000 }));
  const run = async (withFred: boolean) => {
    const inputs = structuredClone({ roundId, start, lock, ...(withFred ? { dossier } : {}) });
    if (opts.run) return opts.run(inputs);
    const made = await forecasterFor(spec, { env, formationInputs: inputs });
    try {
      return await made.forecaster(round, lock);
    } catch (error) {
      return {
        rules: start.rules,
        note: "comparison candidate failed",
        error: getErrorMessage(error),
        costUsd: made.usage?.costUsd ?? 0,
      };
    }
  };
  const forecasts = new Map<
    Candidate,
    RoundForecast & { costUsd?: number; error?: string; calibration?: unknown }
  >();
  forecasts.set("start", start);
  for (const candidate of ["delphi", "fred"] as const) {
    if (now() >= Date.parse(round.lock_at))
      throw new Error("comparison finished after lock; no candidates recorded");
    try {
      forecasts.set(candidate, await run(candidate === "fred"));
    } catch (error) {
      forecasts.set(candidate, {
        rules: start.rules,
        note: "comparison candidate failed",
        error: getErrorMessage(error),
      });
    }
  }
  const raw = forecasts.get("fred")!;
  if (raw.topline) {
    const calibration = calibrateUncertainty(raw.topline, context, history);
    forecasts.set("calibrated", { ...raw, topline: calibration.forecast, calibration, costUsd: 0 });
  } else
    forecasts.set("calibrated", {
      rules: start.rules,
      note: "no complete forecast to calibrate",
      error: raw.error ?? "missing topline",
    });
  if (now() >= Date.parse(round.lock_at))
    throw new Error("comparison finished after lock; no candidates recorded");
  const completedAt = new Date(now()).toISOString();
  return CANDIDATES.map((candidate) => {
    const f = forecasts.get(candidate)!;
    const error =
      f.error ??
      (!f.topline ||
      !Number.isFinite(f.topline.mean) ||
      !Number.isFinite(f.topline.sd) ||
      f.topline.sd <= 0
        ? "missing or invalid topline"
        : undefined);
    const c: Comparison = {
      version: 1,
      id,
      candidate,
      inputHash,
      completedAt,
      shared,
      ...(error ? { error } : {}),
    };
    const recorded = store.recordArenaShadow({
      roundId,
      forecaster: `paired:${candidate}#${settings.fingerprint.slice(0, 16)}`,
      forecast: JSON.stringify({ topline: f.topline }),
      detail: JSON.stringify({
        ...f,
        comparison: c,
        settings,
        audit,
        ...(candidate === "calibrated" ? { reusedFrom: "fred" } : {}),
      }),
      costUsd: f.costUsd ?? 0,
    });
    return {
      candidate,
      recorded,
      error,
      topline: f.topline,
      costUsd: f.costUsd ?? 0,
      calibration: f.calibration,
      inputHash,
      id,
    };
  });
}

/** Matched scalar scores, latest batch per round/config; incomplete batches are explicit. */
export async function scorePairedShadows(data: ArenaData, rows: ArenaShadowRow[]) {
  const resolutions = await data.resolutions();
  const batches = new Map<string, Array<{ row: ArenaShadowRow; c: Comparison }>>();
  for (const row of rows) {
    const c = comparison(row);
    if (!c) continue;
    const batch = batches.get(c.id) ?? [];
    batch.push({ row, c });
    batches.set(c.id, batch);
  }
  const latest = new Map<string, Array<{ row: ArenaShadowRow; c: Comparison }>>();
  for (const batch of batches.values()) {
    const { c } = batch[0]!;
    if (batch.some(({ row }) => row.created_at >= Date.parse(c.shared.round.lock_at))) continue;
    const key = `${c.shared.context.roundId}/${c.shared.context.variant}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(previous[0]!.c.completedAt) < Date.parse(c.completedAt))
      latest.set(key, batch);
  }
  return [...latest.values()].map((batch) => {
    const c = batch[0]!.c;
    const resolution = resolutions[c.shared.round.round_id];
    const complete =
      batch.length === CANDIDATES.length &&
      CANDIDATES.every((name) =>
        batch.some((b) => b.c.candidate === name && !b.c.error && b.c.inputHash === c.inputHash),
      );
    const eligible =
      complete &&
      resolution?.value !== undefined &&
      !outcomePublicBeforeLock(c.shared.round, resolution.observed_date);
    const anchor = (c.shared.lock.answer_history ?? c.shared.lock.history)?.at(-1);
    const baseline =
      anchor && resolution?.value !== undefined
        ? crpsNormal(anchor.value, PERSISTENCE_SD, resolution.value)
        : undefined;
    return {
      roundId: c.shared.round.round_id,
      id: c.id,
      variant: c.shared.context.variant,
      complete,
      resolved: resolution?.value !== undefined,
      eligible,
      results: Object.fromEntries(
        batch.map(({ row, c: entry }) => {
          const f = JSON.parse(row.forecast) as { topline?: Distribution };
          const detail = JSON.parse(row.detail);
          return [
            entry.candidate,
            {
              error: entry.error,
              fallback: detail.fallback,
              modelCalls: entry.candidate === "calibrated" ? 0 : (detail.rounds?.length ?? 0),
              failedProposals:
                detail.rounds?.filter((step: { status: string }) => step.status !== "ok").length ??
                0,
              costUsd: row.cost_usd,
              topline: f.topline,
              ...(eligible && baseline !== undefined && f.topline
                ? {
                    skill: skill(
                      crpsNormal(f.topline.mean, f.topline.sd, resolution!.value!),
                      baseline,
                    ),
                  }
                : {}),
            },
          ];
        }),
      ),
    };
  });
}
