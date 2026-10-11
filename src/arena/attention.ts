// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { availableInstant } from "../research/measurement";
import { forecastRanking, type RoundForecast } from "./forecast";
import { auditForecastInputs } from "./input-audit";
import type { ArenaLock, ArenaRound } from "./types";

/** Explicit scenario effects, not observed outcomes or inferred judge probabilities. */
export interface AttentionEvent {
  item: string;
  startsAt: string;
  endsAt: string;
  knownAt: string;
  source: string;
  multiplier: number;
}

function eventFactor(events: AttentionEvent[], item: string, targetAt: string, asOf: string) {
  let factor = 1;
  for (const event of events) {
    if (
      ![event.knownAt, event.startsAt, event.endsAt].every(
        (d) => availableInstant(d) !== undefined,
      ) ||
      Date.parse(event.startsAt) > Date.parse(event.endsAt) ||
      !event.source ||
      !Number.isFinite(event.multiplier) ||
      event.multiplier <= 0 ||
      event.multiplier > 4
    )
      throw new Error("invalid attention event");
    if (event.item !== item || availableInstant(event.knownAt)! > Date.parse(asOf)) continue;
    if (
      Date.parse(event.startsAt) <= Date.parse(targetAt) &&
      Date.parse(targetAt) <= Date.parse(event.endsAt)
    )
      factor *= event.multiplier;
  }
  return Math.min(4, Math.max(0.25, factor));
}

/** All cells come from the SAME already-audited basket vintage. Means are jointly
 * normalized; marginal SDs retain the baseline until prospective errors qualify.
 */
export function trendsChallenger(
  round: ArenaRound,
  lock: ArenaLock,
  start: RoundForecast,
  opts: {
    asOf: string;
    seasonalWeight: number;
    partialWeight?: number;
    availableAt?: string;
    events?: AttentionEvent[];
  },
) {
  if (round.tracker !== "google_trends" || round.target_type !== "profile_energy" || !start.profile)
    throw new Error("Trends challenger requires a basket profile");
  const audit = auditForecastInputs(round, lock);
  if (!audit.ok) throw new Error(audit.issues.join("; "));
  const { seasonalWeight, partialWeight = 0 } = opts;
  if (
    ![seasonalWeight, partialWeight].every((w) => Number.isFinite(w) && w >= 0 && w <= 1) ||
    seasonalWeight + partialWeight > 1 ||
    !Number.isFinite(Date.parse(opts.asOf)) ||
    Date.parse(opts.asOf) >= Date.parse(round.lock_at)
  )
    throw new Error("invalid Trends policy/cutoff");
  const cells = round.cells!;
  const dates = lock.answer_history_by_cell![cells[0]!]!.map((p) => p.date);
  const target = Date.parse(round.release_at);
  const complete = dates
    .map((date, i) => ({ date, i }))
    .filter((d) => Date.parse(d.date) <= Date.parse(opts.asOf));
  const latest = complete.at(-1);
  if (!latest) throw new Error("no completed basket observation");
  const annual = target - 364 * 86_400_000;
  const seasonal = complete
    .filter((d) => Math.abs(Date.parse(d.date) - annual) <= 10 * 86_400_000)
    .sort(
      (a, b) => Math.abs(Date.parse(a.date) - annual) - Math.abs(Date.parse(b.date) - annual),
    )[0];
  const partial = dates
    .map((date, i) => ({ date, i }))
    .find((d) => Date.parse(d.date) > Date.parse(opts.asOf));
  if (
    partial &&
    partialWeight > 0 &&
    (availableInstant(opts.availableAt) === undefined ||
      availableInstant(opts.availableAt)! > Date.parse(opts.asOf))
  )
    throw new Error("partial basket needs a known capture before the forecast cutoff");
  const sw = seasonal ? seasonalWeight : 0;
  const pw = partial ? partialWeight : 0;
  const raw = Object.fromEntries(
    cells.map((cell) => {
      const points = lock.answer_history_by_cell![cell]!;
      const mean =
        (1 - sw - pw) * points[latest.i]!.value +
        sw * (seasonal ? points[seasonal.i]!.value : 0) +
        pw * (partial ? points[partial.i]!.value : 0);
      return [cell, mean * eventFactor(opts.events ?? [], cell, round.release_at, opts.asOf)];
    }),
  );
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error("empty Trends composition");
  const profile = Object.fromEntries(
    cells.map((cell) => {
      if (!start.profile![cell]) throw new Error("missing baseline basket cell");
      return [cell, { mean: (raw[cell]! * 100) / total, sd: start.profile![cell]!.sd }];
    }),
  );
  return {
    ...start,
    profile,
    note: "Trends seasonal/event challenger; shadow only",
    attention: {
      asOf: opts.asOf,
      availableAt: opts.availableAt,
      completed: latest.date,
      seasonal: seasonal?.date,
      partial: pw ? partial?.date : undefined,
      weights: { latest: 1 - sw - pw, seasonal: sw, partial: pw },
      events: opts.events ?? [],
    },
  };
}

/** Rank by recency plus a bounded observed trajectory; named event effects are
 * explicit scenarios. Titles stay exact to preserve the arena's identity contract. */
export function wikipediaChallenger(
  round: ArenaRound,
  lock: ArenaLock,
  start: RoundForecast,
  opts: { asOf: string; events?: AttentionEvent[] },
) {
  if (
    round.tracker !== "wikipedia" ||
    round.target_type !== "ranking_list" ||
    Date.parse(opts.asOf) >= Date.parse(round.lock_at)
  )
    throw new Error("Wikipedia challenger requires a prospective ranking");
  const days = [...(lock.answer_obs ?? [])]
    .filter((d) => Date.parse(d.date) + 2 * 86_400_000 <= Date.parse(opts.asOf))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 2) throw new Error("insufficient published pageview history");
  const latest = days.at(-1)!;
  const previous = days.at(-2)!;
  const views: Record<string, number> = {};
  const items = [...new Set(days.flatMap((d) => d.items))];
  for (const item of items) {
    const current = latest.views?.[item] ?? 0;
    const prior = previous.views?.[item] ?? current;
    const trajectory =
      current > 0 && prior > 0 ? Math.max(0.5, Math.min(2, Math.sqrt(current / prior))) : 1;
    const factor = eventFactor(opts.events ?? [], item, round.release_at, opts.asOf);
    views[item] =
      days.reduce(
        (sum, day) =>
          sum +
          (day.views?.[item] ?? 0) *
            0.5 ** ((Date.parse(latest.date) - Date.parse(day.date)) / (3 * 86_400_000)),
        0,
      ) *
      trajectory *
      factor;
    if (!Number.isFinite(views[item]) || views[item]! < 0)
      throw new Error("invalid pageview count");
  }
  const ranking = forecastRanking(
    { ...lock, answer_obs: [{ date: latest.date, items, views }] },
    round.ranking?.length ?? 10,
    round.ranking?.items,
  );
  return {
    ...start,
    ranking,
    note: "Wikipedia trajectory/event challenger; shadow only",
    attention: { asOf: opts.asOf, events: opts.events ?? [] },
  };
}
