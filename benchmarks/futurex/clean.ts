// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A CLEAN (non-leaking) backtest on resolved FutureX rows. Three things can
 * leak an outcome into a past-cutoff forecast, and each has a guard here:
 *
 *   model weights   only rows that ended well after every model's public
 *                   release (`MODEL_RELEASES`): a model published before an
 *                   event cannot have trained on it. Release dates are an
 *                   upper bound on knowledge cutoffs — the vendors' published
 *                   cutoffs are absent from the catalogue (`knowledge_cutoff`
 *                   is null) — so this is conservative. A model with no known
 *                   release requires an explicit `--after`.
 *   retrieval       the run's isolation level (src/arena/research/isolation.ts):
 *                   date-filtered engines, the strict post-filter, or closed-
 *                   book. An unfiltered engine is `contaminated` and refused.
 *   memory          lessons are visible only at or after their outcome
 *                   (`visibleAt`), and rows run in order of resolution.
 *
 * Then a per-row leak audit flags answers whose stored reasoning or kept
 * evidence names a date after the cutoff, quotes the exact outcome, or uses
 * result language; headline scores are reported with flagged rows in and out.
 */

import { daysMentioned } from "../../src/arena/research/isolation";
import type { FuturexRow } from "./dataset";
import { endTimeIso } from "./map";
import type { RowResult, Variant } from "./run";
import { parseTruth } from "./score";

/**
 * Public release dates (UTC) of models usable in a clean backtest — an upper
 * bound on each model's knowledge cutoff. Source: OpenRouter's model catalogue
 * (`https://openrouter.ai/api/v1/models`, field `created`), read 2026-10-02.
 * Keys are the id after the `openrouter/` routing prefix.
 */
export const MODEL_RELEASES: Record<string, string> = {
  "deepseek/deepseek-v4-pro-0813": "2026-08-12",
  "deepseek/deepseek-v4-pro": "2026-04-24",
  "deepseek/deepseek-v4-flash": "2026-04-24",
  "anthropic/claude-opus-5": "2026-07-24",
  "google/gemini-3.5-flash-lite": "2026-07-21",
  "google/gemini-3.8-flash": "2026-09-02",
  "moonshotai/kimi-k3": "2026-07-16",
  "z-ai/glm-5.1": "2026-04-07",
  "anthropic/claude-opus-5.5": "2026-09-22",
  "anthropic/claude-sonnet-5.5": "2026-09-28",
  "anthropic/claude-fable-5.1": "2026-09-01",
  "openai/gpt-6-astra-pro": "2026-09-04",
  "openai/gpt-6.1-sol-pro": "2026-09-29",
  "openai/gpt-6-luna": "2026-09-22",
  "openai/gpt-6-sol": "2026-09-22",
  "openai/gpt-6.1-sol": "2026-09-29",
};

/**
 * Some aliases (an unversioned id) can be re-pointed at newer weights after
 * their catalogue date. They are refused in a clean run; name a pinned id.
 */
export const FLOATING_ALIASES = new Set(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]);

/** Days before its end time a weekly FutureX question is released, at most. */
export const RELEASE_LAG_DAYS = 10;

const bare = (m: string) => m.replace(/^openrouter\//, "");

export function variantModels(v: Variant & { verifier?: string }): string[] {
  return [
    ...new Set(
      [...v.analysts, v.planner, v.critic, v.verifier].filter((m): m is string => !!m).map(bare),
    ),
  ];
}

/**
 * The latest knowledge bound of a variant's models (YYYY-MM-DD), or an error
 * naming the models with no known release (or a floating alias).
 */
export function knowledgeBound(
  v: Variant & { verifier?: string },
): { after: string } | { error: string } {
  const models = variantModels(v);
  const floating = models.filter((m) => FLOATING_ALIASES.has(m));
  if (floating.length) {
    return {
      error: `floating alias ${floating.join(", ")}: name a pinned model id for a clean run`,
    };
  }
  const unknown = models.filter((m) => !MODEL_RELEASES[m] && !m.startsWith("marina:"));
  if (unknown.length) {
    return { error: `no known release date for ${unknown.join(", ")}: pass --after <YYYY-MM-DD>` };
  }
  if (models.some((m) => m.startsWith("marina:"))) {
    return {
      error:
        "a crew analyst has its own tools (web search) and models: it cannot be isolated; use the in-engine verify option",
    };
  }
  const dates = models.map((m) => MODEL_RELEASES[m]!).sort();
  return { after: dates.at(-1)! };
}

/** The Wednesday (UTC+8 calendar) that opens the weekly FutureX window holding `iso`. */
export function batchWeek(iso: string): string {
  const t = new Date(Date.parse(iso) + 8 * 3_600_000);
  const day = t.getUTCDay(); // 0 Sun … 3 Wed
  const back = (day - 3 + 7) % 7;
  const wed = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - back));
  return wed.toISOString().slice(0, 10);
}

