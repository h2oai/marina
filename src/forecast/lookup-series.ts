// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Official numeric series as of the cutoff, and the numeric anchor built
 * from them.
 *
 * FRED with `FRED_API_KEY` is vintage-aware (ALFRED real-time periods): the
 * observations are read exactly as they were published on the cutoff date,
 * so a backtest never sees a later release or revision. Without a key FRED
 * serves only the latest revision (fredgraph CSV), and BLS likewise; both
 * are then used only for a live cutoff. Observations dated after the cutoff
 * are always dropped.
 *
 * The anchor is the freshest reading plus the spread of the series' own
 * changes over the question's horizon: a forecast starts there and moves
 * further only for specific evidence (the lesson of the arena nowcast —
 * the freshest official reading at the lock is the strongest single input).
 */

import { type LookupFetch, lookupFetch } from "./lookup-http";
import { overlap, tokens } from "./lookup-match";
import {
  type ForecastLookup,
  isLiveCutoff,
  type LookupResult,
  type Reading,
  skippedResult,
} from "./lookup-types";

const FRED = "https://api.stlouisfed.org/fred";
const FRED_ID = /^[A-Za-z0-9_.]{2,40}$/;
const BLS_ID = /^[A-Za-z0-9]{8,30}$/;
const MAX_SERIES = 3;
const HISTORY_POINTS = 60;

const day = (d: Date) => d.toISOString().slice(0, 10);

/** FRED's own calendar: its "today" is the date in US Central time. */
const FRED_TIME_ZONE = "America/Chicago";

/** `now`'s calendar date in FRED's time zone (YYYY-MM-DD). */
export function fredToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FRED_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The real-time date to read FRED as of: the cutoff's UTC date, but never
 * after FRED's own today — FRED rejects a `realtime_start` later than its
 * current (US Central) date, which a UTC cutoff of "now" can be for a few
 * hours each evening.
 */
export function fredAsOfDay(cutoff: Date, now: Date): string {
  const c = day(cutoff);
  const t = fredToday(now);
  return c < t ? c : t;
}

function readingLine(r: Reading, url: string, sourceTitle: string): string {
  const label = r.label ? ` (${r.label})` : "";
  const unit = r.unit ? ` ${r.unit}` : "";
  return `- ${r.date} — ${r.source} ${r.series}${label}: ${r.value}${unit} for ${r.date}, as published by ${r.asOf.slice(0, 10)} [${sourceTitle}](${url})`;
}

// ─── FRED ───────────────────────────────────────────────────────────────────

interface FredObs {
  date: string;
  value: string;
}

export function fredLookup(
  apiKey: string | undefined,
  http: LookupFetch = lookupFetch("fred"),
): ForecastLookup {
  const name = "fred";
  return {
    name,
    async lookup(query, cutoff, now, ctx) {
      const live = isLiveCutoff(cutoff, now);
      if (!apiKey && !live) {
        return skippedResult(
          name,
          "a past cutoff needs FRED_API_KEY (vintage data; keyless FRED serves only the latest revision)",
        );
      }
      let ids = (ctx?.hints?.fred ?? []).filter((s) => FRED_ID.test(s)).slice(0, MAX_SERIES);
      if (ids.length === 0 && apiKey && ctx?.answerType === "number") {
        ids = await searchSeries(http, apiKey, query);
      }
      if (ids.length === 0) return skippedResult(name, "no series named for this question");
      const d = fredAsOfDay(cutoff, now);
      const readings: Reading[] = [];
      for (const id of ids) {
        const r = apiKey
          ? await vintageReading(http, apiKey, id, d)
          : await latestReading(http, id, d);
        if (r) readings.push(r);
      }
      if (readings.length === 0)
        return skippedResult(name, "no observation at or before the cutoff");
      const out: LookupResult = {
        name,
        lines: [],
        sources: [],
        mode: apiKey ? "historical" : "live",
        asOf: cutoff.toISOString(),
        readings,
      };
      for (const r of readings) {
        const url = `https://fred.stlouisfed.org/series/${encodeURIComponent(r.series)}`;
        out.lines.push(readingLine(r, url, "FRED"));
        out.sources.push({ url, title: `FRED ${r.series}` });
      }
      return out;
    },
  };
}

