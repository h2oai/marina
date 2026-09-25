// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A model as the arena forecaster's backend (`MARINA_ARENA_FORECASTER=model:<provider/model>`).
 *
 * The model never forecasts from nothing: it is shown the question, the frozen
 * history and the calibrated baseline, and asked for a distribution. Its answer
 * is then SHRUNK toward the baseline (`MARINA_ARENA_MODEL_WEIGHT`, default 0.5)
 * and discarded outright when it is malformed or implausibly far from it — the
 * arena shows that raw model forecasts lose to persistence mostly through a few
 * large misses, and the baseline is what caps them. Closed-book: the prompt
 * carries only what the round froze; no web.
 */

import type { RoundForecast } from "./forecast";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

export type Complete = (system: string, user: string) => Promise<string>;

export interface ModelForecasterOptions {
  /** Share of the model's move from the baseline that is kept (0 = baseline, 1 = raw model). */
  weight: number;
  /** A model mean further than this many baseline sds from it is treated as a blowup. */
  maxSdMove: number;
}

export const DEFAULT_MODEL_OPTIONS: ModelForecasterOptions = { weight: 0.5, maxSdMove: 4 };

const HISTORY_POINTS = 30;
const CELL_POINTS = 12;

export const SYSTEM_PROMPT = [
  "You forecast published statistics for a live, public forecasting benchmark.",
  "Each forecast is a normal distribution {mean, sd} scored by CRPS against the number when it is published.",
  "The reference is persistence (the last published value). A baseline is given: persistence's mean with a spread sized to how this series moves.",
  "Start from the baseline. Move the mean only for a concrete reason visible in the data: a sustained trend, mean reversion after an outlier, a seasonal or calendar pattern, or a scheduled event you are confident about.",
  "Size sd to the error you would honestly expect at this horizon — too narrow is punished hard, too wide wastes skill.",
  "Reply with ONE JSON object and nothing else.",
].join(" ");

function formatHistory(points: ArenaPoint[], n: number): string {
  return points
    .slice(-n)
    .map((p) => `${p.date} ${p.value}`)
    .join("\n");
}

export function buildPrompt(round: ArenaRound, lock: ArenaLock, baseline: RoundForecast): string {
  const head = [
    `Question: ${round.question}`,
    `Unit: ${round.unit ?? "(see question)"}`,
    `The answer is published around ${round.release_at}; forecasts lock at ${round.lock_at}.`,
  ];
  if (round.target_type === "continuous_normal") {
    const history = lock.answer_history ?? lock.history ?? [];
    return [
      ...head,
      "",
      `Recent history (date value), oldest first:\n${formatHistory(history, HISTORY_POINTS)}`,
      "",
      `Baseline: ${JSON.stringify(baseline.topline)}`,
      'Reply: {"mean": <number>, "sd": <number > 0>, "reason": "<one sentence>"}',
    ].join("\n");
  }
  if (round.target_type === "profile_energy") {
    const cells = (round.cells ?? []).map((c) => {
      const h = lock.answer_history_by_cell?.[c] ?? [];
      return `${c}: ${h
        .slice(-CELL_POINTS)
        .map((p) => p.value)
        .join(", ")} | baseline ${JSON.stringify(baseline.profile?.[c])}`;
    });
    return [
      ...head,
      "",
      `Each cell's last ${CELL_POINTS} values, oldest first, then its baseline:`,
      ...cells,
      "",
      'Reply: {"profile": {"<cell>": {"mean": <number>, "sd": <number > 0>}, …every cell…}, "reason": "<one sentence>"}',
    ].join("\n");
  }
  const days = [...(lock.answer_obs ?? [])].slice(-7).map((d) => {
    const top = d.items.slice(0, 15).map((t) => `${t}${d.views?.[t] ? ` (${d.views[t]})` : ""}`);
    return `${d.date}: ${top.join(", ")}`;
  });
  const length = round.ranking?.length ?? 10;
  return [
    ...head,
    "",
    "Recent daily top lists (title (views)):",
    ...days,
    "",
    `Baseline ranking: ${JSON.stringify(baseline.ranking)}`,
    `Reply: {"ranking": [exactly ${length} distinct article titles in canonical underscore form, rank 1 first], "reason": "<one sentence>"}`,
  ].join("\n");
}

