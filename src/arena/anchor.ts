// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Anchor freshness: a forecast starts from the latest published reading its
 * inputs saw (the "anchor"). The arena scores every round against persistence
 * — the last value IT treats as published at the lock — so a filing anchored
 * on an older release loses skill by construction (2026-10-11: two
 * Economist/YouGov rounds filed on 36/18 locked against 38/21).
 *
 * This module compares Marina's anchor with the arena's own latest value for
 * the round's series (or each profile cell), read from the arena's published
 * site data (`site/data.json`, already read for settlement): the round's
 * `baselines.persistence.mean` (profile: `profile.baselines.persistence[cell]`)
 * and the date of that value from `series_tail`. Ranking rounds have no
 * comparable value and are skipped. Pure apart from the types it reads.
 */

import type { RoundForecast } from "./forecast";
import type { ArenaLock, ArenaRound, Distribution } from "./types";

/** `MARINA_ARENA_ANCHOR_GUARD`: `on` (default) re-fetches and re-anchors, `observe` records only, `off` skips. */
export type AnchorGuardMode = "on" | "observe" | "off";

export function anchorGuardModeFromEnv(env: NodeJS.ProcessEnv = process.env): AnchorGuardMode {
  const raw = env.MARINA_ARENA_ANCHOR_GUARD?.trim().toLowerCase();
  return raw === "off" || raw === "observe" ? raw : "on";
}

export interface AnchorPoint {
  value: number;
  /** Observation date (YYYY-MM-DD) when known. */
  date?: string;
}

/** The arena's latest published value per series (scalar) or cell (profile). */
export type AnchorReference = Record<string, AnchorPoint>;

/** The parts of the arena's `site/data.json` the guard reads. */
export interface ArenaSiteData {
  rounds?: Array<{
    round_id?: string;
    baselines?: { persistence?: { mean?: unknown } } | null;
    profile?: { baselines?: { persistence?: Record<string, { mean?: unknown }> } } | null;
  }>;
  series_tail?: Record<string, Array<{ date?: unknown; value?: unknown }>>;
}

function decimals(x: number): number {
  const s = String(x);
  if (/e/i.test(s)) return 6;
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : Math.min(s.length - dot - 1, 6);
}

/**
 * Half a unit in the last place the arena published: a poll published as an
 * integer (38) matches any reading that rounds to it (37.6), a one-decimal
 * Civiqs value (-26.7) matches within 0.05.
 */
export function roundingTolerance(arenaValue: number): number {
  return 0.5 * 10 ** -decimals(arenaValue) + 1e-9;
}

export function sameReading(marina: number, arena: number): boolean {
  return Math.abs(marina - arena) <= roundingTolerance(arena);
}

/** The ids a round's anchor is checked on; empty for ranking rounds. */
export function anchorIds(round: ArenaRound): string[] {
  if (round.target_type === "profile_energy") return round.cells ?? [];
  if (round.target_type === "continuous_normal") return [round.series ?? "topline"];
  return [];
}

/** The arena's latest published value for each of the round's ids, from its site data. */
export function anchorReferenceFromSite(
  site: ArenaSiteData,
  round: ArenaRound,
): AnchorReference | undefined {
  const published = site.rounds?.find((r) => r.round_id === round.round_id);
  if (!published) return undefined;
  const out: AnchorReference = {};
  const point = (id: string, mean: unknown) => {
    if (typeof mean !== "number" || !Number.isFinite(mean)) return;
    // Date the value only when the series' newest tail point IS that value.
    const last = site.series_tail?.[id]?.at(-1);
    const date =
      last &&
      typeof last.date === "string" &&
      typeof last.value === "number" &&
      sameReading(last.value, mean)
        ? last.date.slice(0, 10)
        : undefined;
    out[id] = { value: mean, ...(date ? { date } : {}) };
  };
  if (round.target_type === "continuous_normal") {
    point(round.series ?? "topline", published.baselines?.persistence?.mean);
  } else if (round.target_type === "profile_energy") {
    const cells = published.profile?.baselines?.persistence ?? {};
    for (const cell of round.cells ?? []) point(cell, cells[cell]?.mean);
  }
  return Object.keys(out).length ? out : undefined;
}

/** What a forecast was anchored on, per id: its dated start reading, else the lock's last value. */
export function forecastAnchors(
  round: ArenaRound,
  lock: ArenaLock | undefined,
  forecast: RoundForecast | undefined,
  guard?: AnchorGuardTrace,
): Record<string, AnchorPoint> {
  const out: Record<string, AnchorPoint> = {};
  for (const id of anchorIds(round)) {
    const reanchored = guard?.reanchored?.[id];
    if (reanchored) {
      out[id] = reanchored;
      continue;
    }
    const reading = forecast?.origins?.[id]?.reading;
    if (reading && Number.isFinite(reading.value)) {
      out[id] = { value: reading.value, date: reading.date };
      continue;
    }
    const history =
      round.target_type === "profile_energy"
        ? lock?.answer_history_by_cell?.[id]
        : (lock?.answer_history ?? lock?.history);
    const last = history?.at(-1);
    if (last && Number.isFinite(last.value)) out[id] = { value: last.value, date: last.date };
  }
  return out;
}

export interface AnchorCheckItem {
  id: string;
  marina: AnchorPoint;
  arena: AnchorPoint;
  /** fresh: same value (within rounding) or a newer Marina reading; stale: an older release. */
  verdict: "fresh" | "newer" | "stale";
}