async function searchSeries(http: LookupFetch, key: string, query: string): Promise<string[]> {
  const params = new URLSearchParams({
    search_text: query.slice(0, 120),
    limit: "5",
    order_by: "popularity",
    sort_order: "desc",
    file_type: "json",
    api_key: key,
  });
  const r = await http.json<{ seriess?: Array<{ id: string; title: string }> }>(
    `${FRED}/series/search?${params}`,
  );
  if (!r.ok) return [];
  const q = tokens(query);
  return (r.value.seriess ?? [])
    .filter((s) => FRED_ID.test(s.id) && overlap(q, s.title).shared >= 2)
    .slice(0, 1)
    .map((s) => s.id);
}

/** Observations exactly as published on `d` (ALFRED real-time period), newest last. */
async function vintageReading(
  http: LookupFetch,
  key: string,
  id: string,
  d: string,
): Promise<Reading | undefined> {
  const common = { file_type: "json", api_key: key, realtime_start: d, realtime_end: d };
  const obs = await http.json<{ observations?: FredObs[] }>(
    `${FRED}/series/observations?${new URLSearchParams({
      ...common,
      series_id: id,
      observation_end: d,
      sort_order: "desc",
      limit: String(HISTORY_POINTS),
    })}`,
  );
  if (!obs.ok) return undefined;
  const meta = await http.json<{ seriess?: Array<{ title?: string; units_short?: string }> }>(
    `${FRED}/series?${new URLSearchParams({ ...common, series_id: id })}`,
  );
  const m = meta.ok ? meta.value.seriess?.[0] : undefined;
  return toReading("FRED", id, obs.value.observations ?? [], d, d, m?.title, m?.units_short);
}

/** Keyless FRED (latest revision), used only for a live cutoff. */
async function latestReading(
  http: LookupFetch,
  id: string,
  d: string,
): Promise<Reading | undefined> {
  const r = await http.text(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`,
  );
  if (!r.ok) return undefined;
  const rows = r.value
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(","))
    .map(([date, value]) => ({ date: date ?? "", value: value ?? "" }));
  return toReading("FRED", id, rows, d, d);
}

function toReading(
  source: string,
  series: string,
  obs: FredObs[],
  cutoffDay: string,
  asOf: string,
  label?: string,
  unit?: string,
): Reading | undefined {
  const points = obs
    .filter((o) => o.date && o.date <= cutoffDay)
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_POINTS);
  const last = points[points.length - 1];
  if (!last) return undefined;
  return {
    source,
    series,
    ...(label ? { label: label.slice(0, 120) } : {}),
    value: last.value,
    date: last.date,
    asOf,
    ...(unit ? { unit } : {}),
    history: points,
  };
}

// ─── BLS ────────────────────────────────────────────────────────────────────

interface BlsSeries {
  seriesID: string;
  data?: Array<{ year: string; period: string; value: string }>;
}

/** BLS public API v2 (latest revision only — live cutoffs). `BLS_API_KEY` raises its quota. */
export function blsLookup(
  apiKey: string | undefined,
  http: LookupFetch = lookupFetch("bls"),
): ForecastLookup {
  const name = "bls";
  return {
    name,
    async lookup(_query, cutoff, now, ctx) {
      if (!isLiveCutoff(cutoff, now)) {
        return skippedResult(
          name,
          "BLS serves only the latest revision; skipped for a past cutoff",
        );
      }
      const ids = (ctx?.hints?.bls ?? []).filter((s) => BLS_ID.test(s)).slice(0, MAX_SERIES);
      if (ids.length === 0) return skippedResult(name, "no series named for this question");
      const y = cutoff.getUTCFullYear();
      const r = await http.json<{ status?: string; Results?: { series?: BlsSeries[] } }>(
        "https://api.bls.gov/publicAPI/v2/timeseries/data/",
        {
          method: "POST",
          body: {
            seriesid: ids,
            startyear: String(y - 4),
            endyear: String(y),
            ...(apiKey ? { registrationkey: apiKey } : {}),
          },
        },
      );
      if (!r.ok) return skippedResult(name, r.error);
      if (r.value.status && r.value.status !== "REQUEST_SUCCEEDED") {
        return skippedResult(name, `BLS ${r.value.status}`);
      }
      const d = day(cutoff);
      const readings: Reading[] = [];
      for (const s of r.value.Results?.series ?? []) {
        const obs = (s.data ?? [])
          .filter((o) => /^M(0[1-9]|1[0-2])$/.test(o.period))
          .map((o) => ({ date: `${o.year}-${o.period.slice(1)}-01`, value: o.value }));
        const reading = toReading("BLS", s.seriesID, obs, d, cutoff.toISOString());
        if (reading) readings.push(reading);
      }
      if (readings.length === 0)
        return skippedResult(name, "no observation at or before the cutoff");
      const out: LookupResult = {
        name,
        lines: [],
        sources: [],
        mode: "live",
        asOf: cutoff.toISOString(),
        readings,
      };
      for (const rd of readings) {
        const url = `https://data.bls.gov/timeseries/${encodeURIComponent(rd.series)}`;
        out.lines.push(readingLine(rd, url, "BLS"));
        out.sources.push({ url, title: `BLS ${rd.series}` });
      }
      return out;
    },
  };
}

