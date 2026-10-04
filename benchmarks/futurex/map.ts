// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A FutureX row → a general typed forecast request (src/forecast/typed.ts).
 * This is the whole adapter's "understanding" of the competition: reading the
 * answer shape a row asks for. Nothing here reaches Marina's core.
 *
 *   lettered options ("A. …")                 → choice (L1, and option-bearing L3/L4)
 *                                                or multi (L2, unless the options
 *                                                are mutually exclusive ranges or
 *                                                count buckets)
 *   "how many" / "Report the value in …" /
 *   an inline unit (", in knots,") /
 *   a numeric "what … value" /
 *   a statistic titled by series and period    → number (integer for counts)
 *   "which club will be first"                 → text (one top entry)
 *   ordered, "which N", "which <plural>" or
 *   "winners of the N …" lists                  → ranking (size when stated)
 *   anything else                              → text
 *
 * Checked against every resolved row's truth shape (the 2026-10 failure
 * analysis found 15 of 160 clean-backtest rows mistyped; 14 are fixed, the
 * 15th resolved to a void outcome, which no answer shape expresses).
 *
 * The full prompt rides along as `context` (it carries the settlement rules
 * and the requested format); the row's end time becomes the evidence cutoff.
 */

import type { AnswerOption, AnswerSpec } from "../../src/forecast/answer-types";
import type { TypedForecastRequest } from "../../src/forecast/typed";
import type { FuturexRow } from "./dataset";

