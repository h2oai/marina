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
 *              (`arena_shadow`, the last record before each lock), its
 *              settings variants (`<spec>#<fingerprint>`) pooled into the spec
 *              and never across specs (`challengerPoolKey`) — the
 *              operator decides which ones run (`MARINA_ARENA_SHADOW_CHALLENGERS`)
 *   outcomes   the shared outcome rows too (`MARINA_ARENA_ROUTE_OUTCOMES`, default
 *              on): a mechanical forecast outcome tagged `family:<tracker>`,
 *              `method:<runnable spec>` and `arena:<round>` whose filed answer
 *              is a number (mean, sd) — scored by the same `scoreShadow`
 *              (identical skill scale, last record before the lock). Our own
 *              arena filer's rows (`marina:arena/<entrant>`, written by
 *              `settle.ts`) are the `filed` evidence already, and a (round,
 *              spec) the arena tables hold is never counted twice
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
import { outcomeRefs } from "../forecast/routing-refs";
import type { MarinaDB } from "../persistence/database";
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

/**
 * `MARINA_ARENA_ROUTE_OUTCOMES=on|off` (default on): whether route evidence
 * also reads the shared outcome rows (`family:` / `method:` / `arena:` tags).
 */
export function arenaRouteOutcomesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MARINA_ARENA_ROUTE_OUTCOMES?.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0");
}

/** The outcome-path reader route evidence can use (the world database). */
export type RouteOutcomeReader = Pick<MarinaDB, "listOutcomes" | "getForecastAnswer">;

