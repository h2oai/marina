// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research briefs: what a researcher should look for before a round locks.
 * Each task family has a playbook of the evidence that actually moves its
 * number — other pollsters' readings of the same quantity, market moves for
 * investor sentiment, prices for inflation expectations, scheduled events for
 * search and pageview attention. Every brief is bounded to the window since
 * the series' latest known reading — the daily nowcast's date when one exists
 * (Civiqs), else the last published value: older news is already in it.
 */

import { cellLabels } from "../profile-shape";
import type { ArenaLock, ArenaRound } from "../types";

export interface ResearchBrief {
  roundId: string;
  /** ISO date of the latest known reading (nowcast, else last published value) — evidence must be newer. */
  since: string;
  /** The research request, for a search-capable model. */
  request: string;
  /** Short keyword queries, one per playbook item, for a search API (Tavily). */
  queries?: string[];
}

/** The freshest reading known before the round (the Civiqs daily nowcast). */
export interface BriefNowcast {
  date: string;
  value: number;
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

/** Search-API queries per playbook (keywords, not prose; dated by the request's `since`). */
const QUERIES: Record<string, string[]> = {
  approval: [
    "new presidential job approval poll",
    "presidential approval rating polling average",
    "news affecting presidential approval",
  ],
  generic: [
    "generic congressional ballot poll",
    "generic ballot polling average",
    "midterm election news partisan preference",
  ],
  aaii: [
    "S&P 500 Nasdaq weekly performance",
    "stock market news Fed inflation jobs",
    "investor sentiment Fear Greed index",
  ],
  consumer: [
    "national average gas prices AAA EIA",
    "CPI inflation report",
    "consumer sentiment survey stock market jobs",
  ],
  attention: ["trending news this week", "most viewed Wikipedia articles this week"],
};

/**
 * A round with no published value at all (no history, no observed list): the
 * question is the LEVEL itself, not a change from a known reading, so the
 * researcher looks for forecasts of the quantity, market prices and the base
 * rate — whatever the family.
 */
const NO_HISTORY_PLAYBOOK = [
  "The most recent published forecasts of this exact quantity — forecasting models, expert ratings, analysts' projections: the source, its date, the point estimate and any range or interval it gives.",
  "Prediction-market or betting prices bearing on this quantity: venue, date, the contract and its price.",
  "The latest data those forecasts rest on (polls, ratings, counts so far), and the value of this same quantity at comparable past occasions (the base rate).",
];

/** How far back a no-history brief searches (days before now, or the lock if earlier). */
export const NO_HISTORY_LOOKBACK_DAYS = 30;

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

/**
 * `opts.nowcast` — the base forecast's daily reading for this series (the
 * Civiqs nowcast, `RoundForecast.nowcast[round.series]`): when it is newer than
 * the last published value, the search window starts at ITS date, not the
 * week-old history point.
 */
export function buildResearchBrief(
  round: ArenaRound,
  lock: ArenaLock,
  opts: {
    nowcast?: BriefNowcast;
    now?: number;
    /** Profile rounds: the start forecast's nowcast reading per cell (Civiqs). */
    cellNowcasts?: Record<string, BriefNowcast>;
  } = {},
): ResearchBrief {
  if (round.target_type === "profile_energy" && (round.cells?.length ?? 0) >= 2) {
    const brief = profileBrief(round, lock, opts.cellNowcasts ?? {});
    if (brief) return brief;
  }
  const history = lock.answer_history ?? lock.history ?? [];
  const last = history.at(-1);
  const obsDay = lock.answer_obs?.at(-1)?.date;
  if (!last && !obsDay && !opts.nowcast) return noHistoryBrief(round, opts.now ?? Date.now());
  const nowcast =
    opts.nowcast && (!last || opts.nowcast.date > last.date) ? opts.nowcast : undefined;
  const since = nowcast?.date ?? last?.date ?? obsDay ?? round.lock_at.slice(0, 10);
  const lastLine = nowcast
    ? `The benchmark is a smoothed daily tracker; its reading on ${nowcast.date} is ${nowcast.value} ${round.unit ?? ""} and is ALREADY known — the question is where it stands on the release day.`.trim()
    : last
      ? `The benchmark's own reading of the latest wave (dated ${last.date}, the field start) is ${last.value} ${round.unit ?? ""}; that wave is ALREADY known — the question is about the next one.`.trim()
      : obsDay
        ? `The latest observed list is from ${obsDay}.`
        : "";
  const family = familyOf(round);
  const asks = PLAYBOOKS[family]!.map((a, i) => `${i + 1}. ${a}`);
  const request = [
    `A forecaster must predict: ${round.question}`,
    `The answer is published around ${round.release_at.slice(0, 10)}. ${lastLine}`,
    "",
    `Research ONLY facts dated after ${since}, and report:`,
    ...asks,
    "",
    "Rules: every fact needs its date and its source; give numbers exactly as published; say plainly when you found nothing for an item; do not forecast or give opinions.",
  ].join("\n");
  // Attention rounds are about the items the question names; search for them.
  const queries =
    family === "attention"
      ? [round.question, ...(QUERIES.attention ?? [])]
      : [...(QUERIES[family] ?? [])];
  return { roundId: round.round_id, since, request, queries };
}

/**
 * The brief for a round with nothing published yet: search the last
 * {@link NO_HISTORY_LOOKBACK_DAYS} days (ending now, or at the lock when that
 * is earlier) for forecasts, prices and base rates of the level itself.
 */
function noHistoryBrief(round: ArenaRound, now: number): ResearchBrief {
  const lockMs = Date.parse(round.lock_at);
  const end = Number.isFinite(lockMs) ? Math.min(now, lockMs) : now;
  const since = new Date(end - NO_HISTORY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const asks = NO_HISTORY_PLAYBOOK.map((a, i) => `${i + 1}. ${a}`);
  const request = [
    `A forecaster must predict: ${round.question}`,
    `The answer is published around ${round.release_at.slice(0, 10)}. No value of this quantity has been published yet — there is no history and no earlier reading to start from, so the forecast rests on outside evidence of the level itself.`,
    "",
    `Research facts dated after ${since} (older facts only when they are still the latest of their kind), and report:`,
    ...asks,
    "",
    "Rules: every fact needs its date and its source; give numbers exactly as published; say plainly when you found nothing for an item; do not forecast or give opinions.",
  ].join("\n");
  const q = round.question.slice(0, 300);
  return {
    roundId: round.round_id,
    since,
    request,
    queries: [q, `${q} forecast`, `${q} prediction market odds`],
  };
}

/** Most per-item search queries a profile brief adds (attention baskets name searchable items). */
const MAX_ITEM_QUERIES = 8;

/**
 * The brief for a profile round (a Trends basket, subgroup profiles): the
 * family's playbook, asked ITEM BY ITEM for the round's cells, bounded to the
 * window since the latest known value of any cell (a cell's nowcast reading
 * where it is newer than its history). For an attention basket every item
 * also gets its own search query, since scheduled events — launches,
 * premieres, earnings, finals — move one item's share of the basket. Undefined
 * when no cell has any value (the no-history brief then applies).
 */
function profileBrief(
  round: ArenaRound,
  lock: ArenaLock,
  nowcasts: Record<string, BriefNowcast>,
): ResearchBrief | undefined {
  const cells = round.cells ?? [];
  const labels = cellLabels(cells);
  const latest: Record<string, BriefNowcast> = {};
  for (const c of cells) {
    const last = lock.answer_history_by_cell?.[c]?.at(-1);
    const n = nowcasts[c];
    const pick = n && (!last || n.date > last.date) ? n : last;
    if (pick) latest[c] = { date: pick.date, value: pick.value };
  }
  const dates = Object.values(latest).map((p) => p.date);
  if (dates.length === 0) return undefined;
  const since = dates.sort().at(-1)!;
  const known = cells
    .filter((c) => latest[c])
    .map((c) => `${labels[c]} ${latest[c]!.value}`)
    .join(", ");
  const family = familyOf(round);
  const items = cells.map((c) => labels[c]).join(", ");
  const asks = [
    ...PLAYBOOKS[family]!,
    family === "attention"
      ? `For EACH item — ${items} — anything scheduled during the measured week or reported since that date that bears on that item specifically (launches, announcements, earnings, premieres, finals, outages, recalls); say "nothing found" for an item with nothing.`
      : `For EACH subgroup — ${items} — any poll crosstab since that date that reports it, with the same pollster's previous reading for that subgroup.`,
  ].map((a, i) => `${i + 1}. ${a}`);
  const request = [
    `A forecaster must predict, item by item (${cells.length} items): ${round.question}`,
    `The answer is published around ${round.release_at.slice(0, 10)}. The benchmark's own latest values (up to ${since}) are ALREADY known — ${known}${round.unit ? ` (${round.unit})` : ""} — the question is where each item stands in the next release.`,
    "",
    `Research ONLY facts dated after ${since}, and report:`,
    ...asks,
    "",
    "Rules: every fact needs its date and its source; give numbers exactly as published; say plainly when you found nothing for an item; do not forecast or give opinions.",
  ].join("\n");
  const queries =
    family === "attention"
      ? [
          round.question.slice(0, 300),
          ...cells.slice(0, MAX_ITEM_QUERIES).map((c) => `${labels[c]} news this week`),
          ...(QUERIES.attention ?? []),
        ]
      : [...(QUERIES[family] ?? []), "poll crosstabs by party age race education"];
  return { roundId: round.round_id, since, request, queries };
}
