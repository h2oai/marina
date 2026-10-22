// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One read-only view of earned routing across both routers: per family and
 * challenger, the questions (forecast) or rounds (arena) paired with the
 * family's default, the challenger's win rate on them, the paired gain with
 * its 95 % interval, and whether the route is EARNED — the verdict of the one
 * shared rule (`earnedPick`: ≥ minN pairs, lower bound above 0, gain past
 * `promotionMargin(tried)`).
 *
 *   forecast  card evidence from the outcome rows (`family:` / `method:` tags,
 *             shadow challengers included) plus the history file's formation
 *             records, scored per class as card routing scores them
 *             (`classScores`), against the general default card
 *   arena     per-round skill from the arena tables and the shared outcome
 *             rows (`loadRouteEvidence`), against each family's route
 *             (`arenaRouteScores`)
 *
 * Nothing here changes a route or writes a row. Backs `forecast routes`.
 */

import { arenaRouteScores, type RouteEvidence } from "../arena/earned-routes";
import { getErrorMessage } from "../engine/errors";
import { bold, dim, header, separator } from "../net/ansi";
import type { MarinaDB } from "../persistence/database";
import { type CardEvidence, classScores } from "./card-routing";
import type { ResolvedRecord } from "./history";
import { recipeCard } from "./method-cards";
import { earnedPick, type PairedChallenger } from "./routing";