/**
 * Rows a clean backtest may use: resolved, with a parseable end time at least
 * `RELEASE_LAG_DAYS` after `after` (so the question was released after every
 * model's knowledge bound). Balanced across levels, spread across weeks, and
 * returned in order of end time (the order lessons must be learned in).
 */
export function selectCleanRows(
  rows: FuturexRow[],
  opts: { after: string; limit: number; until?: string },
): FuturexRow[] {
  const floor = Date.parse(opts.after) + RELEASE_LAG_DAYS * 86_400_000;
  const ceil = opts.until ? Date.parse(opts.until) : Number.POSITIVE_INFINITY;
  const eligible = rows.filter((r) => {
    const end = endTimeIso(r.end_time);
    if (!end || parseTruth(r.ground_truth).length === 0) return false;
    const t = Date.parse(end);
    return t > floor && t <= ceil;
  });
  const perLevel = Math.max(1, Math.floor(opts.limit / 4));
  const picked: FuturexRow[] = [];
  for (const level of [1, 2, 3, 4]) {
    const at = eligible.filter((r) => r.level === level);
    const byWeek = new Map<string, FuturexRow[]>();
    for (const r of at.sort((a, b) => a.id.localeCompare(b.id))) {
      const w = batchWeek(endTimeIso(r.end_time)!);
      byWeek.set(w, [...(byWeek.get(w) ?? []), r]);
    }
    // Round-robin over weeks so every week is represented.
    const weeks = [...byWeek.keys()].sort();
    for (let i = 0; picked.filter((r) => r.level === level).length < perLevel; i++) {
      let took = false;
      for (const w of weeks) {
        const r = byWeek.get(w)![i];
        if (r && picked.filter((x) => x.level === level).length < perLevel) {
          picked.push(r);
          took = true;
        }
      }
      if (!took) break;
    }
  }
  return picked.sort(
    (a, b) => Date.parse(endTimeIso(a.end_time)!) - Date.parse(endTimeIso(b.end_time)!),
  );
}

// ─── Leak audit ──────────────────────────────────────────────────────────────

export interface LeakFlags {
  /** A day after the cutoff named in the reasoning or the kept evidence. */
  laterDate: boolean;
  /** The exact numeric outcome (3+ significant digits) quoted in reasoning or evidence. */
  truthQuoted: boolean;
  /**
   * The outcome's name or list item appears. Weak on its own (forecasters
   * name the favourites they weigh), so it does not make a row suspicious.
   */
  nameMentioned: boolean;
  /** Result language ("closed at", "was announced", "final score") in the kept evidence. */
  resultLanguage: boolean;
}

export interface RowAudit {
  id: string;
  flags: LeakFlags;
  suspicious: boolean;
  /** What tripped a flag (short excerpts, for review). */
  evidence: string[];
}

const RESULT_LANGUAGE =
  /\b(?:has won|won the|defeated|beat (?:the )?\w+ \d|final score|finished (?:first|second|third|\d)|closed at|was announced|were announced|has been announced|officially (?:reported|announced)|the result (?:was|is)|resolved (?:as|to))\b/i;

