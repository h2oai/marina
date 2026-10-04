// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ForecastBench question and resolution sets, as published in the
 * forecastbench-datasets repository: a round's question set is released at
 * 00:00 UTC on its forecast due date (`<due>-llm.json`, 500 questions: 250
 * market, 250 dataset) and must be answered by 23:59:59 UTC that day;
 * resolution sets follow as questions resolve.
 */

export const DATASETS_RAW =
  "https://raw.githubusercontent.com/forecastingresearch/forecastbench-datasets/main/datasets";

export const SOURCES = {
  market: ["kalshi", "manifold", "metaculus", "polymarket"],
  dataset: ["acled", "dbnomics", "fred", "wikipedia", "yfinance"],
} as const;

export interface FbQuestion {
  id: string;
  source: string;
  question: string;
  resolution_criteria?: string;
  background?: string;
  market_info_open_datetime?: string;
  market_info_close_datetime?: string;
  market_info_resolution_criteria?: string;
  url?: string;
  freeze_datetime?: string;
  freeze_datetime_value?: string;
  freeze_datetime_value_explanation?: string;
  source_intro?: string;
  /** Dataset questions: the dates to forecast; market questions: "N/A". */
  resolution_dates: string[] | string;
}

export interface FbQuestionSet {
  forecast_due_date: string;
  question_set: string;
  questions: FbQuestion[];
}

export interface FbResolution {
  id: string;
  source: string;
  resolution_date: string;
  resolved_to: number;
  resolved: boolean;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const isMarket = (q: Pick<FbQuestion, "source">) =>
  (SOURCES.market as readonly string[]).includes(q.source);

/** The dates a dataset question is forecast at (none for a market question). */
export function resolutionDates(q: FbQuestion): string[] {
  return Array.isArray(q.resolution_dates) ? q.resolution_dates : [];
}

/** Combination questions (an array id, pre-2025-10-26 sets) are not forecast. */
export function forecastable(q: FbQuestion): boolean {
  return typeof q.id === "string";
}

async function getJson(url: string, fetcher: Fetcher): Promise<unknown> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/** The question set due on `due` (YYYY-MM-DD), or the latest published one. */
export async function fetchQuestionSet(
  due: string | "latest",
  fetcher: Fetcher = fetch,
): Promise<FbQuestionSet> {
  let name = `${due}-llm.json`;
  if (due === "latest") {
    // `latest-llm.json` is a git symlink: served raw, its body is the target's file name.
    const res = await fetcher(`${DATASETS_RAW}/question_sets/latest-llm.json`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`GET latest-llm.json → ${res.status}`);
    const body = (await res.text()).trim();
    const target = /^(\d{4}-\d{2}-\d{2}-llm\.json)$/.exec(body)?.[1];
    if (!target) {
      const set = JSON.parse(body) as FbQuestionSet;
      if (!set?.forecast_due_date || !Array.isArray(set.questions)) {
        throw new Error("latest-llm.json is not a question set");
      }
      return set;
    }
    name = target;
  }
  const set = (await getJson(`${DATASETS_RAW}/question_sets/${name}`, fetcher)) as FbQuestionSet;
  if (!set?.forecast_due_date || !Array.isArray(set.questions)) {
    throw new Error(`${name} is not a question set`);
  }
  return set;
}

export async function fetchResolutionSet(
  due: string,
  fetcher: Fetcher = fetch,
): Promise<FbResolution[]> {
  const r = (await getJson(
    `${DATASETS_RAW}/resolution_sets/${due}_resolution_set.json`,
    fetcher,
  )) as { resolutions?: FbResolution[] };
  return r.resolutions ?? [];
}