/** The first JSON object in a reply (tolerates code fences and prose around it). */
export function parseReply(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function asDist(v: unknown): Distribution | undefined {
  const d = v as { mean?: unknown; sd?: unknown };
  const mean = Number(d?.mean);
  const sd = Number(d?.sd);
  return Number.isFinite(mean) && Number.isFinite(sd) && sd > 0 ? { mean, sd } : undefined;
}

/** Shrink toward the baseline; undefined when the model's answer is a blowup. */
export function blend(
  base: Distribution,
  model: Distribution,
  opts: ModelForecasterOptions,
): Distribution | undefined {
  if (Math.abs(model.mean - base.mean) > opts.maxSdMove * base.sd) return undefined;
  const w = Math.min(Math.max(opts.weight, 0), 1);
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    mean: round3(base.mean + w * (model.mean - base.mean)),
    sd: round3(Math.max(base.sd * 0.5, (1 - w) * base.sd + w * model.sd)),
  };
}

export interface ModelRoundForecast extends RoundForecast {
  /** What the model itself answered (before shrinkage), for shadow scoring. */
  raw?: { topline?: Distribution; profile?: Record<string, Distribution>; ranking?: string[] };
  /** Why the baseline was kept instead, if it was. */
  fallback?: string;
  reason?: string;
}

export async function modelForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  baseline: RoundForecast,
  complete: Complete,
  opts: ModelForecasterOptions = DEFAULT_MODEL_OPTIONS,
  label = "model",
): Promise<ModelRoundForecast> {
  const keep = (why: string): ModelRoundForecast => ({ ...baseline, fallback: why });
  let reply: Record<string, unknown> | undefined;
  try {
    reply = parseReply(await complete(SYSTEM_PROMPT, buildPrompt(round, lock, baseline)));
  } catch (err) {
    return keep(`model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!reply) return keep("model reply had no JSON object");
  const reason = typeof reply.reason === "string" ? reply.reason.slice(0, 300) : undefined;
  const note = `marina ${label}, weight ${opts.weight} on its move from the calibrated baseline`;

  if (round.target_type === "continuous_normal") {
    const raw = asDist(reply);
    if (!raw || !baseline.topline) return keep("model reply was not a valid {mean, sd}");
    const topline = blend(baseline.topline, raw, opts);
    if (!topline)
      return { ...keep("model mean implausibly far from the baseline"), raw: { topline: raw } };
    return { ...baseline, topline, raw: { topline: raw }, note, ...(reason ? { reason } : {}) };
  }
  if (round.target_type === "profile_energy") {
    const cells = round.cells ?? [];
    const got = (reply.profile ?? {}) as Record<string, unknown>;
    const raw: Record<string, Distribution> = {};
    const profile: Record<string, Distribution> = {};
    for (const c of cells) {
      const d = asDist(got[c]);
      const base = baseline.profile?.[c];
      if (!d || !base) return keep(`model reply missing a valid cell ${c}`);
      raw[c] = d;
      // A blown-up cell keeps its baseline; the rest of the profile still moves.
      profile[c] = blend(base, d, opts) ?? base;
    }
    return { ...baseline, profile, raw: { profile: raw }, note, ...(reason ? { reason } : {}) };
  }
  const length = round.ranking?.length ?? 10;
  const ranking = Array.isArray(reply.ranking) ? reply.ranking.map(String) : [];
  const allowed = round.ranking?.items;
  if (
    ranking.length !== length ||
    new Set(ranking).size !== length ||
    (allowed && ranking.some((t) => !allowed.includes(t)))
  ) {
    return keep(`model ranking was not ${length} distinct valid titles`);
  }
  return { ...baseline, ranking, raw: { ranking }, note, ...(reason ? { reason } : {}) };
}