export interface AnchorCheck {
  stale: boolean;
  items: AnchorCheckItem[];
  /** Ids with no comparable arena or Marina value (never a refusal). */
  unchecked: string[];
}

/**
 * Compare per id. A value that matches within rounding is fresh whatever the
 * dates say (date conventions differ between sources). A differing value is
 * stale unless Marina's reading is dated after the arena's (a daily source
 * ahead of the arena's weekly refresh), or both are dated the same day (the
 * same release, read through a different source — recorded, not stale).
 */
export function checkAnchor(
  round: ArenaRound,
  anchors: Record<string, AnchorPoint>,
  reference: AnchorReference | undefined,
): AnchorCheck {
  const items: AnchorCheckItem[] = [];
  const unchecked: string[] = [];
  for (const id of anchorIds(round)) {
    const marina = anchors[id];
    const arena = reference?.[id];
    if (!marina || !arena) {
      unchecked.push(id);
      continue;
    }
    let verdict: AnchorCheckItem["verdict"] = "fresh";
    if (!sameReading(marina.value, arena.value)) {
      const ahead = !!(marina.date && arena.date && marina.date >= arena.date);
      verdict = ahead ? "newer" : "stale";
    }
    items.push({ id, marina, arena, verdict });
  }
  return { stale: items.some((i) => i.verdict === "stale"), items, unchecked };
}

/** One line per stale id, for attempt reasons and alerts. */
export function describeStale(check: AnchorCheck): string {
  return check.items
    .filter((i) => i.verdict === "stale")
    .map(
      (i) =>
        `${i.id}: anchored on ${i.marina.value}${i.marina.date ? ` (${i.marina.date})` : ""}, arena's latest ${i.arena.value}${i.arena.date ? ` (${i.arena.date})` : ""}`,
    )
    .join("; ");
}

/** What the guard did, kept in the filing's detail. */
export interface AnchorGuardTrace {
  mode: AnchorGuardMode;
  status: "fresh" | "refetched" | "reanchored" | "stale" | "unchecked";
  check?: AnchorCheck;
  reason?: string;
  /** Ids whose mean was shifted onto the arena's value, with that value. */
  reanchored?: Record<string, AnchorPoint>;
}

/**
 * Shift each stale id's mean by (arena − anchor), keeping its spread and any
 * move the forecaster made away from its start. Never touches fresh ids.
 */
export function reanchorForecast(
  forecast: RoundForecast,
  round: ArenaRound,
  check: AnchorCheck,
): { forecast: RoundForecast; reanchored: Record<string, AnchorPoint> } {
  const reanchored: Record<string, AnchorPoint> = {};
  let topline = forecast.topline;
  let profile = forecast.profile;
  const shift = (d: Distribution, delta: number): Distribution => ({
    ...d,
    mean: Math.round((d.mean + delta) * 1e6) / 1e6,
  });
  for (const item of check.items) {
    if (item.verdict !== "stale") continue;
    const delta = item.arena.value - item.marina.value;
    if (round.target_type === "continuous_normal" && topline) {
      topline = shift(topline, delta);
    } else if (round.target_type === "profile_energy" && profile?.[item.id]) {
      profile = { ...profile, [item.id]: shift(profile[item.id]!, delta) };
    } else continue;
    reanchored[item.id] = item.arena;
  }
  if (!Object.keys(reanchored).length) return { forecast, reanchored };
  return {
    forecast: {
      ...forecast,
      ...(topline ? { topline } : {}),
      ...(profile ? { profile } : {}),
      note: `${forecast.note}; re-anchored on the arena's latest value (${describeStale(check)})`,
    },
    reanchored,
  };
}

function parseObject(text: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(text ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/**
 * The anchor check of an ACCEPTED filing against the arena's latest values.
 * A filing that kept its inputs (`detail.lock` / `detail.forecast`) is checked
 * on its anchor; a legacy filing without them is stale when it was made
 * before the day of the arena's latest release (it cannot have seen it) and
 * the filed mean differs from that release.
 */
export function filedAnchorCheck(
  round: ArenaRound,
  filing: { body: string; detail?: string | null; created_at: number },
  reference: AnchorReference | undefined,
): AnchorCheck | undefined {
  if (!reference || !anchorIds(round).length) return undefined;
  const detail = parseObject(filing.detail ?? undefined);
  const anchors = forecastAnchors(
    round,
    detail.lock as ArenaLock | undefined,
    detail.forecast as RoundForecast | undefined,
    detail.anchorGuard as AnchorGuardTrace | undefined,
  );
  if (Object.keys(anchors).length) return checkAnchor(round, anchors, reference);
  const body = parseObject(filing.body) as {
    topline?: Distribution;
    profile?: Record<string, Distribution>;
  };
  const filedDay = new Date(filing.created_at).toISOString().slice(0, 10);
  const items: AnchorCheckItem[] = [];
  const unchecked: string[] = [];
  for (const id of anchorIds(round)) {
    const arena = reference[id];
    const mean =
      round.target_type === "profile_energy" ? body.profile?.[id]?.mean : body.topline?.mean;
    if (!arena?.date || typeof mean !== "number") {
      unchecked.push(id);
      continue;
    }
    const stale = filedDay < arena.date && !sameReading(mean, arena.value);
    items.push({
      id,
      marina: { value: mean, date: filedDay },
      arena,
      verdict: stale ? "stale" : "fresh",
    });
  }
  return { stale: items.some((i) => i.verdict === "stale"), items, unchecked };
}
