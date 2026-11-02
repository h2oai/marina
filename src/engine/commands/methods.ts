// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * `methods`: the one readout of every SELECTOR in the world — each place
 * Marina chooses a method, a route, a model or a verdict on evidence — with
 * its mode, the evidence it has, and whether anything has been earned. The
 * selectors grew up as islands (card routing, arena earned routes, triage,
 * shadows, the spread and move calibrators, benchmark route evidence, the
 * judges, the decision gate, the Arbiter); this is the first step of the
 * method-selection plan: see them in one place before any of them changes.
 * Read-only; no model call. `forecast routes`, `judge stats` and
 * `trace advise evidence` are the detailed views of the same evidence.
 */

import { spreadCalibrationModeFromEnv } from "../../arena/calibration";
import { arenaRoutingModeFromEnv } from "../../arena/earned-routes";
import { moveWeightModeFromEnv } from "../../arena/move-weight";
import { harnessDecisionProvider } from "../../decisions/engines";
import { judgeModeFor, judgeStandings } from "../../decisions/judges";
import { forecastArbiterModeFromEnv } from "../../forecast/arbiter";
import { loadRouteView, type RouteViewRow } from "../../forecast/route-view";
import { routeSettingsFromEnv } from "../../forecast/routing";
import { SHADOW_OWNER } from "../../forecast/routing-refs";
import { shadowSettingsFromEnv } from "../../forecast/shadow";
import { triageModeFromEnv } from "../../forecast/triage";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, RoomContext } from "../../types";
import { routeEvidenceSettingsFromEnv } from "../benchmark-evidence";

export const METHODS_USAGE = "Usage:\n  methods";

/** The world store slice the readout reads. */
export type MethodsStore = Pick<
  MarinaDB,
  "judgeLedgerTallies" | "listForecastAnswers" | "listArenaShadow"
>;

export interface MethodsDeps {
  store: () => MethodsStore | undefined;
  env?: () => NodeJS.ProcessEnv;
  /** The paired route evidence (`loadRouteView`); tests inject a fixed view. */
  routeView?: (
    db: MarinaDB,
  ) => Promise<{ rows: readonly RouteViewRow[]; notes: readonly string[] }>;
}

/** One selector's line: what it is, its mode, its evidence, what it has earned. */
export interface MethodRow {
  selector: string;
  mode: string;
  evidence: string;
  state: string;
}

function routeRowsSummary(rows: readonly RouteViewRow[], kind: RouteViewRow["evidence"]) {
  const mine = rows.filter((r) => r.evidence === kind);
  const families = new Set(mine.map((r) => r.family));
  const paired = mine.reduce((s, r) => s + r.n, 0);
  const earned = mine.filter((r) => r.earned).length;
  const bar = mine.filter((r) => r.verdict !== "too few paired").length;
  return { families: families.size, challengers: mine.length, paired, earned, bar };
}

