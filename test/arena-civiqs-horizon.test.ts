// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { applySignal, validateSignal } from "../src/arena/discovery/signals";
import { forecastRound } from "../src/arena/forecast";
import {
  dampedSteps,
  dampingFromEnv,
  driftCentre,
  driftPersists,
  horizonDays,
  horizonModeFromEnv,
  horizonNowcast,
  horizonSd,
  hStepErrors,
  olsSlope,
} from "../src/arena/research/civiqs-horizon";
import { nowcastForecaster } from "../src/arena/research/civiqs-nowcast";
import type { ArenaLock, ArenaRound } from "../src/arena/types";

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A deterministic pseudo-random walk (no Math.random in tests). */
function walk(n: number, step: number, drift = 0, seed = 11): number[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31 - 0.5;
  };
  const out = [0];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! + drift + step * rnd());
  return out.map((v) => Math.round(v * 10) / 10);
}

describe("horizon primitives", () => {
  it("counts horizon days and damps drift steps", () => {
    expect(horizonDays("2026-09-26", "2026-10-02T14:00:00Z")).toBe(6);
    expect(horizonDays("2026-10-03", "2026-10-02")).toBe(0);
    expect(dampedSteps(6, 1)).toBe(6);
    expect(dampedSteps(0, 0.8)).toBe(0);
    // damping: fewer steps than h, increasing in h, increasing in φ
    expect(dampedSteps(6, 0.8)).toBeLessThan(6);
    expect(dampedSteps(6, 0.8)).toBeGreaterThan(dampedSteps(3, 0.8));
    expect(dampedSteps(6, 0.9)).toBeGreaterThan(dampedSteps(6, 0.5));
  });

  it("projects a linear trend and recognises when it persists", () => {
    const line = Array.from({ length: 40 }, (_, i) => -30 - 0.25 * i);
    expect(olsSlope(line.slice(-7))).toBeCloseTo(-0.25, 6);
    expect(driftCentre(line, 4, 1)).toBeCloseTo(line.at(-1)! - 1, 6);
    expect(driftPersists(line, 4, 1)).toBe(true);
    // a flat series: carry-forward is exact, so drift never "persists"
    expect(driftPersists(Array(40).fill(57.8), 4, 1)).toBe(false);
  });

  it("sd(h) grows with the horizon and respects floor and cap", () => {
    const v = walk(80, 1.2);
    const sds = [1, 3, 6].map((h) => horizonSd(v, h, "last", 0.8)!);
    expect(sds[0]!).toBeLessThanOrEqual(sds[1]!);
    expect(sds[1]!).toBeLessThanOrEqual(sds[2]!);
    expect(horizonSd(Array(40).fill(1), 4, "last", 0.8)).toBe(0.3); // floor
    expect(horizonSd(walk(80, 40), 6, "last", 0.8)).toBe(5); // cap
    expect(horizonSd([1, 2, 3], 4, "last", 0.8)).toBeUndefined(); // too short
    // revision noise widens it
    expect(horizonSd(v, 3, "last", 0.8, 1)!).toBeGreaterThan(sds[1]!);
  });

  it("walk-forward errors never use the point being forecast", () => {
    const v = [0, 0, 0, 0, 0, 0, 0, 10];
    // h = 1 from t = 6 forecasts index 7 from indices 0..6 only
    expect(hStepErrors(v, 1, "last", 1)).toEqual([10]);
  });

  it("reads modes from the environment, off by default", () => {
    expect(horizonModeFromEnv({})).toBe("off");
    expect(horizonModeFromEnv({ MARINA_ARENA_NOWCAST_HORIZON: "both" })).toBe("both");
    expect(horizonModeFromEnv({ MARINA_ARENA_NOWCAST_HORIZON: "junk" })).toBe("off");
    expect(dampingFromEnv({})).toBe(0.8);
    expect(dampingFromEnv({ MARINA_ARENA_NOWCAST_DAMPING: "2" })).toBe(0.8);
    expect(dampingFromEnv({ MARINA_ARENA_NOWCAST_DAMPING: "0.5" })).toBe(0.5);
  });
});