/** One forecaster's score on one resolved round. */
export interface RouteEvidence {
  roundId: string;
  /** The round's tracker (the arena family). */
  family: string;
  /**
   * `filed` = our scored filing; `shadow` = a shadow record; `outcome` = a
   * scored answer another producer filed on the shared outcome path.
   */
  source: "filed" | "shadow" | "outcome";
  /** The runnable forecaster spec (a filing: the spec its note names). */
  spec: string;
  /**
   * A shadow record's settings variant (`<spec>#<fingerprint>`), when it named
   * one: the same runnable spec run under other settings (`challengerPoolKey`).
   */
  variant?: string;
  /** When the counted record was made (epoch ms), when known. */
  recordedAt?: number;
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

/**
 * The pool a recorded forecaster's evidence counts under: its runnable spec.
 *
 * A shadow record is named `<spec>#<fingerprint>` — the spec run under one set
 * of operator settings (`forecastSettings`: research flags, horizon policy,
 * judge, …). Those variants are pooled into their spec, because the spec is
 * what routing can choose and run: a route names `nowcast`, never a
 * fingerprint, and the settings it then runs with are the operator's
 * environment, not part of the route.
 *
 * Nothing else pools. Specs of one method KIND (`specKind`) stay apart as
 * challengers: `model:<a>` vs `model:<b>`, `formation:delphi:<panel A>` vs
 * `formation:delphi:<panel B>`, `tabh2o:regression` vs `tabh2o:forecast`,
 * `research:<analysts>` differ in what runs, and each is its own runnable
 * route. Only the incumbent follows its kind (`arenaRouteScores`), because the
 * default is ONE route filed round after round across model upgrades, not a
 * choice among concurrent configurations.
 */
export function challengerPoolKey(forecaster: string): string {
  const hash = forecaster.indexOf("#");
  return hash < 0 ? forecaster : forecaster.slice(0, hash);
}

/**
 * One record per (spec, round) among the pooled records: of a spec's settings
 * variants scored on the same round, the one recorded last before the lock
 * counts (first in order on a tie) — the rule a filing follows, and what
 * the evidence read before variants were kept apart. Filed and outcome rows
 * pass through unchanged.
 */
function onePerSpecRound(visible: readonly RouteEvidence[]): RouteEvidence[] {
  const chosen = new Map<string, RouteEvidence>();
  for (const e of visible) {
    if (e.source === "filed") continue;
    const key = `${e.spec}\u0000${e.roundId}`;
    const prior = chosen.get(key);
    if (!prior || (e.recordedAt ?? -Infinity) > (prior.recordedAt ?? -Infinity)) chosen.set(key, e);
  }
  return visible.filter(
    (e) => e.source === "filed" || chosen.get(`${e.spec}\u0000${e.roundId}`) === e,
  );
}

/**
 * Settings variants on record per spec in one family (visible at `now`): how
 * many fingerprints pooled into each runnable spec's evidence. Read-only.
 */
export function pooledVariants(input: {
  family: string;
  evidence: readonly RouteEvidence[];
  now: number;
}): Map<string, number> {
  const by = new Map<string, Set<string>>();
  for (const e of input.evidence) {
    if (e.family !== input.family || e.visibleAt > input.now || !e.variant) continue;
    const set = by.get(e.spec) ?? new Set<string>();
    set.add(e.variant);
    by.set(e.spec, set);
  }
  return new Map([...by].map(([spec, set]) => [spec, set.size]));
}

/**
 * Pure: one family's per-round skill per forecaster spec, visible at `now` —
 * the default's (its scored filings by method kind, else records of its exact
 * spec) and every runnable challenger's, each spec's settings variants pooled
 * (`challengerPoolKey`, one record per round: `onePerSpecRound`). What
 * `chooseArenaRoute` decides on and the read-only route view (`forecast
 * routes`) reports. Promotion stays per runnable spec.
 */
export function arenaRouteScores(input: {
  family: string;
  defaultSpec: string;
  evidence: RouteEvidence[];
  now: number;
}): {
  visible: RouteEvidence[];
  incumbent: Map<string, number>;
  scores: Map<string, Map<string, number>>;
} {
  const { family, defaultSpec } = input;
  const visible = onePerSpecRound(
    input.evidence.filter(
      (e) => e.family === family && e.visibleAt <= input.now && Number.isFinite(e.skill),
    ),
  );
  const kind = specKind(defaultSpec);
  // Incumbent: the scored filing of the default's kind, else a shadow of its exact spec.
  const incumbent = new Map<string, number>();
  for (const e of visible) {
    if (e.source === "filed" && specKind(e.spec) === kind) incumbent.set(e.roundId, e.skill);
  }
  for (const e of visible) {
    if (e.source !== "filed" && e.spec === defaultSpec && !incumbent.has(e.roundId))
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
  return { visible, incumbent, scores };
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
  const { visible, incumbent, scores } = arenaRouteScores(input);
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

/**
 * Every scored round on record: our newest accepted filing per resolved round
 * and every runnable shadow forecaster's last pre-lock record (per settings
 * variant, tagged with its pooled spec and `variant`), with the time
 * each outcome became public. Rounds whose outcome was public before their
 * lock are left out, as in every arena evaluation.
 */
export async function loadRouteEvidence(
  store: Pick<ArenaStore, "listArenaSubmissions" | "listArenaShadow">,
  data: ArenaData,
  entrant: string,
  /** The shared outcome rows (none, or `MARINA_ARENA_ROUTE_OUTCOMES=off`: arena tables only). */
  outcomes?: RouteOutcomeReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RouteEvidence[]> {
  const [resolved, rounds] = await Promise.all([data.resolutions(), data.rounds()]);
  const byId = new Map(rounds.map((r) => [r.round_id, r]));
  const FILED = "\u0000filed\u0000";
  const OUTCOME = "\u0000outcome\u0000";
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
  // Each settings variant is scored on its own last pre-lock record; the
  // variants of one spec are pooled afterwards (`challengerPoolKey`).
  for (const row of store.listArenaShadow({ limit: 2_000 })) {
    if (!runnable(challengerPoolKey(row.forecaster))) continue;
    rows.push(row);
  }
  if (outcomes && arenaRouteOutcomesEnabled(env)) {
    const held = new Set(
      rows.map(
        (r) =>
          `${r.forecaster.startsWith(FILED) ? r.forecaster.slice(FILED.length) : challengerPoolKey(r.forecaster)}\u0000${r.round_id}`,
      ),
    );
    rows.push(...outcomeRouteRows(outcomes, entrant, held, OUTCOME));
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
    const fromOutcome = s.forecaster.startsWith(OUTCOME);
    out.push({
      roundId: s.roundId,
      family: s.tracker,
      source: filed ? "filed" : fromOutcome ? "outcome" : "shadow",
      spec: filed
        ? s.forecaster.slice(FILED.length)
        : fromOutcome
          ? s.forecaster.slice(OUTCOME.length)
          : challengerPoolKey(s.forecaster),
      ...(!filed && !fromOutcome && s.forecaster.includes("#") ? { variant: s.forecaster } : {}),
      ...(s.recordedAt !== undefined ? { recordedAt: s.recordedAt } : {}),
      skill: s.skill,
      visibleAt: Number.isFinite(at) ? at : Number.POSITIVE_INFINITY,
    });
  }
  return out;
}

/**
 * Scoreable rows from the shared outcome path: mechanical forecast outcomes
 * tagged with a family, a runnable method spec and an arena round, whose filed
 * answer is a number with an sd. Our own arena filer's rows and every
 * (spec, round) the arena tables already hold (`held`) are left out, so nothing
 * is counted twice. The record's family is the round's own tracker, as for
 * every arena record (`scoreShadow`).
 */
function outcomeRouteRows(
  db: RouteOutcomeReader,
  entrant: string,
  held: Set<string>,
  marker: string,
): Array<{
  round_id: string;
  forecaster: string;
  forecast: string;
  cost_usd: number;
  created_at: number;
}> {
  const own = `marina:arena/${entrant}`;
  const out: ReturnType<typeof outcomeRouteRows> = [];
  for (const o of db.listOutcomes({ kind: "forecast", basis: "mechanical", limit: 10_000 })) {
    if (o.owner === own || !o.subject.startsWith("forecast:")) continue;
    const refs = outcomeRefs(o.refs_json);
    const family = refs.find((r) => r.startsWith("family:"))?.slice(7);
    const spec = refs.find((r) => r.startsWith("method:"))?.slice(7);
    const roundId = refs.find((r) => r.startsWith("arena:"))?.slice(6);
    if (!family || !spec || !roundId || !runnable(spec)) continue;
    const key = `${spec}\u0000${roundId}`;
    if (held.has(key)) continue;
    const answer = db.getForecastAnswer(Number(o.subject.slice("forecast:".length)));
    if (answer?.kind !== "number" || answer.mean === null || !(answer.sd !== null && answer.sd > 0))
      continue;
    held.add(key);
    out.push({
      round_id: roundId,
      forecaster: `${marker}${spec}`,
      forecast: JSON.stringify({ topline: { mean: answer.mean, sd: answer.sd } }),
      cost_usd: 0,
      created_at: answer.created_at,
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

/** A challenger run whose cost is a model panel (`formation:`, `crew:`, or with `+research`). */
export function costlyChallenger(spec: string): boolean {
  return /^(formation|crew):/.test(spec) || spec.includes("+research");
}

export interface ChallengerWork {
  roundId: string;
  spec: string;
}

/**
 * The challenger forecasts worth recording now, cheapest first, then by lock.
 * A round further than `nearHours` from its lock is recorded once (so earned
 * routing has a record even if a later run is missed); within `nearHours` it
 * is recorded again (the record that counts is the last before lock, as with
 * a filing — `recordShadow` itself skips one made in the last few hours).
 * `recorded(spec, roundId)` is the time of the spec's latest record, if any.
 */
export function planChallengerWork(input: {
  rounds: ReadonlyArray<{ round_id: string; tracker: string; lock_at: string }>;
  listed: Map<string, string[]>;
  recorded: (spec: string, roundId: string) => number | undefined;
  now: number;
  nearHours?: number;
}): ChallengerWork[] {
  const near = (input.nearHours ?? 24) * 3_600_000;
  const work: (ChallengerWork & { lock: number; costly: boolean })[] = [];
  for (const round of input.rounds) {
    const lock = Date.parse(round.lock_at);
    if (!Number.isFinite(lock) || lock <= input.now) continue;
    for (const spec of input.listed.get(round.tracker.toLowerCase()) ?? []) {
      const last = input.recorded(spec, round.round_id);
      const nearLock = lock - input.now <= near;
      if (last !== undefined && !(nearLock && lock - last > near)) continue;
      work.push({ roundId: round.round_id, spec, lock, costly: costlyChallenger(spec) });
    }
  }
  work.sort((a, b) => Number(a.costly) - Number(b.costly) || a.lock - b.lock);
  return work.map(({ roundId, spec }) => ({ roundId, spec }));
}
