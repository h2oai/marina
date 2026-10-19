// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { forecastRound, forecastScalar } from "../src/arena/forecast";
import {
  arenaEwma,
  POLL_LEVEL_MIN_SD,
  POLL_LEVEL_SD_SCALE,
  POLL_LEVEL_TRACKERS,
  pollBlendMean,
  pollLevelForecast,
  pollLevelModeFromEnv,
  ruleErrorRms,
} from "../src/arena/poll-level";
import { startLine } from "../src/arena/prompt-context";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import { scopeProcessState } from "./process-state";

/** Deterministic standard normals (LCG + Box–Muller). */
function normals(seed: number, n: number): number[] {
  let s = seed;
  const u = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return (s + 1) / (2 ** 31 + 1);
  };
  return Array.from(
    { length: n },
    () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()),
  );
}

const weekly = (values: number[]): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse("2025-08-02") + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

/** A noisy weekly poll: a fixed level of 38 plus fresh sampling noise (sd 2), integer-rounded. */
const noisyPoll = (n = 60, seed = 7) => weekly(normals(seed, n).map((z) => Math.round(38 + 2 * z)));

function scalarRound(tracker: string, hist: ArenaPoint[]): { round: ArenaRound; lock: ArenaLock } {
  const last = Date.parse(hist.at(-1)!.date);
  const round: ArenaRound = {
    round_id: `${tracker.replace(/_/g, "-")}-2026-w43`,
    tracker,
    series: `${tracker}_topline`,
    question: "Topline next release?",
    target_type: "continuous_normal",
    lock_at: new Date(last + 5 * 86_400_000).toISOString(),
    release_at: new Date(last + 7 * 86_400_000).toISOString(),
  };
  return { round, lock: { round_id: round.round_id, history: hist } };
}

describe("poll-level rule math", () => {
  it("ports the arena's EWMA (seeded at the first value, alpha 0.4)", () => {
    expect(arenaEwma([10])).toBe(10);
    // 10 → 0.4·20 + 0.6·10 = 14 → 0.4·5 + 0.6·14 = 10.4
    expect(arenaEwma([10, 20, 5])).toBeCloseTo(10.4, 10);
    expect(() => arenaEwma([])).toThrow();
  });

  it("averages persistence and the EWMA", () => {
    expect(pollBlendMean([10, 20, 5])).toBeCloseTo((5 + 10.4) / 2, 10);
  });

  it("sizes the spread from the rule's own one-step errors, prefix-only", () => {
    const values = [1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3];
    // Persistence on an alternating series misses by exactly 2 every time.
    const pers = ruleErrorRms(values, (p) => p.at(-1)!, 1)!;
    expect(pers.rms).toBeCloseTo(2, 10);
    expect(pers.n).toBe(values.length - 8);
    // Each error uses only values before its origin: changing the last value
    // changes only the last error.
    const changed = [...values.slice(0, -1), 100];
    const errs = (v: number[]) => ruleErrorRms(v, (p) => p.at(-1)!, 1)!;
    expect(errs(changed).rms ** 2 * errs(changed).n).toBeCloseTo(
      pers.rms ** 2 * pers.n - 4 + (100 - 1) ** 2,
      6,
    );
    // Too few errors ⇒ undefined (baseline stands).
    expect(ruleErrorRms(values.slice(0, 13), (p) => p.at(-1)!, 1)).toBeUndefined();
    expect(ruleErrorRms(values.slice(0, 14), (p) => p.at(-1)!, 1)?.n).toBe(6);
  });

  it("files the blend with half its RMS, floored, and records its evidence", () => {
    const values = noisyPoll().map((p) => p.value);
    const out = pollLevelForecast(values, 1)!;
    const rms = ruleErrorRms(values, pollBlendMean, 1)!;
    expect(out.forecast.mean).toBeCloseTo(pollBlendMean(values), 10);
    expect(out.forecast.sd).toBeCloseTo(Math.max(POLL_LEVEL_SD_SCALE * rms.rms, 0.5), 10);
    expect(out.evidence).toMatchObject({
      rule: "persistence-ewma-blend",
      persistence: values.at(-1),
      alpha: 0.4,
      steps: 1,
      sd: { basis: "rule-rms", errors: rms.n, scale: 0.5, floor: POLL_LEVEL_MIN_SD },
    });
    // A flat series: zero error, the floor holds.
    expect(pollLevelForecast(Array(30).fill(40), 1)!.forecast).toEqual({
      mean: 40,
      sd: POLL_LEVEL_MIN_SD,
    });
  });

  it("uses steps-ahead errors at a longer horizon", () => {
    const values = noisyPoll().map((p) => p.value);
    const two = pollLevelForecast(values, 2)!;
    expect(two.evidence.steps).toBe(2);
    expect(two.evidence.sd.rms).toBeCloseTo(ruleErrorRms(values, pollBlendMean, 2)!.rms, 3);
  });

  it("is deterministic", () => {
    const values = noisyPoll().map((p) => p.value);
    expect(pollLevelForecast(values, 1)).toEqual(pollLevelForecast(values, 1));
  });
});