// ─── The numeric anchor ─────────────────────────────────────────────────────

export interface NumericAnchor {
  source: string;
  series: string;
  value: number;
  /** The anchor observation's date. */
  date: string;
  asOf: string;
  /** Days from the anchor observation to the resolution (the question's end time, else the cutoff). */
  horizonDays: number;
  /** How many of the series' own steps that horizon spans. */
  steps: number;
  /** RMS of the series' own changes over that many steps (undefined with too little history). */
  sd?: number;
}

const DAY_MS = 86_400_000;

/** The freshest reading with a horizon-scaled spread from its own history. */
export function numericAnchor(
  readings: Reading[],
  cutoff: Date,
  endTime: string | undefined,
): NumericAnchor | undefined {
  const r = [...readings].sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!r) return undefined;
  const end = endTime ? Date.parse(endTime) : Number.NaN;
  const target = Number.isFinite(end) ? end : cutoff.getTime();
  const horizonDays = Math.max(0, Math.round((target - Date.parse(r.date)) / DAY_MS));
  const hist = r.history ?? [];
  const gaps: number[] = [];
  for (let i = 1; i < hist.length; i++) {
    gaps.push((Date.parse(hist[i]!.date) - Date.parse(hist[i - 1]!.date)) / DAY_MS);
  }
  gaps.sort((a, b) => a - b);
  const spacing = Math.max(1, gaps[Math.floor(gaps.length / 2)] ?? 1);
  const steps = Math.max(1, Math.round(horizonDays / spacing));
  const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
  let sd: number | undefined;
  const kChanges: number[] = [];
  for (let i = 0; i + steps < hist.length; i++) {
    kChanges.push(hist[i + steps]!.value - hist[i]!.value);
  }
  if (kChanges.length >= 5) sd = rms(kChanges);
  else {
    const one: number[] = [];
    for (let i = 1; i < hist.length; i++) one.push(hist[i]!.value - hist[i - 1]!.value);
    if (one.length >= 2) sd = rms(one) * Math.sqrt(steps);
  }
  return {
    source: r.source,
    series: r.series,
    value: r.value,
    date: r.date,
    asOf: r.asOf,
    horizonDays,
    steps,
    ...(sd !== undefined && Number.isFinite(sd) ? { sd: Number(sd.toPrecision(4)) } : {}),
  };
}

/** The anchor as one instruction line for the runs and the critic. */
export function anchorLine(a: NumericAnchor): string {
  const spread = a.sd !== undefined ? ` Typical change over that horizon: ±${a.sd}.` : "";
  return `- ANCHOR — the latest official reading of ${a.source} ${a.series} is ${a.value} (for ${a.date}, as published by ${a.asOf.slice(0, 10)}). The question resolves about ${a.horizonDays} days later (~${a.steps} step${a.steps === 1 ? "" : "s"} of the series).${spread} Start from this reading; move further only for specific dated evidence.`;
}
