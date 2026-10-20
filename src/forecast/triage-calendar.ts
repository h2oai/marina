// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Release calendar evidence for intake triage (`./triage.ts`), from the
 * official-series lookups Marina already has (`./lookup-series.ts`):
 *
 *   probe     is the period's figure already in the official series AT NOW?
 *             FRED read as published the day BEFORE now (an ALFRED vintage
 *             with `FRED_API_KEY`; keyless FRED only for a live NOW), so a
 *             release later on now's own day is never seen. An observation
 *             for the period (or later) means published — by data, not by
 *             a model's say-so.
 *   calendar  when it is not out, the next scheduled release of the series
 *             (FRED release dates). Read only for a LIVE now: a backtest
 *             never consults today's calendar about its past.
 *
 * Only series the facts name (`facts.fred`, from a known statistic or the
 * fact model) are read. Never throws: a failure is a note.
 */

import { getErrorMessage } from "../engine/errors";
import { type LookupFetch, lookupFetch } from "./lookup-http";
import { fredLookup } from "./lookup-series";
import { isLiveCutoff } from "./lookup-types";
import type { CalendarEvidence, TriageFacts } from "./triage";

const FRED = "https://api.stlouisfed.org/fred";
const DAY_MS = 86_400_000;

export interface TriageCalendarDeps {
  /** `FRED_API_KEY`: vintage probes for a past now, and release dates. */
  fredApiKey?: string;
  http?: LookupFetch;
  /** The wall clock (live vs past now); default `Date.now`. */
  clock?: () => Date;
}

/** `MARINA_FORECAST_TRIAGE_CALENDAR`: `off` disables the probe and calendar; default on. */
export function triageCalendarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|none)$/i.test(env.MARINA_FORECAST_TRIAGE_CALENDAR?.trim() ?? "");
}

/** Calendar evidence for `facts` as of `now` (the cutoff). */
export async function triageCalendar(
  facts: TriageFacts,
  now: Date,
  deps: TriageCalendarDeps = {},
): Promise<CalendarEvidence> {
  const out: CalendarEvidence = { notes: [] };
  const id = facts.fred?.[0];
  const period = facts.period;
  if (!id || !period) {
    out.notes.push("no official series named for this period");
    return out;
  }
  const http = deps.http ?? lookupFetch("fred");
  const clock = deps.clock?.() ?? new Date();
  // Probe as of the day before now: a release later on now's day is invisible.
  const asOf = new Date(now.getTime() - DAY_MS);
  try {
    const r = await fredLookup(deps.fredApiKey, http).lookup(facts.metric ?? id, asOf, clock, {
      hints: { fred: [id] },
      answerType: "number",
    });
    const reading = r.readings?.find((x) => x.series === id);
    if (r.skipped) out.notes.push(`probe: ${r.skipped}`);
    else if (reading && reading.date >= period.start && reading.date <= asOf.toISOString()) {
      out.published = {
        at: asOf.toISOString(),
        basis: "series",
        source: `FRED ${id} observation ${reading.date}`,
      };
    } else if (reading) {
      out.notes.push(`probe: latest ${id} observation ${reading.date} predates ${period.start}`);
    }
  } catch (err) {
    out.notes.push(`probe failed: ${getErrorMessage(err).slice(0, 120)}`);
  }
  if (out.published) return out;
  if (!isLiveCutoff(now, clock)) {
    out.notes.push("calendar: not read for a past now");
    return out;
  }
  if (!deps.fredApiKey) {
    out.notes.push("calendar: needs FRED_API_KEY");
    return out;
  }
  try {
    const next = await nextRelease(http, deps.fredApiKey, id, period.end, now);
    if (next) out.next = { at: next, source: `FRED release calendar (${id})` };
    else out.notes.push("calendar: no scheduled release found");
  } catch (err) {
    out.notes.push(`calendar failed: ${getErrorMessage(err).slice(0, 120)}`);
  }
  return out;
}

/** The first scheduled release day of `id`'s release after both the period's end and now. */
async function nextRelease(
  http: LookupFetch,
  key: string,
  id: string,
  periodEnd: string,
  now: Date,
): Promise<string | undefined> {
  const rel = await http.json<{ releases?: Array<{ id?: number }> }>(
    `${FRED}/series/release?${new URLSearchParams({ series_id: id, api_key: key, file_type: "json" })}`,
  );
  const releaseId = rel.ok ? rel.value.releases?.[0]?.id : undefined;
  if (!releaseId) return undefined;
  const after = [periodEnd, now.toISOString().slice(0, 10)].sort().at(-1)!;
  const dates = await http.json<{ release_dates?: Array<{ date?: string }> }>(
    `${FRED}/release/dates?${new URLSearchParams({
      release_id: String(releaseId),
      api_key: key,
      file_type: "json",
      realtime_start: after,
      realtime_end: "9999-12-31",
      include_release_dates_with_no_data: "true",
      sort_order: "asc",
      limit: "20",
    })}`,
  );
  if (!dates.ok) return undefined;
  return (dates.value.release_dates ?? [])
    .map((d) => d.date ?? "")
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d > after)
    .sort()[0];
}