describe("poll-level start in forecastRound", () => {
  it("replaces persistence for the backtested poll families", () => {
    expect([...POLL_LEVEL_TRACKERS].sort()).toEqual([
      "aaii",
      "economist_yougov",
      "morning_consult",
    ]);
    for (const tracker of POLL_LEVEL_TRACKERS) {
      const hist = noisyPoll();
      const { round, lock } = scalarRound(tracker, hist);
      const f = forecastRound(round, lock, { pollLevel: "on" });
      const values = hist.map((p) => p.value);
      expect(f.rules[round.series!]).toBe("poll-level");
      expect(f.topline!.mean).toBeCloseTo(pollBlendMean(values), 3);
      expect(f.pollLevel?.rule).toBe("persistence-ewma-blend");
      expect(f.note).toContain("poll level");
      // Formations and research see the start named truthfully.
      expect(startLine(round, f, hist)).toContain("the poll level");
    }
  });

  it("lands nearer a noisy poll's true level than persistence does", () => {
    let blendErr = 0;
    let persErr = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const hist = noisyPoll(60, seed);
      const { round, lock } = scalarRound("economist_yougov", hist);
      const f = forecastRound(round, lock, { pollLevel: "on" });
      blendErr += Math.abs(f.topline!.mean - 38);
      persErr += Math.abs(hist.at(-1)!.value - 38);
    }
    expect(blendErr).toBeLessThan(0.8 * persErr);
  });

  it("leaves other families on the baseline (Civiqs, UMich, NY Fed SCE, Harvard-Harris)", () => {
    for (const tracker of [
      "civiqs",
      "umich_sentiment",
      "umich_party",
      "ny_fed_sce",
      "harvard_harris",
    ]) {
      const hist = noisyPoll();
      const { round, lock } = scalarRound(tracker, hist);
      const f = forecastRound(round, lock, { pollLevel: "on" });
      const base = forecastScalar(hist, round.release_at);
      expect(f.topline).toEqual({ mean: base.mean, sd: base.sd });
      expect(f.rules[round.series!]).toBe(base.rule);
      expect(f.pollLevel).toBeUndefined();
    }
  });

  it("keeps the baseline when the history is too short to size the spread", () => {
    const hist = noisyPoll(13);
    const { round, lock } = scalarRound("economist_yougov", hist);
    const f = forecastRound(round, lock, { pollLevel: "on" });
    expect(f.pollLevel).toBeUndefined();
    expect(f.topline!.mean).toBe(hist.at(-1)!.value);
  });

  it("is switched off by MARINA_ARENA_POLL_LEVEL=off and defaults on", () => {
    expect(pollLevelModeFromEnv({})).toBe("on");
    expect(pollLevelModeFromEnv({ MARINA_ARENA_POLL_LEVEL: "on" })).toBe("on");
    expect(pollLevelModeFromEnv({ MARINA_ARENA_POLL_LEVEL: " OFF " })).toBe("off");
    const hist = noisyPoll();
    const { round, lock } = scalarRound("morning_consult", hist);
    const base = forecastScalar(hist, round.release_at);
    {
      using _env = scopeProcessState({ env: { MARINA_ARENA_POLL_LEVEL: "off" } });
      const f = forecastRound(round, lock);
      expect(f.topline).toEqual({ mean: base.mean, sd: base.sd });
      expect(f.pollLevel).toBeUndefined();
    }
    {
      using _env = scopeProcessState({ env: { MARINA_ARENA_POLL_LEVEL: undefined } });
      expect(forecastRound(round, lock).rules[round.series!]).toBe("poll-level");
    }
    // An explicit option wins over the environment.
    expect(forecastRound(round, lock, { pollLevel: "off" }).pollLevel).toBeUndefined();
  });

  it("leaves profile rounds unchanged, including an economist_yougov-tracked profile", () => {
    const cells = ["c1", "c2"];
    const hist = noisyPoll();
    const round: ArenaRound = {
      ...scalarRound("economist_yougov", hist).round,
      target_type: "profile_energy",
      cells,
    };
    const lock: ArenaLock = {
      round_id: round.round_id,
      answer_history_by_cell: { c1: hist, c2: noisyPoll(60, 9) },
    };
    expect(forecastRound(round, lock, { pollLevel: "on" })).toEqual(
      forecastRound(round, lock, { pollLevel: "off" }),
    );
    expect(forecastRound(round, lock, { pollLevel: "on" }).pollLevel).toBeUndefined();
  });
});
