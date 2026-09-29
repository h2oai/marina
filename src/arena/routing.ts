// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-family routing: one forecaster per tracker family, or `skip`.
 *
 *   route:civiqs=nowcast;aaii=formation:symbiosis:<m>,<m>;economist_yougov=skip;*=nowcast
 *
 * Families are the arena's tracker ids (`civiqs`, `aaii`, `economist_yougov`,
 * `morning_consult`, `umich_sentiment`, …); `*` is every family not named. A
 * `skip` family is not answered at all — the board scores an entrant's mean
 * over the rounds it answered, so a family where no forecaster beats
 * persistence is better left out than filed at ~0. `routed` is the measured
 * default map below (or `MARINA_ARENA_ROUTES`).
 *
 * Each route is checked with the same grammar as a top-level forecaster (no
 * nested routes).
 */

export const SKIP = "skip";

/** Thrown for a round whose family is routed to `skip`: submit/shadow/evaluate leave it unanswered. */
export class SkippedRound extends Error {
  constructor(readonly tracker: string) {
    super(`routed: ${tracker} is not answered (skip)`);
  }
}

/**
 * The map `routed` uses when `MARINA_ARENA_ROUTES` is unset: the free nowcast for
 * every family. Which family deserves which forecaster is an operator decision,
 * measured with `arena evaluate` / `arena shadow` and set in the environment.
 */
export const DEFAULT_ROUTES = "*=nowcast";

export interface Routes {
  byFamily: Map<string, string>;
  fallback: string;
}

/** The route list of a `route:` / `routed` spec (without validating sub-specs). */
export function parseRoutes(spec: string, env: NodeJS.ProcessEnv = process.env): Routes {
  const body =
    spec === "routed"
      ? env.MARINA_ARENA_ROUTES?.trim() || DEFAULT_ROUTES
      : spec.startsWith("route:")
        ? spec.slice("route:".length)
        : undefined;
  if (body === undefined) throw new Error(`not a routing spec: ${spec}`);
  const byFamily = new Map<string, string>();
  let fallback: string | undefined;
  for (const part of body.split(";")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`route "${entry}" must be <family>=<forecaster>`);
    const family = entry.slice(0, eq).trim().toLowerCase();
    const target = entry.slice(eq + 1).trim();
    if (!target) throw new Error(`route "${entry}" names no forecaster`);
    if (target.startsWith("route:") || target === "routed") {
      throw new Error(`route "${entry}": routes do not nest`);
    }
    if (!/^[a-z0-9_*-]+$/.test(family))
      throw new Error(`route family "${family}" is not a tracker id`);
    if (family === "*") fallback = target;
    else byFamily.set(family, target);
  }
  return { byFamily, fallback: fallback ?? "nowcast" };
}

/** Which forecaster (or `skip`) answers a tracker family. */
export function routeFor(routes: Routes, tracker: string): string {
  return routes.byFamily.get(tracker.toLowerCase()) ?? routes.fallback;
}
