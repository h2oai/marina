// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import {
  arenaRouteOutcomesEnabled,
  chooseArenaRoute,
  loadRouteEvidence,
  type RouteOutcomeReader,
} from "../src/arena/earned-routes";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";
import type { ArenaShadowRow, ArenaSubmissionRow } from "../src/persistence/db-arena";
import type { ForecastAnswerRow } from "../src/persistence/db-markets";
import type { OutcomeRow } from "../src/persistence/db-outcomes";

const DELPHI = "formation:delphi:openrouter/vendor/model-a,openrouter/vendor/model-b";
const ENTRANT = "h2oai-marina";
const NOW = Date.parse("2026-10-14T00:00:00Z");
const before = Date.parse("2026-07-19T00:00:00Z");

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 2)));

const ROUNDS = ["aaii-r0", "aaii-r1", "aaii-r2"];
const round = (id: string): ArenaRound => ({
  round_id: id,
  tracker: "aaii",
  question: "?",
  target_type: "continuous_normal",
  lock_at: "2026-07-20T14:00:00Z",
  release_at: "2026-07-20T18:00:00Z",
});

function arenaData(): ArenaData {
  const files: Record<string, unknown> = {
    "questions/season0.json": { rounds: ROUNDS.map(round) },
    "resolutions/resolved.json": Object.fromEntries(
      ROUNDS.map((id) => [id, { value: 41.5, resolved_at: "2026-07-24T20:00:00Z" }]),
    ),
    ...Object.fromEntries(
      ROUNDS.map((id) => [`locks/${id}.json`, { round_id: id, answer_history: history }]),
    ),
  };
  return new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
}

const sub = (id: number, roundId: string, mean: number, notes: string) =>
  ({
    id,
    round_id: roundId,
    status: "accepted",
    created_at: before + id,
    body: JSON.stringify({ round_id: roundId, topline: { mean, sd: 1 }, notes }),
  }) as unknown as ArenaSubmissionRow;

const shadow = (id: number, roundId: string, forecaster: string, mean = 41.5, sd = 0.5) =>
  ({
    id,
    round_id: roundId,
    forecaster,
    forecast: JSON.stringify({ topline: { mean, sd } }),
    detail: "{}",
    cost_usd: 0,
    created_at: before,
  }) as ArenaShadowRow;

/** Arena tables: our filed delphi forecast on every round, one shadow baseline on r0. */
const store = {
  listArenaSubmissions: () =>
    ROUNDS.map((r, i) => sub(i + 1, r, 41.4, `route aaii → ${DELPHI}; d`)),
  listArenaShadow: () => [shadow(10, "aaii-r0", "baseline#0123456789abcdef")],
};

/** An outcome-path reader over in-memory outcome rows and their filed answers. */
function reader(
  rows: Array<{ owner: string; roundId: string; method: string; mean: number; createdAt?: number }>,
): RouteOutcomeReader {
  const answers = new Map<number, ForecastAnswerRow>();
  const outcomes: OutcomeRow[] = rows.map((r, i) => {
    const id = 100 + i;
    answers.set(id, {
      id,
      entity_name: r.owner,
      question: "?",
      kind: "number",
      probability: null,
      mean: r.mean,
      sd: 0.8,
      prediction: null,
      answer_json: "{}",
      sample_id: null,
      created_at: r.createdAt ?? before,
      resolved_at: NOW,
      outcome_json: null,
      score: null,
    });
    return {
      id: i + 1,
      subject: `forecast:${id}`,
      kind: "forecast",
      source: "arena:number",
      domain: "forecast",
      owner: r.owner,
      succeeded: 1,
      quality: null,
      loss: 0.2,
      metric: "crps",
      truth_json: null,
      detail: null,
      basis: "mechanical",
      judge: null,
      eval_mode: "live",
      participants_json: null,
      refs_json: JSON.stringify([
        `forecast:${id}`,
        `arena:${r.roundId}`,
        `arena-entrant:${ENTRANT}`,
        "family:aaii",
        `method:${r.method}`,
      ]),
      resolved_at: NOW,
      created_at: NOW,
    } as unknown as OutcomeRow;
  });
  return {
    listOutcomes: () => outcomes,
    getForecastAnswer: (id: number) => answers.get(id),
  } as unknown as RouteOutcomeReader;
}

const decide = (evidence: Awaited<ReturnType<typeof loadRouteEvidence>>) =>
  chooseArenaRoute({
    family: "aaii",
    defaultSpec: DELPHI,
    evidence,
    now: NOW,
    mode: "on",
    minN: 8,
  });

const keyed = (ev: Awaited<ReturnType<typeof loadRouteEvidence>>) =>
  ev.map((e) => [e.roundId, e.source, e.spec, e.skill]).sort();

