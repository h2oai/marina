// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forecasting crew: several roles, each its own model call (and, in a
 * multi-vendor run, its own vendor), over the calibrated baseline — plus the
 * judged lessons from resolved rounds (`src/learning`).
 *
 *   statistician — the quant: reads only numbers — the weekly history and, for
 *                  Civiqs, the DAILY tracker the round resolves on (as the
 *                  newest snapshot fetched by the lock showed it)
 *   analyst      — reads the question and the crew's LESSONS for this series;
 *                  proposes from pollster behaviour and what past misses taught
 *   skeptic      — sees the start forecast, both proposals and the LESSONS (the
 *                  crew's track record here); says how much of their move to
 *                  trust (0 = stay on the start forecast) and why
 *
 * Every role is told the same true account of the round (prompt-context.ts):
 * what the start forecast is (the nowcast, with its date, or persistence),
 * the resolution and scoring rules, and every value with its date.
 *
 * Aggregation is deterministic code, not a fourth model: the proposals' mean
 * move from the baseline, scaled by the skeptic's trust, clamped, with the
 * spread blended the same way. A malformed or failed role simply drops out;
 * with no usable proposal the crew files the baseline. The skeptic can only
 * shrink a move, never enlarge it — the arena's losers lose by overreaching.
 *
 * Learning goes through ONE system, `src/learning` (judged, leak-checked,
 * retire/supersede): a resolved round becomes one judged outcome
 * (`crewLessonOutcome`, domain `arena`; live rounds already settle on the
 * outcome path in `settle.ts`), and the crew reads only the judged pool —
 * `forecast`, `arena` and the cross-board `meta` lessons visible at the
 * round's lock (`forecastLessonsFor`). Observe-mode lessons are never shown.
 * The crew's old per-series `lesson` notes (entity `arena-crew`) were
 * unjudged and injected straight into prompts; they are no longer written or
 * read (existing rows stay in the notes store, unused).
 */

import type { ForecastLesson, LessonStore } from "../forecast/lessons";
import type { Outcome } from "../learning/outcomes";
import type { RoundForecast } from "./forecast";
import { forecastRound } from "./forecast";
import type { Complete } from "./model-forecaster";
import { parseReply } from "./model-forecaster";
import {
  dailyBlock,
  dailyOf,
  freshestReading,
  historyBlock,
  rulesLines,
  startLine,
  withoutDaily,
} from "./prompt-context";
import { crpsNormal } from "./score";
import type { ArenaLock, ArenaRound, Distribution } from "./types";

const MAX_SD_MOVE = 4;

export interface CrewMembers {
  statistician: Complete;
  analyst: Complete;
  skeptic: Complete;
}

export interface CrewForecast extends RoundForecast {
  proposals?: Record<string, Distribution & { reason?: string }>;
  trust?: number;
  critique?: string;
  lessonsUsed?: number;
  fallback?: string;
  /** The daily series the quant read, when there was one. */
  dailySource?: string;
  /** Per role: ok, or why it dropped out (invalid reply, error, a move too wild). */
  roles?: Record<string, string>;
}

const ROLE_SYSTEM = {
  statistician: [
    "You are the quant on a forecasting crew for a live public benchmark scored by CRPS skill against persistence (the last published value).",
    "Read only the numbers: the start forecast, the weekly history and, when given, the DAILY tracker the round resolves on. The start forecast is the default.",
    "Move from it only for a concrete pattern in the data (for example, daily readings after the start reading, or a consistent revision); extrapolating a short trend or betting on mean reversion usually loses at a horizon of a few days.",
    'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "reason": "<one sentence>"}.',
  ].join(" "),
  analyst: [
    "You are the analyst on a forecasting crew for a live public benchmark scored by CRPS skill against persistence (the last published value).",
    "Use what you know about this pollster or source (house effects, fielding, publication schedule, typical week-to-week noise) and the crew's LESSONS from its own past misses on this series. The start forecast is the default.",
    'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "reason": "<one sentence>"}.',
  ].join(" "),
  skeptic: [
    "You are the skeptic on a forecasting crew. Most forecasters on this benchmark lose to persistence by moving too far on weak evidence.",
    "Given the start forecast, two proposals and the crew's track record on this series (its LESSONS: when it beat or lost to persistence, and which way it leaned), decide how much of the proposals' average move away from the start forecast is justified: trust 0 means file the start forecast, 1 means take the full move. Let the track record set your trust: a crew that has leaned the wrong way here has earned less.",
    'Reply with ONE JSON object: {"trust": number between 0 and 1, "sd_scale": number between 0.5 and 2, "critique": "<one sentence>"}.',
  ].join(" "),
};

function historyOf(lock: ArenaLock) {
  return lock.answer_history ?? lock.history ?? [];
}

function asProposal(v: Record<string, unknown> | undefined) {
  const mean = Number(v?.mean);
  const sd = Number(v?.sd);
  if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) return undefined;
  return { mean, sd, ...(typeof v?.reason === "string" ? { reason: v.reason.slice(0, 300) } : {}) };
}

