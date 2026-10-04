// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { ArenaData } from "../src/arena/data";
import {
  calibrationHistory,
  recordPairedShadow,
  scorePairedShadows,
} from "../src/arena/paired-shadow";
import type { FormationInputs } from "../src/arena/service";
import type { ArenaRound } from "../src/arena/types";
import type { ArenaShadowRow } from "../src/persistence/db-arena";
import type { ArenaStore } from "../src/persistence/interfaces/arena-store";

const round: ArenaRound = {
  round_id: "yougov-test-round",
  tracker: "economist_yougov",
  series: "yougov_approval",
  question: "Approval of US adult citizens",
  unit: "% approve",
  target_type: "continuous_normal",
  lock_at: "2026-10-04T14:00:00Z",
  release_at: "2026-10-06T14:00:00Z",
};
const at = Date.parse("2026-10-04T12:00:00Z");
function fixture(resolved = true) {
  const rows: ArenaShadowRow[] = [];
  const lock = {
    round_id: round.round_id,
    answer_history: Array.from({ length: 20 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 4, 15 + i * 7)).toISOString().slice(0, 10),
      value: 40 + (i % 3),
    })),
  };
  const files: Record<string, unknown> = {
    "questions/season0.json": { rounds: [round] },
    [`locks/${round.round_id}.json`]: lock,
    "resolutions/resolved.json": resolved
      ? {
          [round.round_id]: {
            value: 42,
            observed_date: "2026-10-05",
            resolved_at: "2026-10-06T15:00:00Z",
          },
        }
      : {},
  };
  const data = new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
  const store: Pick<ArenaStore, "recordArenaShadow" | "listArenaShadow"> = {
    listArenaShadow: () => rows,
    recordArenaShadow: (r) => {
      rows.push({
        id: rows.length + 1,
        round_id: r.roundId,
        forecaster: r.forecaster,
        forecast: r.forecast,
        detail: r.detail,
        cost_usd: r.costUsd,
        created_at: at,
      });
      return true;
    },
  };
  return { data, store, rows };
}
const dossier = async () => ({
  since: "2026-09-25",
  verified: "a verified change",
  sources: 1,
  costUsd: 0,
});
const spec = "formation:delphi:mock/a,mock/b,mock/c";

test("unresolved comparisons have no score or retrospective attribution", async () => {
  const { data, store, rows } = fixture(false);
  await recordPairedShadow(store, data, round.round_id, spec, {
    now: () => at,
    env: {},
    dossier,
    run: async (inputs) => inputs.start,
  });
  const score = (await scorePairedShadows(data, rows))[0]!;
  expect(score.complete).toBe(true);
  expect(score.resolved).toBe(false);
  expect(score.eligible).toBe(false);
  for (const result of Object.values(score.results)) {
    expect(result.skill).toBeUndefined();
    expect(result.attributionFromStart).toBeUndefined();
  }
});

test("paired candidates share the captured start, isolate mutation and reuse the final forecast for calibration", async () => {
  const { data, store, rows } = fixture();
  const seen: FormationInputs[] = [];
  const result = await recordPairedShadow(store, data, round.round_id, spec, {
    now: () => at,
    env: {},
    dossier,
    run: async (inputs) => {
      seen.push(structuredClone(inputs));
      const forecast = structuredClone(inputs.start);
      inputs.start.topline!.mean = 999;
      inputs.lock.answer_history![0]!.value = 999;
      return { ...forecast, topline: { mean: 42, sd: 1 }, costUsd: 0.01 };
    },
  });
  expect(result).toHaveLength(4);
  expect(seen).toHaveLength(2);
  expect(seen[0]!.start).toEqual(seen[1]!.start);
  expect(seen[0]!.lock).toEqual(seen[1]!.lock);
  expect(seen[0]!.dossier).toBeUndefined();
  expect(seen[1]!.dossier?.verified).toBe("a verified change");
  expect(new Set(result.map((r) => r.inputHash)).size).toBe(1);
  expect(result[3]!.costUsd).toBe(0);
  expect((result[3]!.calibration as { applied: boolean }).applied).toBe(false);
  const history = await calibrationHistory(data, rows);
  expect(history).toHaveLength(1);
  expect(history[0]!.forecast.mean).toBe(42);
  const scores = await scorePairedShadows(data, rows);
  expect(scores[0]!.complete).toBe(true);
  expect(scores[0]!.eligible).toBe(true);
  expect(scores[0]!.results.fred!.skill).toBeGreaterThan(0);
  const attribution = scores[0]!.results.fred!.attributionFromStart!;
  expect(attribution.meanContribution + attribution.spreadContribution).toBeCloseTo(
    scores[0]!.results.fred!.skill! - scores[0]!.results.start!.skill!,
    12,
  );
  expect(scores[0]!.results.start!.attributionFromStart!.improvement).toBe(0);
});

test("a failed candidate remains visible and vetoes the whole matched comparison", async () => {
  const { data, store, rows } = fixture();
  await recordPairedShadow(store, data, round.round_id, spec, {
    now: () => at,
    env: {},
    dossier,
    run: async (inputs) => {
      if (!inputs.dossier) throw new Error("provider failure");
      return inputs.start;
    },
  });
  expect(rows).toHaveLength(4);
  const score = (await scorePairedShadows(data, rows))[0]!;
  expect(score.complete).toBe(false);
  expect(score.eligible).toBe(false);
  expect(score.results.delphi!.error).toBe("provider failure");
  expect(score.results.fred!.skill).toBeUndefined();
  expect(score.results.fred!.attributionFromStart).toBeUndefined();
});

test("late completion records no prospective evidence and rejects closed rounds before model calls", async () => {
  const { data, store, rows } = fixture();
  let now = at;
  await expect(
    recordPairedShadow(store, data, round.round_id, spec, {
      now: () => now,
      env: {},
      dossier,
      run: async (inputs) => {
        now = Date.parse(round.lock_at);
        return inputs.start;
      },
    }),
  ).rejects.toThrow("finished after lock");
  expect(rows).toHaveLength(0);
  await expect(
    recordPairedShadow(store, data, round.round_id, spec, {
      now: () => now,
      env: {},
      dossier,
      run: async () => {
        throw new Error("must not execute");
      },
    }),
  ).rejects.toThrow("five minutes");
});

test("an incomplete latest batch cannot fall back to an older success", async () => {
  const { data, store, rows } = fixture();
  await recordPairedShadow(store, data, round.round_id, spec, {
    now: () => at,
    env: {},
    dossier,
    run: async (inputs) => inputs.start,
  });
  const partial = structuredClone(rows[0]!);
  const detail = JSON.parse(partial.detail);
  detail.comparison.id = "newer-incomplete";
  detail.comparison.completedAt = new Date(at + 60_000).toISOString();
  partial.created_at = at + 60_000;
  partial.detail = JSON.stringify(detail);
  rows.push(partial);
  const scores = await scorePairedShadows(data, rows);
  expect(scores).toHaveLength(1);
  expect(scores[0]!.id).toBe("newer-incomplete");
  expect(scores[0]!.complete).toBe(false);
  expect(scores[0]!.eligible).toBe(false);
});
