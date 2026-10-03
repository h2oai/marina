// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import { evaluateResolved } from "../src/arena/evaluate";
import { DEFAULT_ROUTES, parseRoutes, routeFor, SkippedRound } from "../src/arena/routing";
import { forecasterFor } from "../src/arena/service";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("per-family routing", () => {
  it("parses routes, validates every target, and refuses nesting", () => {
    const spec = "route:civiqs=nowcast;economist_yougov=skip;*=baseline";
    expect(parseForecasterSpec(spec)).toBe(spec);
    expect(parseForecasterSpec("routed")).toBe("routed");
    expect(
      parseForecasterSpec("formation:delphi:openrouter/vendor/model+research@closed-book"),
    ).toBe("formation:delphi:openrouter/vendor/model+research@closed-book");
    const routes = parseRoutes(spec);
    expect(routeFor(routes, "civiqs")).toBe("nowcast");
    expect(routeFor(routes, "economist_yougov")).toBe("skip");
    expect(routeFor(routes, "aaii")).toBe("baseline");
    expect(() => parseForecasterSpec("route:civiqs=gpt")).toThrow();
    expect(() => parseForecasterSpec("route:civiqs=routed")).toThrow("do not nest");
    expect(() => parseForecasterSpec("route:civiqs")).toThrow("<family>=<forecaster>");
    // Unset, the map answers every family with the free nowcast.
    const d = parseRoutes("routed", {});
    expect(routeFor(d, "civiqs")).toBe("nowcast");
    expect(routeFor(d, "economist_yougov")).toBe("nowcast");
    expect(routeFor(d, "aaii")).toBe("nowcast");
    expect(parseRoutes("routed", { MARINA_ARENA_ROUTES: "*=baseline" }).fallback).toBe("baseline");
    expect(DEFAULT_ROUTES).toContain("*=nowcast");
  });

  it("answers each family with its own forecaster and leaves skipped families unanswered", async () => {
    const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 2)));
    const mk = (id: string, tracker: string): ArenaRound => ({
      round_id: id,
      tracker,
      question: "?",
      target_type: "continuous_normal",
      lock_at: "2026-07-20T14:00:00Z",
      release_at: "2026-07-24T14:00:00Z",
    });
    const rounds = [mk("aaii-r1", "aaii"), mk("yg-r1", "economist_yougov")];
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds },
      "resolutions/resolved.json": Object.fromEntries(
        rounds.map((r) => [r.round_id, { value: history.at(-1)!.value + 1 }]),
      ),
    };
    for (const r of rounds) {
      files[`locks/${r.round_id}.json`] = { round_id: r.round_id, answer_history: history };
    }
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const { forecaster } = await forecasterFor(
      "route:aaii=baseline;economist_yougov=skip;*=nowcast",
      {
        env: { MARINA_ARENA_CIVIQS_LIVE: "off" },
      },
    );
    const f = await forecaster(rounds[0]!, { round_id: "aaii-r1", answer_history: history });
    expect(f.note).toContain("route aaii → baseline");
    await expect(
      forecaster(rounds[1]!, { round_id: "yg-r1", answer_history: history }),
    ).rejects.toBeInstanceOf(SkippedRound);
    // Evaluation scores the answered round only — the board's mean-over-answered rule.
    const report = await evaluateResolved(data, { routed: forecaster });
    const byRound = Object.fromEntries(report.rounds.map((r) => [r.roundId, r.results.routed]));
    expect(byRound["aaii-r1"]).toBeDefined();
    expect(byRound["yg-r1"]).toBeUndefined();
    expect(report.families.find((x) => x.tracker === "economist_yougov")?.skill.routed).toBeNaN();
  });

  it("a no-history round refuses under the nowcast and reaches research when routed there", async () => {
    const seats: ArenaRound = {
      round_id: "special-seats",
      tracker: "special",
      series: "seats",
      question: "Seats won by Party A in the chamber (all 500 decided)",
      target_type: "continuous_normal",
      lock_at: "2026-10-20T22:00:00Z",
      release_at: "2026-11-20T00:00:00Z",
    };
    const empty = { round_id: seats.round_id, answer_history: [], history: [] };
    const env = { MARINA_ARENA_CIVIQS_LIVE: "off" };
    const plain = await forecasterFor("route:*=nowcast", { env });
    await expect(plain.forecaster(seats, empty)).rejects.toThrow("no history to forecast from");
    // Routed to research: the research forecaster is built (here it stops at
    // its missing retriever key — no network in tests), proving the route reaches it.
    const routed = await forecasterFor(
      "route:special=research:openrouter/vendor/model-a@tavily:advanced;*=nowcast",
      { env },
    );
    await expect(routed.forecaster(seats, empty)).rejects.toThrow("TAVILY_API_KEY");
  });
});
