// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Score forecasters on rounds the arena has already resolved, using exactly the
 * inputs each round froze at its lock — what any entrant saw then. This is the
 * workstation test: nothing is signed or filed. Scalar rounds only (the ones the
 * arena publishes a single value for); skill is against the arena's own
 * persistence (last value, sd 1.5), as on the leaderboard.
 *
 * Caveat for a model backend: a model whose training data extends past a
 * round's release could know the answer. Report its knowledge cutoff next to
 * the result, and trust only rounds after it.
 */

import type { ArenaData } from "./data";
import type { RoundForecast } from "./forecast";
import { PERSISTENCE_SD } from "./forecast";
import { crpsNormal, skill } from "./score";
import type { ArenaLock, ArenaRound } from "./types";

export type Forecaster = (round: ArenaRound, lock: ArenaLock) => Promise<RoundForecast>;

/** Called once a round's number is public, with what the forecaster filed for it. */
export type Learner = (
  round: ArenaRound,
  lock: ArenaLock,
  filed: { mean: number; sd: number },
  outcome: number,
) => void;

export interface RoundScore {
  roundId: string;
  tracker: string;
  outcome: number;
  persistenceCrps: number;
  /** forecaster name → { mean, sd, crps, skill } */
  results: Record<
    string,
    {
      mean: number;
      sd: number;
      crps: number;
      skill: number;
      note?: string;
      detail?: Record<string, unknown>;
    }
  >;
}

export interface FamilySummary {
  tracker: string;
  rounds: number;
  /** forecaster → mean skill, and rounds beating persistence */
  skill: Record<string, number>;
  wins: Record<string, number>;
}

export async function evaluateResolved(
  data: ArenaData,
  forecasters: Record<string, Forecaster>,
  opts: {
    limit?: number;
    concurrency?: number;
    tracker?: string;
    /**
     * Forecasters that learn: rounds then run one at a time in lock order, and
     * a round's outcome reaches its learner only when it was published before
     * the lock of the round being forecast — never earlier than it could live.
     */
    learners?: Record<string, Learner>;
  } = {},
): Promise<{ rounds: RoundScore[]; families: FamilySummary[]; overall: Record<string, number> }> {
  const resolved = await data.resolutions();
  const candidates = (await data.rounds())
    .filter(
      (r) =>
        r.target_type === "continuous_normal" &&
        typeof resolved[r.round_id]?.value === "number" &&
        (!opts.tracker || r.tracker === opts.tracker),
    )
    .sort((a, b) => a.lock_at.localeCompare(b.lock_at))
    .slice(-(opts.limit ?? 1000));

  const scores: RoundScore[] = [];
  const queue = [...candidates];
  const learners = opts.learners ?? {};
  const learning = Object.keys(learners).length > 0;
  const pending: Array<{
    round: ArenaRound;
    lock: ArenaLock;
    outcome: number;
    filed: Record<string, { mean: number; sd: number }>;
  }> = [];
  const reveal = (before: number) => {
    for (let i = 0; i < pending.length; ) {
      const p = pending[i]!;
      if (Date.parse(p.round.release_at) < before) {
        for (const [name, learn] of Object.entries(learners)) {
          const filed = p.filed[name];
          if (filed) learn(p.round, p.lock, filed, p.outcome);
        }
        pending.splice(i, 1);
      } else i++;
    }
  };
  const worker = async () => {
    for (let round = queue.shift(); round; round = queue.shift()) {
      if (learning) reveal(Date.parse(round.lock_at));
      const lock = await data.lock(round.round_id).catch(() => undefined);
      const history = lock?.answer_history ?? lock?.history ?? [];
      if (!lock || history.length === 0) continue;
      const outcome = resolved[round.round_id]!.value as number;
      const persistenceCrps = crpsNormal(history.at(-1)!.value, PERSISTENCE_SD, outcome);
      const results: RoundScore["results"] = {};
      for (const [name, forecast] of Object.entries(forecasters)) {
        try {
          const f = await forecast(round, lock);
          if (!f.topline) continue;
          const crps = crpsNormal(f.topline.mean, f.topline.sd, outcome);
          const extra = f as {
            fallback?: string;
            proposals?: unknown;
            trust?: number;
            critique?: string;
            lessonsUsed?: number;
            reason?: string;
            raw?: unknown;
            roles?: unknown;
          };
          const fallback = extra.fallback;
          // Keep what the forecaster did, not just what it filed — the diagnostics
          // that say whether the roles and memory are actually doing their jobs.
          const detail = Object.fromEntries(
            (["proposals", "trust", "critique", "lessonsUsed", "reason", "raw", "roles"] as const)
              .filter((k) => extra[k] !== undefined)
              .map((k) => [k, extra[k]]),
          );
          results[name] = {
            mean: f.topline.mean,
            sd: f.topline.sd,
            crps,
            skill: skill(crps, persistenceCrps),
            ...(fallback ? { note: fallback } : {}),
            ...(Object.keys(detail).length ? { detail } : {}),
          };
        } catch {
          // A forecaster that cannot answer a round simply has no score for it.
        }
      }
      scores.push({
        roundId: round.round_id,
        tracker: round.tracker,
        outcome,
        persistenceCrps,
        results,
      });
      if (learning) {
        const filed = Object.fromEntries(
          Object.entries(results).map(([n, r]) => [n, { mean: r.mean, sd: r.sd }]),
        );
        pending.push({ round, lock, outcome, filed });
      }
    }
  };
  const workers = learning ? 1 : Math.max(1, opts.concurrency ?? 4);
  await Promise.all(Array.from({ length: workers }, worker));
  scores.sort((a, b) => a.roundId.localeCompare(b.roundId));

  const names = Object.keys(forecasters);
  const summarize = (rows: RoundScore[]) => {
    const out: { skill: Record<string, number>; wins: Record<string, number> } = {
      skill: {},
      wins: {},
    };
    for (const n of names) {
      const s = rows.map((r) => r.results[n]?.skill).filter((x): x is number => x !== undefined);
      out.skill[n] = s.length ? s.reduce((a, b) => a + b, 0) / s.length : Number.NaN;
      out.wins[n] = s.filter((x) => x > 0).length;
    }
    return out;
  };
  const byTracker = new Map<string, RoundScore[]>();
  for (const s of scores) byTracker.set(s.tracker, [...(byTracker.get(s.tracker) ?? []), s]);
  const families = [...byTracker.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tracker, rows]) => ({ tracker, rounds: rows.length, ...summarize(rows) }));
  return { rounds: scores, families, overall: summarize(scores).skill };
}