// Ids run A–Z and, past 26 options, on through the ASCII characters after Z ([ \ ] ^ _ `).
const OPTION_LINE = /^\s*([A-Z[\\\]^_`])\.\s+(.+?)\s*"?\s*$/;

/** The lettered options in a prompt (in order), labels without "the outcome be". */
export function parseOptions(prompt: string): AnswerOption[] {
  const out: AnswerOption[] = [];
  for (const line of prompt.split("\n")) {
    const m = line.match(OPTION_LINE);
    if (!m) continue;
    if (out.some((o) => o.id === m[1])) continue;
    out.push({
      id: m[1]!,
      label: m[2]!
        .replace(/^the outcome be\s+/i, "")
        .replace(/"$/, "")
        .trim(),
    });
  }
  // Options run A, B, C… — anything else is prose that happened to start with a capital.
  if (out.every((o, i) => o.id === String.fromCharCode(65 + i)) && out.length >= 2) return out;
  return boxedAlternatives(prompt);
}

/**
 * The older prompt format names its outcomes as boxed alternatives —
 * `\boxed{Yes} or \boxed{No}` — instead of lettered lines. Each becomes an
 * option whose id is the outcome itself (the format the truth uses).
 */
export function boxedAlternatives(prompt: string): AnswerOption[] {
  const line = prompt.split("\n").find((l) => /\\boxed\{[^}]+\}\s+or\s+\\boxed\{/.test(l));
  if (!line) return [];
  const ids = [...line.matchAll(/\\boxed\{([^}]+)\}/g)].map((m) => m[1]!.trim()).filter(Boolean);
  const unique = [...new Set(ids)];
  return unique.length >= 2 && !unique.some((id) => /YOUR_PREDICTION/i.test(id))
    ? unique.map((id) => ({ id }))
    : [];
}

/**
 * Questions whose truth is a SET of options: nominations, who qualifies,
 * bundles of independent outcomes ("prop bets", "head to heads", what someone
 * will say, thresholds that each resolve on their own).
 */
const MULTI_CUE =
  /\b(nominees?|nominat\w*|qualif\w*|prop bets?|head[- ]to[- ]heads?|will .* say (?:in|during|at|on)\b|mention\w*|select all|all that apply|which of (the following|these) will|top (\d+|three|five|ten)|what will happen|what will be true|traded|playoffs|reach the \w* ?final|predictions|add (responses|answers))\b|___|^\s*which \w+s\b|\bwho will (make|be in|finish top)/i;

/** Cumulative thresholds ("at least 300", "above 50", "reach $11.50"): each option resolves on its own. */
const THRESHOLD_LABEL =
  /^(?:.*\b(?:at least|above|over|more than|reach|hit)\b|.*(?:≥|\+)\s*\d|x\s*≥)/i;

function isThresholdSet(options: AnswerOption[]): boolean {
  const n = options.filter((o) => THRESHOLD_LABEL.test(o.label ?? "")).length;
  return n >= Math.max(2, Math.ceil(options.length * 0.6));
}

const RANGE = /\b(range|band|bracket|occupy|between)\b/i;
const RANGEY_LABEL =
  /(or (lower|higher|fewer|more|less|above|below)|\bto\b|–|-\s*\d|\bbelow\b|\babove\b)/i;

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** The list size a title asks for ("top five", "three largest", "first and second"). */
export function listSize(title: string): number | undefined {
  const t = title.toLowerCase();
  const span = t.match(/ranked from (\d+) to (\d+)/);
  if (span) {
    const n = Number(span[2]) - Number(span[1]) + 1;
    if (n >= 1 && n <= 50) return n;
  }
  if (/first,? second,? and third/.test(t)) return 3;
  if (/first and second/.test(t)) return 2;
  const m = t.match(
    /\b(?:top|first|the|which|ordered(?: top)?)\s+(two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b/,
  );
  const word =
    m?.[1] ??
    t.match(
      /\b(two|three|four|five|six|seven|eight|nine|ten)\s+(?:largest|highest|biggest|lowest|most|top)\b/,
    )?.[1];
  if (!word) return undefined;
  const n = NUMBER_WORDS[word] ?? Number(word);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : undefined;
}

/**
 * A list is asked for: an ordering, a top-N, "which <plural>", or the winners
 * of several events.
 */
const LISTY =
  /\b(ordered|rank\b|rank first|ranking|ranked from|top \w+|which (two|three|four|five|six|seven|eight|nine|ten|individual|persons|people|assignees|monitors|lists|tickets|candidates|countries|teams|films|songs|albums)|largest|highest|lowest|laureates)\b|\bwhich (?:[A-Za-z-]+ ){0,2}(?:identifiers|IDs|codes|names|entries|titles|players|winners|companies|tickers|products|models|apps|games|books|vulnerabilities|CVEs)\b|\b(?:official )?winners of (?:the |all )?(?:two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b/i;
const COUNTY = /^\s*(?:[\d-]+,\s*)?how many\b|\bnumber of\b|\bcount\b/i;
/** The single top entry of a chart or ranking: one name, never a list. */
const SINGLE_TOP =
  /\b(?:rank|be|finish|place)\s+(?:first|1st|(?:No\.?|#|number)\s*1)\b(?!\s*(?:and|,|through|to)\b)|\bwhich (?:artist|song|album|film|movie|book|person|player|team|club|candidate|horse|driver|company|country)\b(?! and)/i;

/** A number is asked for: a measured quantity, a unit, a price point. */
const VALUEY =
  /\bReport the value in\b|\((?:in|as) [^)]{1,40}\)|,\s*in [^,?]{1,30},|\bin (?:US\$|USD|U\.S\. dollars|dollars|yuan|CNY|billions?|millions?|thousands?)\b|\bas a percentage\b|\bpercentage\b|\b(?:day's )?(?:open|close|high|low)\b(?: of| for)|\b(?:value|level|rate|price|index|average|total|amount|figure|gross|deficit|surplus|revenue|expenditures?|earnings|EPS|capitali[sz]ation|yield|temperature|reading|count)\b/i;

/**
 * An official statistic named by its series and reference period, with no
 * question word ("Job openings — July 2026", "Construction spending, July
 * 2026", "Patents issued in the gazette dated 1 September 2026"): the answer
 * is the published figure.
 */
const STATISTIC =
  /\b(?:staff|staffing|employment|payrolls?|jobs|openings|vacancies|sales|spending|turnover|output|production|orders|shipments|inventories|exports?|imports?|permits|starts|claims|patents|arrivals|visitors|passengers|revision|change|growth|inflation|balance|reserves|wind|pressure|rainfall|precipitation)\b/i;
const PERIOD =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4]|quarter|week \d+)\b[^?]*\b(?:19|20)\d\d\b|\bdated \d/i;
const QUESTION_WORD = /\?|^\s*(?:who|which|what|when|where|will|whose)\b/i;

function isStatisticTitle(title: string): boolean {
  const head = title.replace(/\s*\(resolved around[\s\S]*$/i, "");
  return !QUESTION_WORD.test(head) && STATISTIC.test(head) && PERIOD.test(head);
}

/** The unit a title names inline: "…, in knots, …" or "(in thousands)". */
export function titleUnit(title: string): string | undefined {
  return (
    title.match(/,\s*in ([^,?]{1,30}),/)?.[1]?.trim() ??
    title.match(/\((?:in|as) ([^)]{1,40})\)/)?.[1]?.trim()
  );
}

/** The answer shape a row asks for. */
export function specFor(row: FuturexRow): AnswerSpec {
  const title = questionText(row);
  const options = parseOptions(row.prompt);
  if (options.length >= 2) {
    // Most level-2 questions have one true option (a range, a winner); a set
    // only when the question is a bundle of independent outcomes. A count
    // ("how many …") falls in exactly one bucket, whatever else the title says.
    if (
      row.level === 2 &&
      (isThresholdSet(options) ||
        (MULTI_CUE.test(title) && !isRangeChoice(title, options) && !COUNTY.test(title)))
    ) {
      return { type: "multi", options };
    }
    return { type: "choice", options };
  }
  // "Which artist will rank No. 1" asks for one name, not a list.
  if (SINGLE_TOP.test(title)) return { type: "text" };
  if (LISTY.test(title)) {
    const size = listSize(title);
    return { type: "ranking", ...(size ? { size } : {}) };
  }
  const unit = row.prompt.match(/Report the value in ([^.\n]+)\./)?.[1]?.trim() ?? titleUnit(title);
  if (COUNTY.test(title)) return { type: "number", integer: true, ...(unit ? { unit } : {}) };
  if (unit || VALUEY.test(title) || isStatisticTitle(title)) {
    return { type: "number", ...(unit ? { unit } : {}) };
  }
  return { type: "text" };
}

/**
 * The question as asked: the title, unless it is truncated, in which case the
 * quoted event in the prompt (`The event to be predicted: "…"`).
 */
export function questionText(row: FuturexRow): string {
  const title = (row.en_title ?? "").trim();
  const quoted = row.prompt
    .match(/The event to be predicted:\s*"([\s\S]+?)\s*\(resolved around/)?.[1]
    ?.trim();
  if (title.length >= 40 && !/\b(the|of|a|an)$/i.test(title)) return title;
  return quoted ?? (title || row.prompt.slice(0, 300));
}

/** Mutually exclusive numeric ranges: pick one. */
function isRangeChoice(title: string, options: AnswerOption[]): boolean {
  if (RANGE.test(title)) return true;
  const rangey = options.filter((o) => RANGEY_LABEL.test(o.label ?? "")).length;
  return rangey >= Math.ceil(options.length / 2);
}

/** A row's end time as ISO; a bare date-time is the dataset's UTC+8. */
export function endTimeIso(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(t);
  const iso = hasZone ? t : `${t.replace(" ", "T")}${t.includes(":") ? "" : "T00:00:00"}+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The general forecast request for one row. */
export function requestFor(row: FuturexRow, opts: { asOf?: string } = {}): TypedForecastRequest {
  const endTime = endTimeIso(row.end_time);
  return {
    question: questionText(row).slice(0, 1_000),
    answer: specFor(row),
    ...(endTime ? { endTime } : {}),
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
    context: `${TIME_NOTE}\n\n${row.prompt.replace(/IMPORTANT: End with[^\n]*/g, "").trim()}`.slice(
      0,
      4_000,
    ),
  };
}

/**
 * The batch writes dates in UTC+8 ("20 September 2026 GMT+8"); a US evening
 * event is the next calendar day there. Said up front, so a one-day shift is
 * never read as "no such event on that date".
 */
const TIME_NOTE =
  "Dates and times in this question are in UTC+8 (Beijing time) unless it says otherwise. An event listed for the evening of one day in the Americas falls on the next calendar day in UTC+8 — that is the same event.";