/**
 * What a resolved round says about the crew's filing: its CRPS skill against
 * persistence and which way it leaned. Pure: nothing is written — the lesson
 * goes through the judged loop (`crewLessonOutcome`).
 */
export function roundSummary(
  lock: ArenaLock,
  filed: Distribution,
  outcome: number,
): { beat: boolean; skill: number; lean: string } | undefined {
  const last = historyOf(lock).at(-1)?.value;
  if (last === undefined) return undefined;
  const ours = crpsNormal(filed.mean, filed.sd, outcome);
  const pers = crpsNormal(last, 1.5, outcome);
  const moved = filed.mean - last;
  const actual = outcome - last;
  const lean =
    Math.abs(moved) < 1e-9
      ? "stayed on the last value"
      : Math.sign(moved) === Math.sign(actual)
        ? `leaned the right way (${moved > 0 ? "up" : "down"})`
        : `leaned the WRONG way (${moved > 0 ? "up" : "down"})`;
  return { beat: ours < pers, skill: pers > 0 ? 1 - ours / pers : 0, lean };
}

/**
 * The judged-loop outcome of one resolved round (domain `arena`): general
 * terms only — the tracker, skill against persistence, which way the crew
 * leaned. `resolvedAt` is when the number became known (the caller's `now`
 * for live resolutions; the round's release in a backtest).
 */
export function crewLessonOutcome(
  round: ArenaRound,
  roundId: string,
  summary: { beat: boolean; skill: number; lean: string },
  resolvedAt: string,
  /** The round's case (question and numbers): seen by the leak check, never stored. */
  privateContext?: string,
): Outcome {
  return {
    domain: "arena",
    source: `arena:${round.tracker ?? "round"}`,
    succeeded: summary.beat,
    score: Math.max(0, Math.min(1, (summary.skill + 1) / 2)),
    resolvedAt,
    attempted: `${round.tracker ?? "tracker"} topline forecast against persistence`,
    detail: `skill ${summary.skill.toFixed(2)} vs persistence; ${summary.lean}`,
    refs: [`arena:${roundId}`],
    privateContext: privateContext ?? `${round.question}\n${round.round_id}`,
  };
}

/** Judged-pool lessons for a round, visible at its lock (the forecast's cutoff). */
async function judgedLessons(lessons: LessonStore | undefined, round: ArenaRound) {
  if (!lessons) return [] as ForecastLesson[];
  try {
    const got = await lessons.recall(
      `${round.tracker ?? ""} ${round.question}`.slice(0, 400),
      round.lock_at,
      { limit: 4, maxBytes: 800 },
    );
    // Observe mode returns lessons for the record only: never shown to a role.
    return got.filter((l) => !l.observed);
  } catch {
    return [];
  }
}