function reasoningText(r: RowResult): string {
  const a = r.answer;
  return [
    ...a.runs.map((x) => x.reason ?? ""),
    ...a.runs.map((x) => x.verified?.reason ?? ""),
    a.critique?.reason ?? "",
    a.plan?.restatement ?? "",
    ...(a.plan?.keyQuantities ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

const EVIDENCE_LINE_DAY = /^\s*-\s*(\d{4}-\d{2}-\d{2})\s+—/;

/**
 * Split kept evidence by each line's publication day: lines published after
 * `cutoffDay` (their days), and the lines NOT proven to predate the cutoff
 * (undated ones), which still get the content checks.
 */
export function evidenceByDate(
  evidence: string,
  cutoffDay: string,
): { afterCutoff: string[]; unproven: string } {
  const afterCutoff: string[] = [];
  const unproven: string[] = [];
  for (const line of evidence.split("\n")) {
    const day = line.match(EVIDENCE_LINE_DAY)?.[1];
    if (!day) unproven.push(line);
    else if (day > cutoffDay) afterCutoff.push(day);
  }
  return { afterCutoff, unproven: unproven.join("\n") };
}

/**
 * Flag a row whose stored reasoning or kept evidence shows signs of knowing the
 * outcome. Conservative by design: an option label alone is never a flag (a
 * forecaster names the options it weighs), a quoted exact outcome is — for
 * numbers with three or more significant digits, and for names or lists.
 */
export function auditRow(
  row: FuturexRow,
  result: RowResult,
  evidence: string,
  optionIds: Set<string>,
): RowAudit {
  const cutoffDay = result.cutoff.slice(0, 10);
  const reasons = reasoningText(result);
  const text = `${reasons}\n${evidence}`;
  const out: string[] = [];
  // The event's own dates (in the question, and its end day ±1) are after the
  // cutoff by construction; naming them is not a leak.
  const own = new Set(daysMentioned(`${row.en_title ?? ""}\n${row.prompt}`));
  const end = endTimeIso(row.end_time);
  if (end) {
    for (const k of [-1, 0, 1]) {
      own.add(new Date(Date.parse(end) + k * 86_400_000).toISOString().slice(0, 10));
    }
  }
  // A forecaster legitimately talks about the schedule between the cutoff and
  // the event; a day AFTER the event in its reasoning, or any post-cutoff day
  // in the kept evidence, is a sign it saw later pages.
  const afterEvent = end
    ? new Date(Date.parse(end) + 86_400_000).toISOString().slice(0, 10)
    : cutoffDay;
  // Explicit calendar days only: "as of August 2026" states the cutoff month.
  const exact = (s: string) => daysMentioned(s, { monthOnly: false });
  // Evidence lines carry their page's publication day ("- 2026-08-11 — …"). A
  // page published on or before the cutoff cannot report the outcome: a later
  // day in it is a schedule, past-tense wording is history. Such lines are
  // checked only for their own date; a line dated after the cutoff is a leak,
  // and undated lines get the full content checks.
  const dated = evidenceByDate(evidence, cutoffDay);
  const later = [
    ...dated.afterCutoff,
    ...exact(reasons).filter((d) => d > afterEvent && !own.has(d)),
    ...exact(dated.unproven).filter((d) => d > cutoffDay && !own.has(d)),
  ];
  if (later.length) out.push(`later date ${later[0]}`);
  let truthQuoted = false;
  let nameMentioned = false;
  for (const t of parseTruth(row.ground_truth)) {
    if (optionIds.has(t.toUpperCase())) continue;
    const n = Number(t.replace(/[,\s$%]/g, ""));
    if (Number.isFinite(n)) {
      const digits = t.replace(/[^\d]/g, "").replace(/^0+/, "").length;
      if (digits >= 3 && text.replace(/,/g, "").includes(t.replace(/,/g, ""))) {
        truthQuoted = true;
        out.push(`truth number ${t}`);
      }
    } else if (t.length >= 4 && text.toLowerCase().includes(t.toLowerCase())) {
      nameMentioned = true;
      out.push(`names ${t.slice(0, 40)}`);
    }
  }
  // Result language counts in the kept EVIDENCE (a page reporting the outcome);
  // in the reasoning it is usually history ("has won three of the last four")
  // or the question's own wording, so there it is only a weak signal.
  const promptLower = `${row.en_title ?? ""} ${row.prompt}`.toLowerCase();
  const inEvidence = dated.unproven.match(RESULT_LANGUAGE);
  const inReasons = reasons.match(RESULT_LANGUAGE);
  const lang =
    inEvidence && !promptLower.includes(inEvidence[0].toLowerCase()) ? inEvidence : undefined;
  if (lang) out.push(`evidence result language "${lang[0]}"`);
  else if (inReasons) out.push(`(weak) reasoning result language "${inReasons[0]}"`);
  const flags: LeakFlags = {
    laterDate: later.length > 0,
    truthQuoted,
    nameMentioned,
    resultLanguage: !!lang,
  };
  return {
    id: row.id,
    flags,
    suspicious: flags.laterDate || flags.truthQuoted || flags.resultLanguage,
    evidence: out.slice(0, 4),
  };
}

// ─── Reference weekly scores (entered by hand; never scraped) ────────────────

/** `week` (the batch's opening Wednesday) → reference overall scores (0–1 or 0–100). */
export type ReferenceScores = Record<
  string,
  { top?: number; median?: number; h2o?: number; note?: string }
>;

export const toUnit = (x: number | undefined) =>
  x === undefined ? undefined : x > 1.5 ? x / 100 : x;
