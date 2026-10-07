// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Disk caches behind the dataset priors (`./priors.ts`): past rounds'
 * question and resolution sets (the published outcomes reference classes are
 * built from) and series histories as of a cutoff. A history is cached per
 * series and last visible day, so a backtest never reuses a later read.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SeriesHistory,
  type SeriesRef,
  lastVisibleDay,
  seriesHistory,
} from "../../src/forecast/series-history";
import { resolvedRounds } from "./backtest";
import {
  type FbQuestionSet,
  type FbResolution,
  type Fetcher,
  fetchQuestionSet,
  fetchResolutionSet,
} from "./dataset";
import { type DatasetPrior, datasetPriors, type HistoryFn, publishedOutcomes } from "./priors";

/** Resolution sets gain outcomes as questions resolve: re-read one older than this. */
const RESOLUTION_MAX_AGE_MS = 12 * 3_600_000;

function cachedJson<T>(path: string, maxAgeMs?: number): T | undefined {
  if (!existsSync(path)) return undefined;
  if (maxAgeMs !== undefined && Date.now() - statSync(path).mtimeMs > maxAgeMs) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function save(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** Every resolved round due before `due`, with its question and resolution sets. */
export async function pastRounds(
  dir: string,
  due: string,
  fetcher: Fetcher = fetch,
): Promise<Array<{ set: FbQuestionSet; resolutions: FbResolution[] }>> {
  const out: Array<{ set: FbQuestionSet; resolutions: FbResolution[] }> = [];
  for (const d of (await resolvedRounds(fetcher)).filter((d) => d < due)) {
    const qp = join(dir, "history", `${d}-questions.json`);
    const rp = join(dir, "history", `${d}-resolutions.json`);
    const set = cachedJson<FbQuestionSet>(qp) ?? (await fetchQuestionSet(d, fetcher));
    if (!existsSync(qp)) save(qp, set);
    let resolutions = cachedJson<FbResolution[]>(rp, RESOLUTION_MAX_AGE_MS);
    if (!resolutions) {
      resolutions = await fetchResolutionSet(d, fetcher);
      save(rp, resolutions);
    }
    out.push({ set, resolutions });
  }
  return out;
}

/** Series histories through a disk cache keyed by series and last visible day. */
export function cachedHistory(dir: string, env: NodeJS.ProcessEnv = process.env): HistoryFn {
  const fredApiKey = env.FRED_API_KEY?.trim() || undefined;
  return async (ref: SeriesRef, cutoff: Date) => {
    const safe = ref.id.replace(/[^A-Za-z0-9_.@^=-]+/g, "_");
    const path = join(dir, "series", ref.source, `${safe}@${lastVisibleDay(cutoff)}.json`);
    const hit = cachedJson<SeriesHistory>(path);
    if (hit) return hit;
    const h = await seriesHistory(ref, cutoff, fredApiKey ? { fredApiKey } : {});
    if (!("error" in h)) save(path, h);
    return h;
  };
}

/** A round's dataset priors, written beside the round for the audit trail and the fallbacks. */
export async function roundPriors(
  dir: string,
  set: FbQuestionSet,
  opts: { log?: (s: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<Map<string, DatasetPrior>> {
  const rounds = await pastRounds(dir, set.forecast_due_date);
  const { priors, errors } = await datasetPriors(set, set.questions, {
    history: cachedHistory(dir, opts.env),
    outcomes: publishedOutcomes(rounds),
  });
  save(join(dir, set.forecast_due_date, "priors.json"), Object.fromEntries(priors));
  opts.log?.(
    `statistical priors: ${priors.size} dataset questions (${rounds.length} past rounds of outcomes)${errors.length ? ` · ${errors.length} without a series (${errors.slice(0, 3).join("; ")})` : ""}`,
  );
  return priors;
}

/** The priors `roundPriors` saved for a round (for `write` fallbacks), if any. */
export function savedPriors(dir: string, due: string): Map<string, DatasetPrior> | undefined {
  const saved = cachedJson<Record<string, DatasetPrior>>(join(dir, due, "priors.json"));
  return saved ? new Map(Object.entries(saved)) : undefined;
}