describe("arena route evidence from the shared outcome rows", () => {
  it("reads MARINA_ARENA_ROUTE_OUTCOMES (default on)", () => {
    expect(arenaRouteOutcomesEnabled({})).toBe(true);
    expect(arenaRouteOutcomesEnabled({ MARINA_ARENA_ROUTE_OUTCOMES: "off" })).toBe(false);
    expect(arenaRouteOutcomesEnabled({ MARINA_ARENA_ROUTE_OUTCOMES: "on" })).toBe(true);
  });

  it("leaves existing results unchanged: settle's own outcome rows are the filed evidence", async () => {
    const data = arenaData();
    const tablesOnly = await loadRouteEvidence(store, data, ENTRANT);
    // The outcome rows `settle.ts` writes for our own filings (method = the kind).
    const own = reader(
      ROUNDS.map((roundId) => ({
        owner: `marina:arena/${ENTRANT}`,
        roundId,
        method: "baseline",
        mean: 30,
      })),
    );
    const withOutcomes = await loadRouteEvidence(store, data, ENTRANT, own, {});
    expect(keyed(withOutcomes)).toEqual(keyed(tablesOnly));
    expect(decide(withOutcomes)).toEqual(decide(tablesOnly));
    expect(tablesOnly.some((e) => e.source === "outcome")).toBe(false);
  });

  it("adds another producer's scored answer as a paired challenger record", async () => {
    const data = arenaData();
    const other = reader([
      { owner: "marina:shadow", roundId: "aaii-r1", method: "baseline", mean: 41.4 },
      { owner: "marina:shadow", roundId: "aaii-r2", method: "baseline", mean: 41.6 },
      // Not runnable, and not an arena round: never evidence.
      { owner: "marina:shadow", roundId: "aaii-r2", method: "routed", mean: 41.6 },
    ]);
    const ev = await loadRouteEvidence(store, data, ENTRANT, other, {});
    const fromOutcomes = ev.filter((e) => e.source === "outcome");
    expect(fromOutcomes.map((e) => [e.roundId, e.spec]).sort()).toEqual([
      ["aaii-r1", "baseline"],
      ["aaii-r2", "baseline"],
    ]);
    expect(fromOutcomes.every((e) => e.family === "aaii" && Number.isFinite(e.skill))).toBe(true);
    // Same scale as the arena tables: identical topline ⇒ identical skill.
    const viaShadow = await loadRouteEvidence(
      { ...store, listArenaShadow: () => [shadow(11, "aaii-r1", "baseline", 41.4, 0.8)] },
      data,
      ENTRANT,
    );
    expect(fromOutcomes.find((e) => e.roundId === "aaii-r1")!.skill).toBe(
      viaShadow.find((e) => e.source === "shadow")!.skill,
    );
    // The baseline now pairs with the filed delphi on r0 (shadow) + r1, r2 (outcomes).
    const d = decide(ev);
    expect(d.challengers.find((c) => c.id === "baseline")?.n).toBe(3);
    expect(d.chosen).toBe(DELPHI);
    // Off: the arena tables only.
    const off = await loadRouteEvidence(store, data, ENTRANT, other, {
      MARINA_ARENA_ROUTE_OUTCOMES: "off",
    });
    expect(off.some((e) => e.source === "outcome")).toBe(false);
    expect(decide(off).challengers.find((c) => c.id === "baseline")?.n).toBe(1);
  });

  it("never counts a (round, spec) the arena tables already hold", async () => {
    const data = arenaData();
    const dup = reader([
      // r0's baseline is already an arena_shadow record.
      { owner: "marina:shadow", roundId: "aaii-r0", method: "baseline", mean: 10 },
      // The same round and spec twice on the outcome path: counted once.
      { owner: "marina:shadow", roundId: "aaii-r1", method: "baseline", mean: 41.4 },
      { owner: "someone", roundId: "aaii-r1", method: "baseline", mean: 41.4 },
    ]);
    const ev = await loadRouteEvidence(store, data, ENTRANT, dup, {});
    const baseline = ev.filter((e) => e.spec === "baseline");
    expect(baseline.map((e) => [e.roundId, e.source]).sort()).toEqual([
      ["aaii-r0", "shadow"],
      ["aaii-r1", "outcome"],
    ]);
  });

  it("an outcome record of the default's exact spec can stand as the incumbent", () => {
    const d = chooseArenaRoute({
      family: "aaii",
      defaultSpec: "baseline",
      evidence: [
        {
          roundId: "aaii-r0",
          family: "aaii",
          source: "outcome",
          spec: "baseline",
          skill: 0.1,
          visibleAt: NOW - 1,
        },
      ],
      now: NOW,
      mode: "on",
      minN: 8,
    });
    expect(d.incumbentN).toBe(1);
  });
});