// ── archive fixture: a drifting net series, snapshots every day ─────────────
const round: ArenaRound = {
  round_id: "civiqs-2026-w40-econ-now",
  tracker: "civiqs",
  series: "civiqs_net_econ_now",
  question: "Net economy now?",
  target_type: "continuous_normal",
  lock_at: "2026-09-30T14:00:00Z",
  release_at: "2026-10-02T14:00:00Z",
};
const choices = ["Very good", "Fairly good", "Fairly bad", "Very bad", "Unsure"];
/** Net = good − bad; drifting −0.25/day from 2026-07-31. */
function snapshot(endDate: string, fetchedAt: string, bump = 0) {
  const points: Array<[string, ...number[]]> = [];
  for (let t = Date.parse("2026-07-31"); t <= Date.parse(endDate); t += DAY) {
    const i = (t - Date.parse("2026-07-31")) / DAY;
    const net = -30 - 0.25 * i + bump;
    // good = 30 + net/2, bad = 30 − net/2 ⇒ good − bad = net
    points.push([iso(t), 10, 20 + net / 2, 15 - net / 2, 15, 0]);
  }
  return { choices, end_date: endDate, fetched_at: fetchedAt, points };
}

function archive(): { data: ArenaData; requested: string[] } {
  const files: Record<string, unknown> = {};
  for (let t = Date.parse("2026-09-01"); t <= Date.parse("2026-09-29"); t += DAY) {
    const day = iso(t);
    files[`civiqs/economy_us_now/${day}.json`] = snapshot(iso(t - 3 * DAY), `${day}T10:00:00Z`);
  }
  // Fetched after the lock, with a different level: must never be read.
  files["civiqs/economy_us_now/2026-09-30.json"] = snapshot(
    "2026-09-29",
    "2026-09-30T18:00:00Z",
    +20,
  );
  files["civiqs/economy_us_now/2026-10-01.json"] = snapshot(
    "2026-09-30",
    "2026-10-01T10:00:00Z",
    +20,
  );
  const requested: string[] = [];
  const data = new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    requested.push(path);
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
  return { data, requested };
}

const history = Array.from({ length: 20 }, (_, i) => ({
  date: iso(Date.parse("2026-05-15") + i * 7 * DAY),
  value: -30,
}));
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };

describe("horizon nowcast on the archive", () => {
  it("drifts to the release day from snapshots fetched by the lock only", async () => {
    const { data, requested } = archive();
    const hz = await horizonNowcast(data, round, "both", 1);
    // newest pre-lock snapshot (09-29, end 09-26); h = 6 days to 10-02
    expect(hz?.lastDate).toBe("2026-09-26");
    expect(hz?.h).toBe(6);
    expect(hz?.drift).toBe(true);
    const lastValue = -30 - 0.25 * 57;
    expect(hz!.mean).toBeCloseTo(lastValue - 0.25 * 6, 1);
    // never a file dated after the lock day; the lock-day file is ignored (fetched later)
    expect(requested.every((p) => p.slice(-15, -5) <= "2026-09-30")).toBe(true);
    expect(hz!.mean).toBeLessThan(-40); // the +20 post-lock level never leaked in
  });

  it("leaves the nowcast unchanged when horizon is off, and corrects it when on", async () => {
    const { data } = archive();
    const off = await nowcastForecaster(data, forecastRound, { horizon: { mode: "off" } })(
      round,
      lock,
    );
    const on = await nowcastForecaster(data, forecastRound, {
      horizon: { mode: "drift", phi: 1 },
    })(round, lock);
    expect(off.topline!.mean).toBeCloseTo(-30 - 0.25 * 57, 1);
    expect(on.topline!.mean).toBeCloseTo(off.topline!.mean - 1.5, 1);
    expect(on.topline!.sd).toBe(off.topline!.sd); // drift-only keeps the baseline sd
  });

  it("is expressible in the signal language", async () => {
    expect(validateSignal({ centre: "nowcast-drift:0.8", spread: "horizon" })).toBeUndefined();
    expect(validateSignal({ centre: "nowcast-drift:2", spread: "baseline" })).toBeDefined();
    expect(validateSignal({ centre: "nowcast-drift:0.05", spread: "baseline" })).toContain("φ");
    const { data } = archive();
    const f = await applySignal(
      { centre: "nowcast-drift:1", spread: "baseline" },
      round,
      lock,
      data,
    );
    expect(f.mean).toBeCloseTo(-30 - 0.25 * 57 - 1.5, 1);
  });
});
