// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research briefs: what a researcher should look for before a round locks.
 * Each task family has a playbook of the evidence that actually moves its
 * number — other pollsters' readings of the same quantity, market moves for
 * investor sentiment, prices for inflation expectations, scheduled events for
 * search and pageview attention. Every brief is bounded to the window since
 * the series' last published value: older news is already in that value.
 */

import type { ArenaLock, ArenaRound } from "../types";

export interface ResearchBrief {
  roundId: string;
  /** ISO date of the last published value — evidence must be newer. */
  since: string;
  /** The research request, for a search-capable model. */
  request: string;
}

const PLAYBOOKS: Record<string, string[]> = {
  approval: [
    "Every national presidential job-approval poll published since that date: pollster, field dates, population (adults / registered / likely voters), approve and disapprove — AND that same pollster's previous reading, so the change is visible.",
    "Any poll-average updates (for example Silver Bulletin, RealClearPolitics, NYT, 538-style averages) since that date, with the numbers.",
    "Major news since that date likely to move approval: wars and foreign crises, economic shocks, prices, scandals, legislation, disasters.",
  ],
  generic: [
    "Every generic congressional ballot poll published since that date: pollster, field dates, population, Democratic and Republican shares — AND that pollster's previous reading.",
    "Poll-average updates for the generic ballot since that date.",
    "Major political news since that date likely to move partisan preference.",
  ],
  aaii: [
    "S&P 500 and Nasdaq performance since that date: closing levels and percentage changes, including the week ending on the survey's Wednesday.",
    "Market-moving news since that date: Fed decisions or speeches, inflation and jobs data, earnings, geopolitical shocks.",
    "Any other investor-sentiment readings since that date (CNN Fear & Greed, Investors Intelligence, NAAIM).",
  ],
  consumer: [
    "Gasoline and diesel prices since that date (AAA or EIA), with levels and changes.",
    "Inflation data released since that date (CPI, PCE) and their headline numbers.",
    "Stock-market and labor-market news since that date; any preliminary or partial reading of this same survey already published.",
  ],
  attention: [
    "Scheduled or likely events during the measured week for the items asked about: product launches, earnings, sports finals, premieres, elections, anniversaries.",
    "Breaking news since that date that is driving search or pageview interest in those items.",
    "For Wikipedia rankings: which articles are currently trending and why (deaths, sports, films, TV, elections).",
  ],
};

/** The playbook for a round, from its tracker and series (never the question prose). */
export function familyOf(round: ArenaRound): keyof typeof PLAYBOOKS {
  const tracker = round.tracker.toLowerCase();
  const series = `${round.series ?? ""} ${round.round_id}`.toLowerCase();
  if (tracker === "aaii") return "aaii";
  if (tracker === "google_trends" || tracker === "wikipedia") return "attention";
  if (tracker.startsWith("umich") || tracker === "ny_fed_sce") return "consumer";
  // Civiqs runs both political and economic trackers under one tracker name.
  if (/_econ_|family_finances|inflation/.test(series)) return "consumer";
  if (/generic|ballot|midterm/.test(series)) return "generic";
  return "approval";
}

export function buildResearchBrief(round: ArenaRound, lock: ArenaLock): ResearchBrief {
  const history = lock.answer_history ?? lock.history ?? [];
  const last = history.at(-1);
  const obsDay = lock.answer_obs?.at(-1)?.date;
  const since = last?.date ?? obsDay ?? round.lock_at.slice(0, 10);
  const lastLine = last
    ? `The benchmark's own reading of the latest wave (dated ${last.date}, the field start) is ${last.value} ${round.unit ?? ""}; that wave is ALREADY known — the question is about the next one.`.trim()
    : obsDay
      ? `The latest observed list is from ${obsDay}.`
      : "";
  const asks = PLAYBOOKS[familyOf(round)]!.map((a, i) => `${i + 1}. ${a}`);
  const request = [
    `A forecaster must predict: ${round.question}`,
    `The answer is published around ${round.release_at.slice(0, 10)}. ${lastLine}`,
    "",
    `Research ONLY facts dated after ${since}, and report:`,
    ...asks,
    "",
    "Rules: every fact needs its date and its source; give numbers exactly as published; say plainly when you found nothing for an item; do not forecast or give opinions.",
  ].join("\n");
  return { roundId: round.round_id, since, request };
}
