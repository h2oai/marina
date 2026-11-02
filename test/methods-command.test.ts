// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * `methods`: every selector listed with the mode its environment sets and the
 * evidence it has; pure over an injected route view; nothing written.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { methodRows, methodsCommand, renderMethods } from "../src/engine/commands/methods";
import type { RouteViewRow } from "../src/forecast/route-view";
import { MarinaDB } from "../src/persistence/database";
import { stripAnsi } from "./helpers";

const dbs: MarinaDB[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

const row = (over: Partial<RouteViewRow>): RouteViewRow => ({
  evidence: "arena",
  family: "civiqs",
  default: "formation:delphi:a,b",
  defaultN: 20,
  method: "formation:ensemble:a,b",
  n: 8,
  verdict: "not better",
  candidate: true,
  earned: false,
  ...over,
});

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MARINA_FORECAST_ROUTE: "observe",
  MARINA_ARENA_ROUTING: "on",
  MARINA_ARENA_SHADOW_CHALLENGERS: "civiqs=nowcast|formation:ensemble:a,b;wikipedia=nowcast",
  MARINA_FORECAST_TRIAGE: "observe",
  MARINA_ARENA_SPREAD_CALIBRATION: "on",
  MARINA_ARENA_MOVE_WEIGHT: "on",
  MARINA_ROUTE_EVIDENCE: "observe",
  MARINA_FORECAST_ARBITER: "off",
  MARINA_DECISION_GATE: "on",
  MARINA_CHALLENGE_JUDGE: "observe",
  ...over,
});

describe("methods readout", () => {
  it("lists every selector with its mode and evidence from an injected route view", async () => {
    const db = new MarinaDB(":memory:");
    dbs.push(db);
    const { rows, notes } = await methodRows({
      store: () => db,
      env: () => env(),
      routeView: async () => ({
        rows: [
          row({}),
          row({ method: "formation:symbiosis:a,b", n: 10, verdict: "qualifies", earned: true }),
          row({
            evidence: "forecast",
            family: "number",
            method: "delphi",
            n: 3,
            verdict: "too few paired",
          }),
        ],
        notes: ["note from the view"],
      }),
    });
    const by = Object.fromEntries(rows.map((r) => [r.selector, r]));
    expect(Object.keys(by)).toEqual([
      "forecast routing (method cards)",
      "arena earned routes",
      "arena shadow challengers",
      "forecast shadow challengers",
      "intake triage",
      "arena spread calibration",
      "arena move weight",
      "benchmark route evidence (model:route)",
      "forecast arbiter",
      "decision gate",
      "judge · challenge",
      "judge · verify",
      "judge · attention",
      "judge · outcome",
    ]);
    expect(by["arena earned routes"]).toMatchObject({
      mode: "on",
      evidence: "1 family · 2 challenger(s) · 18 paired",
      state: "1 earned",
    });
    expect(by["forecast routing (method cards)"]).toMatchObject({
      mode: "observe",
      evidence: "1 family · 1 challenger(s) · 3 paired",
      state: "nothing at the bar",
    });
    expect(by["arena shadow challengers"]!.mode).toBe("on");
    expect(by["arena shadow challengers"]!.evidence).toContain("2 families configured");
    expect(by["intake triage"]!.mode).toBe("observe");
    expect(by["arena spread calibration"]!.mode).toBe("on");
    expect(by["benchmark route evidence (model:route)"]!.mode).toBe("observe");
    expect(by["decision gate"]!.mode).toBe("on");
    expect(by["judge · challenge"]).toMatchObject({ mode: "observe", state: "none earned" });
    expect(notes).toEqual(["note from the view"]);
    const text = stripAnsi(renderMethods(rows, notes));
    expect(text).toContain("Methods — every selector");
    expect(text).toContain("arena earned routes");
    expect(text).toContain("note from the view");
  });

  it("without a store it still lists every selector and says why counts are missing", async () => {
    const { rows, notes } = await methodRows({
      store: () => undefined,
      env: () => env({ MARINA_ARENA_SHADOW_CHALLENGERS: "" }),
    });
    expect(rows).toHaveLength(14);
    expect(rows.find((r) => r.selector === "arena shadow challengers")!.mode).toBe("off");
    expect(notes).toEqual(["no world database: evidence counts unavailable"]);
  });

  it("is a rank-0 read command", () => {
    const def = methodsCommand({ store: () => undefined });
    expect(def.name).toBe("methods");
    expect(def.minRank).toBe(0);
    expect(def.usage).toEqual([{ syntax: "methods", effect: "read" }]);
  });
});