export async function crewForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  members: CrewMembers,
  /**
   * The forecast the crew starts from and shrinks toward — the nowcast when
   * the caller has one (a fresher daily reading than the weekly history), else
   * the calibrated baseline. Every move is measured from it.
   */
  start?: RoundForecast,
  /** The judged lesson pool (`forecastLessonsFor`): read at the round's lock. */
  lessonStore?: LessonStore,
): Promise<CrewForecast> {
  const given = start ?? forecastRound(round, lock);
  const daily = dailyOf(given);
  const baseline = withoutDaily(given);
  if (round.target_type !== "continuous_normal" || !baseline.topline) {
    return { ...baseline, fallback: "crew answers numeric rounds; baseline for this shape" };
  }
  const base = baseline.topline;
  const history = historyOf(lock);
  // Only judged lessons, through learning's gates (trust, visibility at the lock).
  const lessons = (await judgedLessons(lessonStore, round)).map((l) => l.text);
  const fresh = freshestReading(baseline, round.series);
  const head = [
    `Question: ${round.question}`,
    `Unit: ${round.unit ?? "(see question)"}`,
    `Published around ${round.release_at}; forecasts lock ${round.lock_at}.`,
    ...rulesLines(round),
    startLine(round, baseline, history),
  ].join("\n");
  const lessonText = `LESSONS (newest first):\n${lessons.length ? lessons.map((l) => `- ${l}`).join("\n") : "- none yet"}`;
  const quantInput = [historyBlock(round, history, 30), dailyBlock(daily)]
    .filter(Boolean)
    .join("\n\n");
  const roles: Record<string, string> = {};
  const ask = async (role: string, c: Complete, system: string, user: string) => {
    try {
      const reply = parseReply(await c(system, user));
      roles[role] = reply ? "ok" : "invalid reply (no JSON object)";
      return reply;
    } catch (err) {
      roles[role] = `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
      return undefined;
    }
  };

  const [stat, analyst] = await Promise.all([
    ask("statistician", members.statistician, ROLE_SYSTEM.statistician, `${head}\n\n${quantInput}`),
    ask(
      "analyst",
      members.analyst,
      ROLE_SYSTEM.analyst,
      `${head}\n\n${historyBlock(round, history, 8)}\n\n${lessonText}`,
    ),
  ]);
  const proposals: Record<string, Distribution & { reason?: string }> = {};
  for (const [name, reply] of [
    ["statistician", stat],
    ["analyst", analyst],
  ] as const) {
    const p = asProposal(reply);
    if (!p) {
      if (roles[name] === "ok") roles[name] = "invalid reply (no valid mean/sd)";
    } else if (Math.abs(p.mean - base.mean) > MAX_SD_MOVE * base.sd) {
      roles[name] =
        `dropped: move ${Math.round((p.mean - base.mean) * 100) / 100} beyond ${MAX_SD_MOVE} baseline sd`;
    } else proposals[name] = p;
  }
  const usable = Object.values(proposals);
  if (usable.length === 0) {
    return { ...baseline, lessonsUsed: lessons.length, roles, fallback: "no usable proposal" };
  }
  const moveMean = usable.reduce((s, p) => s + p.mean, 0) / usable.length - base.mean;
  const moveSd = usable.reduce((s, p) => s + p.sd, 0) / usable.length;

  const verdict = await ask(
    "skeptic",
    members.skeptic,
    ROLE_SYSTEM.skeptic,
    `${head}\n\n${historyBlock(round, history, 8)}\n\nProposals: ${JSON.stringify(proposals)}\n\n${lessonText}`,
  );
  const trustRaw = Number(verdict?.trust);
  // A missing or broken skeptic trusts the proposals half-way, like the default blend.
  const trust = Number.isFinite(trustRaw) ? Math.min(Math.max(trustRaw, 0), 1) : 0.5;
  const scaleRaw = Number(verdict?.sd_scale);
  const sdScale = Number.isFinite(scaleRaw) ? Math.min(Math.max(scaleRaw, 0.5), 2) : 1;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const topline = {
    mean: round3(base.mean + trust * moveMean),
    sd: round3(Math.max(base.sd * 0.5, ((1 - trust) * base.sd + trust * moveSd) * sdScale)),
  };
  return {
    ...baseline,
    topline,
    proposals,
    trust,
    ...(typeof verdict?.critique === "string" ? { critique: verdict.critique.slice(0, 300) } : {}),
    lessonsUsed: lessons.length,
    ...(daily ? { dailySource: daily.source } : {}),
    roles,
    note: `marina crew (quant, analyst, skeptic; ${lessons.length} lessons recalled) over ${fresh ? `the nowcast (${fresh.date})` : "the calibrated baseline"}`,
  };
}
