// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { applySignal, validateSignal } from "../src/arena/discovery/signals";
import { forecastRound } from "../src/arena/forecast";
import { forecastSettings } from "../src/arena/forecast-config";
import { recordHorizonShadows } from "../src/arena/horizon-shadow";
import { startLine } from "../src/arena/prompt-context";
import {
  dampedSteps,
  dampingFromEnv,
  driftCentre,
  driftPersists,
  horizonDays,
  horizonModeFromEnv,
  horizonNowcast,
  horizonOptionsFromEnv,
  horizonSd,
  hStepErrors,
  olsSlope,
  weeklyAnchorNowcast,
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

function archive(transform?: (snap: ReturnType<typeof snapshot>) => void): {
  data: ArenaData;
  requested: string[];
} {
  const files: Record<string, unknown> = {
    "questions/season0.json": { rounds: [round] },
    [`locks/${round.round_id}.json`]: lock,
  };
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
  for (const [path, value] of Object.entries(files)) {
    if (path.startsWith("civiqs/")) transform?.(value as ReturnType<typeof snapshot>);
  }
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
  it("retains the carry forecast when missing or duplicate dates break daily spacing", async () => {
    const corruptions: Array<(snap: ReturnType<typeof snapshot>) => void> = [
      (snap) => {
        snap.points.splice(-3, 1);
      },
      (snap) => {
        snap.points.at(-3)![0] = snap.points.at(-4)![0];
      },
      (snap) => {
        snap.points.at(-3)![0] = "invalid";
      },
    ];
    for (const corrupt of corruptions) {
      const { data } = archive(corrupt);
      expect(await horizonNowcast(data, round, "both", 1)).toBeUndefined();
      expect(
        await weeklyAnchorNowcast(data, round, { date: "2026-09-27", value: -40 }, 1),
      ).toBeUndefined();
      const off = await nowcastForecaster(data, forecastRound, { horizon: { mode: "off" } })(
        round,
        lock,
      );
      const on = await nowcastForecaster(data, forecastRound, { horizon: { mode: "both" } })(
        round,
        lock,
      );
      expect(on.topline).toEqual(off.topline);
      expect(on.origins?.[round.series!]?.projection).toBeUndefined();
    }
  });

  it("rejects invalid damping and release dates before producing a projection", async () => {
    const { data } = archive();
    for (const phi of [0, -1, 2, Number.NaN])
      expect(await horizonNowcast(data, round, "both", phi)).toBeUndefined();
    expect(await horizonNowcast(data, { ...round, release_at: "invalid" }, "both")).toBeUndefined();
  });

  it("projects a newer weekly anchor without importing the daily snapshot's revised level", async () => {
    const { data } = archive();
    const weekly = { date: "2026-09-27", value: -40 };
    const projected = await weeklyAnchorNowcast(data, round, weekly, 1);
    expect(projected?.mean).toBe(-41.25); // five days * -0.25, from -40, not the daily level
    expect(projected?.detail.age).toBe(1);
    expect(projected?.detail.samples).toBeGreaterThan(10);
    expect(projected?.drift).toBe(true);
    const newer = { ...lock, answer_history: [...history, weekly] };
    const existing = await nowcastForecaster(data, forecastRound, {
      horizon: { mode: "drift", phi: 1 },
    })(round, newer);
    const candidate = await nowcastForecaster(data, forecastRound, {
      horizon: { mode: "drift", phi: 1, weeklyAnchor: true },
    })(round, newer);
    expect(existing.topline?.mean).toBe(-40);
    expect(candidate.topline?.mean).toBe(-41.25);
    expect(candidate.topline?.sd).toBe(existing.topline?.sd);
    expect(candidate.origins?.[round.series!]?.selected).toBe("weekly");
    expect(candidate.origins?.[round.series!]?.reading.value).toBe(-40);
    const damped = await weeklyAnchorNowcast(data, round, weekly, 0.8);
    expect(damped?.mean).toBeCloseTo(-40 - 0.25 * 0.8 * dampedSteps(5, 0.8), 3);
  });

  it("does not extrapolate an excessively old trend or beyond a resolved horizon", async () => {
    const { data } = archive();
    expect(
      await weeklyAnchorNowcast(
        data,
        { ...round, release_at: "2026-10-10T14:00:00Z" },
        { date: "2026-10-05", value: -40 },
      ),
    ).toBeUndefined();
    expect(
      await weeklyAnchorNowcast(data, round, { date: "2026-10-02", value: -40 }),
    ).toBeUndefined();
  });

  it("records weekly candidates under distinct policy identities only when requested", async () => {
    const { data } = archive();
    const labels: string[] = [];
    const rows = await recordHorizonShadows(
      {
        recordArenaShadow: (row) => {
          labels.push(row.forecaster);
          return true;
        },
      },
      data,
      [round.round_id],
      { now: () => Date.parse(round.lock_at) - 3600_000, weeklyAnchor: true },
    );
    expect(rows).toHaveLength(7);
    expect(new Set(labels).size).toBe(7);
    expect(rows.filter((r) => r.variant?.endsWith(":weekly"))).toHaveLength(2);
  });

  it("records five distinct prospective policies on shared inputs, including drift-only", async () => {
    const { data, requested } = archive();
    const rows: Array<{ forecaster: string; forecast: string; detail: string }> = [];
    const store = {
      recordArenaShadow: (row: (typeof rows)[number]) => {
        rows.push(row);
        return true;
      },
    };
    const result = await recordHorizonShadows(store, data, [round.round_id], {
      now: () => Date.parse(round.lock_at) - 3600_000,
    });
    expect(result.filter((r) => r.recorded)).toHaveLength(5);
    expect(new Set(rows.map((r) => r.forecaster)).size).toBe(5);
    const details = rows.map((r) => JSON.parse(r.detail));
    expect(new Set(details.map((d) => d.origins[round.series!].source)).size).toBe(1);
    expect(details.filter((d) => d.settings.horizon.mode === "drift")).toHaveLength(2);
    expect(requested.filter((p) => p === "civiqs/economy_us_now/2026-09-29.json")).toHaveLength(1);
    expect(JSON.parse(rows[1]!.forecast).topline.mean).toBeLessThan(
      JSON.parse(rows[0]!.forecast).topline.mean,
    );
    expect(
      (
        await recordHorizonShadows(store, data, [round.round_id], {
          now: () => Date.parse(round.lock_at),
        })
      )[0]?.error,
    ).toBe("already locked");
    expect(rows).toHaveLength(5);
  });

  it("records nothing when a comparison crosses its lock", async () => {
    const { data } = archive();
    let ticks = 0;
    let writes = 0;
    const result = await recordHorizonShadows(
      {
        recordArenaShadow: () => {
          writes++;
          return true;
        },
      },
      data,
      [round.round_id],
      {
        now: () => Date.parse(round.lock_at) + (++ticks >= 3 ? 1 : -60_000),
      },
    );
    expect(result[0]?.error).toBe("comparison finished after lock");
    expect(writes).toBe(0);
  });
  it("scopes corrections to selected series and tells model roles about the applied projection", async () => {
    const { data } = archive();
    const settings = horizonOptionsFromEnv({
      MARINA_ARENA_NOWCAST_HORIZON: "drift",
      MARINA_ARENA_NOWCAST_DAMPING: "0.8",
      MARINA_ARENA_NOWCAST_SERIES: " civiqs_net_econ_now ",
    });
    const selected = await nowcastForecaster(data, forecastRound, { horizon: settings })(
      round,
      lock,
    );
    const excluded = await nowcastForecaster(data, forecastRound, {
      horizon: { ...settings, series: ["civiqs_net_approval"] },
    })(round, lock);
    expect(selected.topline!.mean).toBeLessThan(excluded.topline!.mean);
    expect(selected.topline!.sd).toBe(excluded.topline!.sd);
    const origin = selected.origins?.[round.series!];
    expect(origin).toMatchObject({ selected: "daily", horizonDays: 6, mode: "drift" });
    expect(origin?.projection?.points).toBeArray();
    expect(excluded.origins?.[round.series!]?.reason).toBe("series outside horizon policy");
    const prompt = startLine(round, selected, history);
    expect(prompt).toContain("projected start");
    expect(prompt).toContain("do not apply an already included trend twice");
    expect(prompt).toContain("different revisions");
  });

  it("keeps a newer weekly anchor and records why stale daily evidence was not projected", async () => {
    const { data } = archive();
    const f = await nowcastForecaster(data, forecastRound, { horizon: { mode: "drift" } })(round, {
      ...lock,
      answer_history: [...history, { date: "2026-09-27", value: -40 }],
    });
    expect(f.topline?.mean).toBe(-40);
    expect(f.origins?.[round.series!]).toMatchObject({
      selected: "weekly",
      reading: { date: "2026-09-27", value: -40 },
      horizonDays: 5,
      reason: "daily reading predates weekly anchor",
    });
  });

  it("fingerprints strategy settings without persisting secrets or merging horizon candidates", () => {
    const a = forecastSettings("nowcast", { FRED_API_KEY: "secret" });
    const b = forecastSettings("nowcast", { FRED_API_KEY: "another-secret" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(JSON.stringify(a)).not.toContain("secret");
    expect(
      forecastSettings("nowcast", { MARINA_ARENA_NOWCAST_HORIZON: "drift" }).fingerprint,
    ).not.toBe(a.fingerprint);
    expect(horizonOptionsFromEnv({ MARINA_ARENA_NOWCAST_SERIES: "" }).series).toEqual([]);
  });
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
