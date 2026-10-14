// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Earned routes: which forecaster answers an arena family, chosen per family
 * from held-out evidence instead of by hand — the general forecaster's
 * promotion rule (`earnedPick` in `src/forecast/routing.ts`) with the arena
 * family as the class.
 *
 *   default    the family's route in `MARINA_ARENA_ROUTES` (`routing.ts`); a
 *              `!`-pinned route or `skip` is never replaced
 *   incumbent  the family default's scores: our newest accepted filing of each
 *              resolved round (the version the board scored) whose method kind
 *              matches the default's (`formation:delphi`, `nowcast`, …, so a
 *              model upgrade does not reset the record), else a shadow record
 *              of the default's exact spec
 *   challenger every runnable forecaster spec with shadow records in the family
 *              (`arena_shadow`, the last record before each lock) — the
 *              operator decides which ones run (`MARINA_ARENA_SHADOW_CHALLENGERS`)
 *   evidence   per-round skill vs the arena's persistence (CRPS / energy /
 *              rank-biased overlap — `scoreShadow`), only for rounds resolved by
 *              now and whose outcome was not public before their lock
 *   the bar    ≥ `minN` rounds both answered, paired mean gain's 95 % lower
 *              bound above 0, gain past `promotionMargin(tried)`
 *
 * Short of the bar the default answers, so `on` (the default) is byte-identical
 * to hand routing until a challenger earns its family. `observe` records the
 * pick without acting on it; `off` skips the evidence read. Every decision is
 * recorded on the filing (`routing` in its detail).
 */

import { earnedPick, type PairedChallenger } from "../forecast/routing";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import { parseForecasterSpec } from "./config";
import type { ArenaData } from "./data";
import { outcomePublicBeforeLock, scoreShadow } from "./evaluate";
import { arenaMethod } from "./settle";

export type ArenaRoutingMode = "off" | "observe" | "on";

/** Fewest rounds a challenger and the default both answered before it is considered. */
export const DEFAULT_ARENA_ROUTE_MIN_N = 8;

export function arenaRoutingModeFromEnv(env: NodeJS.ProcessEnv = process.env): ArenaRoutingMode {
  const m = env.MARINA_ARENA_ROUTING?.trim().toLowerCase();
  return m === "off" || m === "observe" ? m : "on";
}

export function arenaRouteMinN(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.MARINA_ARENA_ROUTE_MIN_N ?? "", 10);
  return Number.isFinite(n) && n >= 5 ? n : DEFAULT_ARENA_ROUTE_MIN_N;
}

/** One forecaster's score on one resolved round. */
export interface RouteEvidence {
  roundId: string;
  /** The round's tracker (the arena family). */
  family: string;
  /** `filed` = our scored filing; `shadow` = a shadow record. */
  source: "filed" | "shadow";
  /** The runnable forecaster spec (a filing: the spec its note names). */
  spec: string;
  /** Skill vs the arena's persistence (higher is better). */
  skill: number;
  /** When the outcome became public (epoch ms). */
  visibleAt: number;
}

export interface ArenaRouteDecision {
  mode: ArenaRoutingMode;
  family: string;
  /** The family's route in `MARINA_ARENA_ROUTES`. */
  default: string;
  /** The forecaster that answered. */
  chosen: string;
  /** What routing picked (differs from `chosen` only under `observe`). */
  picked: string;
  pinned?: true;
  /** Resolved rounds of the default's method on record. */
  incumbentN: number;
  challengers: PairedChallenger[];
  /** Newest evidence used (ISO; every one public by the decision). */
  through?: string;
  reason: string;
}

/** The kind of a spec, the incumbent's identity across model generations. */
export function specKind(spec: string): string {
  return arenaMethod(`route x → ${spec}`).methodKind;
}

function runnable(spec: string): boolean {
  if (spec === "routed" || spec.startsWith("route:")) return false;
  try {
    parseForecasterSpec(spec);
    return true;
  } catch {
    return false;
  }
}