/** The rows, pure over the store, the environment and the route view. */
export async function methodRows(
  deps: MethodsDeps,
): Promise<{ rows: MethodRow[]; notes: string[] }> {
  const env = deps.env?.() ?? process.env;
  const store = deps.store();
  const notes: string[] = [];
  let view: { rows: readonly RouteViewRow[]; notes: readonly string[] } = { rows: [], notes: [] };
  if (store) {
    try {
      view = await (deps.routeView ?? ((db) => loadRouteView(db, { env })))(store as MarinaDB);
      notes.push(...view.notes);
    } catch (err) {
      notes.push(`route evidence unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    notes.push("no world database: evidence counts unavailable");
  }
  const rows: MethodRow[] = [];
  const routing = routeSettingsFromEnv(env);
  const f = routeRowsSummary(view.rows, "forecast");
  rows.push({
    selector: "forecast routing (method cards)",
    mode: routing.mode,
    evidence: `${f.families} famil${f.families === 1 ? "y" : "ies"} · ${f.challengers} challenger(s) · ${f.paired} paired`,
    state: f.earned
      ? `${f.earned} earned`
      : f.bar
        ? "at the bar, none better"
        : "nothing at the bar",
  });
  const a = routeRowsSummary(view.rows, "arena");
  rows.push({
    selector: "arena earned routes",
    mode: arenaRoutingModeFromEnv(env),
    evidence: `${a.families} famil${a.families === 1 ? "y" : "ies"} · ${a.challengers} challenger(s) · ${a.paired} paired`,
    state: a.earned
      ? `${a.earned} earned`
      : a.bar
        ? "at the bar, none better"
        : "nothing at the bar",
  });
  const challengers = (env.MARINA_ARENA_SHADOW_CHALLENGERS ?? "").split(";").filter(Boolean);
  const shadowRows = store ? store.listArenaShadow({ limit: 5000 }).length : 0;
  rows.push({
    selector: "arena shadow challengers",
    mode: challengers.length ? "on" : "off",
    evidence: `${challengers.length} famil${challengers.length === 1 ? "y" : "ies"} configured · ${shadowRows} shadow record(s)`,
    state: "feeds arena earned routes",
  });
  const shadow = shadowSettingsFromEnv(env);
  const shadowAnswers = store ? store.listForecastAnswers(SHADOW_OWNER, 5000).length : 0;
  rows.push({
    selector: "forecast shadow challengers",
    mode: shadow ? "on" : "off",
    evidence: `${shadowAnswers} shadow answer(s)${shadow ? ` · ≤ ${shadow.maxPerDay}/day, cap $${shadow.capUsd}` : ""}`,
    state: "feeds forecast routing",
  });
  rows.push({
    selector: "intake triage",
    mode: triageModeFromEnv(env),
    evidence: "recorded on each answer (answer.triage)",
    state:
      triageModeFromEnv(env) === "on"
        ? "a lookup's read-off answers"
        : "observe or off: never answers",
  });
  rows.push({
    selector: "arena spread calibration",
    mode: spreadCalibrationModeFromEnv(env),
    evidence: "resolved filings per (family, series, method)",
    state: "scales every filed sd on `on`",
  });
  rows.push({
    selector: "arena move weight",
    mode: moveWeightModeFromEnv(env),
    evidence: "resolved filings per (family, method); held-out split",
    state: "applies only past its held-out bar",
  });
  const evidence = routeEvidenceSettingsFromEnv(env);
  rows.push({
    selector: "benchmark route evidence (model:route)",
    mode: evidence.mode,
    evidence: `objective ${evidence.objective} · min n ${evidence.minN}`,
    state: "picks among a role's own candidates",
  });
  rows.push({
    selector: "forecast arbiter",
    mode: forecastArbiterModeFromEnv(env),
    evidence: "resolved overrules (precision)",
    state: "overrules only with grounded citations",
  });
  const backend = harnessDecisionProvider(env);
  rows.push({
    selector: "decision gate",
    mode: (env.MARINA_DECISION_GATE ?? "off").trim().toLowerCase() || "off",
    evidence: backend ? `backend ${backend.kind}:${backend.model}` : "no decision backend",
    state: "restricts consequential tool calls",
  });
  for (const surface of ["challenge", "verify", "attention", "outcome"] as const) {
    const standings = store
      ? judgeStandings(store, {
          surface: surface === "attention" ? "attention:" : surface,
          env,
        })
      : [];
    const compared = standings.reduce((s, x) => s + x.compared, 0);
    const earned = standings.filter((s) => s.earned).length;
    rows.push({
      selector: `judge · ${surface}`,
      mode: judgeModeFor(surface, env).mode,
      evidence: `${standings.length} judge(s) · ${compared} compared`,
      state: earned ? `${earned} earned` : "none earned",
    });
  }
  return { rows, notes };
}

export function renderMethods(rows: readonly MethodRow[], notes: readonly string[]): string {
  const width = Math.max(...rows.map((r) => r.selector.length));
  const out = [
    header("Methods — every selector, its mode and its evidence"),
    separator(),
    ...rows.map(
      (r) =>
        `  ${bold(r.selector.padEnd(width))}  ${r.mode.padEnd(8)} ${r.evidence} ${dim(`· ${r.state}`)}`,
    ),
    dim("details: forecast routes · judge stats · trace advise evidence · arena shadow"),
    ...notes.map((n) => dim(n)),
  ];
  return out.join("\n");
}

export function methodsCommand(deps: MethodsDeps): CommandDef {
  return {
    name: "methods",
    category: "System",
    minRank: 0,
    usage: [{ syntax: "methods", effect: "read" }],
    help: `Every selector in the world — where Marina chooses a method, route, model or verdict on evidence — with its mode, its evidence and what it has earned. Read-only; no model call.\n${METHODS_USAGE}`,
    handler: async (ctx: RoomContext, input) => {
      const { rows, notes } = await methodRows(deps);
      ctx.send(input.entity, renderMethods(rows, notes));
    },
  };
}