export interface RouteViewRow {
  evidence: "forecast" | "arena";
  family: string;
  /** The family's default (the card or route that answers without an earned route). */
  default: string;
  /** Questions / rounds the default has a score on. */
  defaultN: number;
  method: string;
  /** Questions / rounds both answered. */
  n: number;
  /** Share of the paired items the challenger scored higher on (ties count half). */
  winRate?: number;
  gain?: number;
  ci?: [number, number];
  verdict: PairedChallenger["verdict"];
  /** A candidate routing may choose (the operator's list); an earned route needs one. */
  candidate: boolean;
  /** The shared rule's verdict: this route would answer the family under routing `on`. */
  earned: boolean;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function winRate(
  challenger: Map<string, number> | undefined,
  incumbent: Map<string, number>,
): number | undefined {
  if (!challenger) return undefined;
  let wins = 0;
  let n = 0;
  for (const [q, s] of challenger) {
    const d = incumbent.get(q);
    if (d === undefined) continue;
    n++;
    wins += s > d ? 1 : s === d ? 0.5 : 0;
  }
  return n ? r3(wins / n) : undefined;
}

/**
 * Rows for one family from its per-item scores. Candidates come first in the
 * operator's order (so the fishing margin grows as routing's does), then
 * methods with evidence that routing would not consider (never earned).
 */
export function pairedRows(input: {
  evidence: RouteViewRow["evidence"];
  family: string;
  defaultId: string;
  scores: Map<string, Map<string, number>>;
  minN: number;
  /** The candidates routing considers (absent: every method on record). */
  candidates?: readonly string[];
}): RouteViewRow[] {
  const { scores, defaultId } = input;
  const onRecord = [...scores.keys()].filter((m) => m !== defaultId).sort();
  const listed = input.candidates?.filter((c) => c !== defaultId) ?? onRecord;
  const extras = onRecord.filter((m) => !listed.includes(m));
  const pick = earnedPick({ defaultId, candidates: listed, scores, minN: input.minN });
  const others = earnedPick({ defaultId, candidates: extras, scores, minN: input.minN });
  const incumbent = scores.get(defaultId) ?? new Map<string, number>();
  const rows: RouteViewRow[] = [];
  for (const [list, candidate] of [
    [pick.challengers, true],
    [others.challengers, false],
  ] as const) {
    for (const c of list) {
      // A listed candidate with no evidence at all is still shown (paired 0).
      const wr = winRate(scores.get(c.id), incumbent);
      rows.push({
        evidence: input.evidence,
        family: input.family,
        default: defaultId,
        defaultN: incumbent.size,
        method: c.id,
        n: c.n,
        ...(wr !== undefined ? { winRate: wr } : {}),
        ...(c.gain !== undefined ? { gain: c.gain } : {}),
        ...(c.ci ? { ci: c.ci } : {}),
        verdict: c.verdict,
        candidate,
        earned: candidate && c.verdict === "qualifies" && pick.best?.id === c.id,
      });
    }
  }
  return rows;
}

/** Forecast rows: one block per class with outcome evidence (optionally a prefix). */
export function forecastRouteRows(input: {
  evidence: readonly CardEvidence[];
  history?: readonly ResolvedRecord[];
  defaultCard: string;
  candidates: readonly string[];
  minN: number;
  family?: string;
}): RouteViewRow[] {
  const families = [...new Set(input.evidence.map((e) => e.family))]
    .filter((f) => !input.family || f.startsWith(input.family))
    .sort();
  return families.flatMap((family) =>
    pairedRows({
      evidence: "forecast",
      family,
      defaultId: input.defaultCard,
      scores: classScores(family, input.evidence, input.history ?? []),
      minN: input.minN,
      candidates: input.candidates,
    }),
  );
}

/** Arena rows: one block per family with evidence, against that family's route. */
export function arenaRouteRows(input: {
  evidence: RouteEvidence[];
  defaultFor: (family: string) => string | undefined;
  minN: number;
  now: number;
  family?: string;
}): RouteViewRow[] {
  const families = [...new Set(input.evidence.map((e) => e.family))]
    .filter((f) => !input.family || f.startsWith(input.family))
    .sort();
  return families.flatMap((family) => {
    const defaultSpec = input.defaultFor(family);
    if (!defaultSpec) return [];
    const { scores } = arenaRouteScores({
      family,
      defaultSpec,
      evidence: input.evidence,
      now: input.now,
    });
    return pairedRows({
      evidence: "arena",
      family,
      defaultId: defaultSpec,
      scores,
      minN: input.minN,
    });
  });
}

const pct = (x: number | undefined) => (x === undefined ? "—" : `${Math.round(x * 100)}%`);

/** The view as text, grouped by evidence and family. */
export function renderRouteView(
  rows: readonly RouteViewRow[],
  notes: readonly string[] = [],
): string {
  const out = [header("Earned routes"), separator()];
  if (rows.length === 0) out.push("No paired evidence on record yet.");
  let last = "";
  for (const r of rows) {
    const key = `${r.evidence}\u0000${r.family}`;
    if (key !== last) {
      out.push(
        `${bold(`${r.evidence} ${r.family}`)} ${dim(`default ${r.default} (${r.defaultN} scored)`)}`,
      );
      last = key;
    }
    const gain =
      r.gain === undefined ? "" : ` gain ${r.gain}${r.ci ? ` [${r.ci.join(", ")}]` : ""}`;
    out.push(
      `  ${r.earned ? bold("EARNED") : r.verdict.padEnd(14)} ${r.method} · paired ${r.n} · wins ${pct(r.winRate)}${gain}${r.candidate ? "" : dim(" · not a routing candidate")}`,
    );
  }
  for (const n of notes) out.push(dim(n));
  return out.join("\n");
}

/**
 * The whole view for a world: forecast evidence from its outcome rows (and the
 * history file when one is configured), arena evidence when an arena entrant
 * is configured (`arenaEvidence` reads it; a failure is a note, never an
 * error). Read-only.
 */
export async function loadRouteView(
  db: MarinaDB,
  opts: {
    env?: NodeJS.ProcessEnv;
    family?: string;
    now?: number;
    /** Arena evidence and each family's route (default: the configured arena's). */
    arena?: () => Promise<
      { evidence: RouteEvidence[]; defaultFor: (family: string) => string | undefined } | undefined
    >;
  } = {},
): Promise<{ rows: RouteViewRow[]; notes: string[] }> {
  const env = opts.env ?? process.env;
  const [{ readCardEvidence }, { routeSettingsFromEnv }, { resolveForecastDefaults }, history] =
    await Promise.all([
      import("./card-routing"),
      import("./routing"),
      import("./defaults"),
      import("./history"),
    ]);
  const notes: string[] = [];
  const settings = routeSettingsFromEnv(env);
  const defaultCard = recipeCard(resolveForecastDefaults({ env, db }).formation)?.id ?? "ensemble";
  let records: ResolvedRecord[] = [];
  try {
    records = (await history.historyFromEnv(env)?.all()) ?? [];
  } catch (err) {
    notes.push(`forecast history unreadable: ${getErrorMessage(err)}`);
  }
  const rows = forecastRouteRows({
    evidence: readCardEvidence(db),
    history: records,
    defaultCard,
    candidates: settings.cards ?? settings.candidates,
    minN: settings.minN,
    ...(opts.family ? { family: opts.family } : {}),
  });
  notes.push(
    `forecast: routing ${settings.mode}, min ${settings.minN} paired questions, default card ${defaultCard} (a board class uses its board's default)`,
  );
  const arena = opts.arena ?? (() => configuredArena(db, env));
  try {
    const a = await arena();
    if (a) {
      const { arenaRouteMinN, arenaRoutingModeFromEnv } = await import("../arena/earned-routes");
      const minN = arenaRouteMinN(env);
      rows.push(
        ...arenaRouteRows({
          evidence: a.evidence,
          defaultFor: a.defaultFor,
          minN,
          now: opts.now ?? Date.now(),
          ...(opts.family ? { family: opts.family } : {}),
        }),
      );
      notes.push(`arena: routing ${arenaRoutingModeFromEnv(env)}, min ${minN} paired rounds`);
    } else notes.push("arena: no entrant configured (MARINA_ARENA_ENTRANT)");
  } catch (err) {
    notes.push(`arena evidence unavailable: ${getErrorMessage(err)}`);
  }
  return { rows, notes };
}

/** The configured arena's route evidence and per-family routes, or undefined without one. */
async function configuredArena(
  db: MarinaDB,
  env: NodeJS.ProcessEnv,
): Promise<
  { evidence: RouteEvidence[]; defaultFor: (family: string) => string | undefined } | undefined
> {
  const [{ arenaConfigFromEnv }, { loadRouteEvidence }, { arenaData }, routing] = await Promise.all(
    [
      import("../arena/config"),
      import("../arena/earned-routes"),
      import("../arena/service"),
      import("../arena/routing"),
    ],
  );
  const config = arenaConfigFromEnv(env);
  if (!config) return undefined;
  const spec = config.forecaster;
  const routed = spec === "routed" || spec.startsWith("route:");
  const routes = routed ? routing.parseRoutes(spec, env) : undefined;
  const evidence = await loadRouteEvidence(db, arenaData(env), config.entrant, db, env);
  return {
    evidence,
    defaultFor: (family) => {
      if (!routes) return spec;
      const target = routing.routeFor(routes, family);
      return target === routing.SKIP || routing.isPinned(routes, family) ? undefined : target;
    },
  };
}