/** Pure: the route for one family given the evidence visible at `now`. */
export function chooseArenaRoute(input: {
  family: string;
  defaultSpec: string;
  evidence: RouteEvidence[];
  now: number;
  mode: Exclude<ArenaRoutingMode, "off">;
  minN: number;
  pinned?: boolean;
}): ArenaRouteDecision {
  const { family, defaultSpec, mode } = input;
  const base = { mode, family, default: defaultSpec };
  if (input.pinned) {
    return {
      ...base,
      chosen: defaultSpec,
      picked: defaultSpec,
      pinned: true,
      incumbentN: 0,
      challengers: [],
      reason: "pinned route: not replaced by evidence",
    };
  }
  const visible = input.evidence.filter(
    (e) => e.family === family && e.visibleAt <= input.now && Number.isFinite(e.skill),
  );
  const kind = specKind(defaultSpec);
  // Incumbent: the scored filing of the default's kind, else a shadow of its exact spec.
  const incumbent = new Map<string, number>();
  for (const e of visible) {
    if (e.source === "filed" && specKind(e.spec) === kind) incumbent.set(e.roundId, e.skill);
  }
  for (const e of visible) {
    if (e.source === "shadow" && e.spec === defaultSpec && !incumbent.has(e.roundId))
      incumbent.set(e.roundId, e.skill);
  }
  const scores = new Map<string, Map<string, number>>([[defaultSpec, incumbent]]);
  for (const e of visible) {
    if (e.spec === defaultSpec || (e.source === "filed" && specKind(e.spec) === kind)) continue;
    if (!runnable(e.spec)) continue;
    const by = scores.get(e.spec) ?? new Map<string, number>();
    by.set(e.roundId, e.skill);
    scores.set(e.spec, by);
  }
  const candidates = [...scores.keys()].filter((s) => s !== defaultSpec).sort();
  const pick = earnedPick({ defaultId: defaultSpec, candidates, scores, minN: input.minN });
  const newest = visible.reduce((t, e) => Math.max(t, e.visibleAt), 0);
  return {
    ...base,
    chosen: mode === "on" ? pick.picked : defaultSpec,
    picked: pick.picked,
    incumbentN: incumbent.size,
    challengers: pick.challengers,
    ...(newest > 0 ? { through: new Date(newest).toISOString() } : {}),
    reason: pick.best
      ? `${pick.best.id} beat the default by ${pick.best.gain} [${pick.best.ci!.join(", ")}] on ${pick.best.n} paired rounds (margin ${pick.best.margin})`
      : candidates.length === 0
        ? "no challenger on record: the default stands"
        : "no challenger cleared the bar: the default stands",
  };
}

/** Strip a shadow variant's settings fingerprint (`<spec>#<fp>`). */
function shadowSpec(forecaster: string): string {
  const hash = forecaster.indexOf("#");
  return hash < 0 ? forecaster : forecaster.slice(0, hash);
}

/**
 * Every scored round on record: our newest accepted filing per resolved round
 * and every runnable shadow forecaster's last pre-lock record, with the time
 * each outcome became public. Rounds whose outcome was public before their
 * lock are left out, as in every arena evaluation.
 */
export async function loadRouteEvidence(
  store: Pick<ArenaStore, "listArenaSubmissions" | "listArenaShadow">,
  data: ArenaData,
  entrant: string,
): Promise<RouteEvidence[]> {
  const [resolved, rounds] = await Promise.all([data.resolutions(), data.rounds()]);
  const byId = new Map(rounds.map((r) => [r.round_id, r]));
  const FILED = "\u0000filed\u0000";
  const rows: Array<{
    round_id: string;
    forecaster: string;
    forecast: string;
    cost_usd: number;
    created_at: number;
  }> = [];
  const seen = new Set<string>();
  for (const row of store.listArenaSubmissions({ entrant, limit: 500 })) {
    if (row.status !== "accepted" || seen.has(row.round_id)) continue;
    seen.add(row.round_id);
    const body = JSON.parse(row.body) as { notes?: string };
    const spec = arenaMethod(body.notes).method;
    rows.push({
      round_id: row.round_id,
      forecaster: `${FILED}${spec}`,
      forecast: row.body,
      cost_usd: 0,
      created_at: row.created_at,
    });
  }
  for (const row of store.listArenaShadow({ limit: 2_000 })) {
    const spec = shadowSpec(row.forecaster);
    if (!runnable(spec)) continue;
    rows.push({ ...row, forecaster: spec });
  }
  const out: RouteEvidence[] = [];
  for (const s of await scoreShadow(data, rows)) {
    const round = byId.get(s.roundId) ?? (await data.round(s.roundId));
    if (!round) continue;
    const resolution = resolved[s.roundId];
    if (outcomePublicBeforeLock(round, resolution?.observed_date)) continue;
    const at = Date.parse(
      typeof resolution?.resolved_at === "string" ? resolution.resolved_at : round.release_at,
    );
    const filed = s.forecaster.startsWith(FILED);
    out.push({
      roundId: s.roundId,
      family: s.tracker,
      source: filed ? "filed" : "shadow",
      spec: filed ? s.forecaster.slice(FILED.length) : s.forecaster,
      skill: s.skill,
      visibleAt: Number.isFinite(at) ? at : Number.POSITIVE_INFINITY,
    });
  }
  return out;
}

/**
 * `MARINA_ARENA_SHADOW_CHALLENGERS="<family>=<spec>|<spec>;<family>=<spec>"`:
 * the challengers the operator chooses to run in shadow per family (`arena
 * shadow challengers`). Nothing paid runs unless it is listed here.
 */
export function parseShadowChallengers(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const raw = env.MARINA_ARENA_SHADOW_CHALLENGERS?.trim();
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`challenger entry "${entry}" must be <family>=<spec>[|<spec>]`);
    const family = entry.slice(0, eq).trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(family))
      throw new Error(`challenger family "${family}" is not a tracker id`);
    const specs = entry
      .slice(eq + 1)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const spec of specs) {
      if (!runnable(spec)) throw new Error(`challenger "${spec}" is not a forecaster spec`);
    }
    out.set(family, [...new Set([...(out.get(family) ?? []), ...specs])]);
  }
  return out;
}
