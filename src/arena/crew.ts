// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forecasting crew: several roles, each its own model call (and, in a
 * multi-vendor run, its own vendor), over the calibrated baseline — plus a
 * memory of its own misses that it recalls per series.
 *
 *   statistician — reads the series; proposes a distribution from its shape
 *   analyst      — reads the question and the crew's LESSONS for this series;
 *                  proposes from pollster behaviour and what past misses taught
 *   skeptic      — sees the baseline and both proposals; says how much of their
 *                  move to trust (0 = stay on the baseline) and why
 *
 * Aggregation is deterministic code, not a fourth model: the proposals' mean
 * move from the baseline, scaled by the skeptic's trust, clamped, with the
 * spread blended the same way. A malformed or failed role simply drops out;
 * with no usable proposal the crew files the baseline. The skeptic can only
 * shrink a move, never enlarge it — the arena's losers lose by overreaching.
 *
 * Learning: `learn()` turns a resolved round into a lesson note (the outcome,
 * the crew's error vs persistence's, which way it leaned) in Marina's notes
 * store; the analyst recalls the most recent lessons for the series. Lessons
 * enter memory only once a round's number is public, so a forecast never sees
 * its own answer.
 */

import type { NotesStore } from "../persistence/interfaces/notes-store";
import type { RoundForecast } from "./forecast";
import { forecastRound } from "./forecast";
import type { Complete } from "./model-forecaster";
import { parseReply } from "./model-forecaster";
import { crpsNormal } from "./score";
import type { ArenaLock, ArenaRound, Distribution } from "./types";

export const CREW_ENTITY = "arena-crew";
const LESSON_TYPE = "lesson";
const MAX_LESSONS = 6;
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
  /** Per role: ok, or why it dropped out (invalid reply, error, a move too wild). */
  roles?: Record<string, string>;
}

const ROLE_SYSTEM = {
  statistician: [
    "You are the statistician on a forecasting crew for a live public benchmark scored by CRPS against persistence (the last published value).",
    "Read only the numbers. Judge trend, mean reversion after outliers, volatility and calendar effects, and propose a normal distribution for the next release.",
    'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "reason": "<one sentence>"}.',
  ].join(" "),
  analyst: [
    "You are the analyst on a forecasting crew for a live public benchmark scored by CRPS against persistence (the last published value).",
    "Use what you know about this pollster or source (house effects, fielding, publication schedule, typical week-to-week noise) and the crew's LESSONS from its own past misses on this series.",
    'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "reason": "<one sentence>"}.',
  ].join(" "),
  skeptic: [
    "You are the skeptic on a forecasting crew. Most forecasters on this benchmark lose to persistence by moving too far on weak evidence.",
    "Given the baseline and two proposals, decide how much of their average move away from the baseline is justified: trust 0 means file the baseline, 1 means take the full move.",
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

/** The crew's recent lessons for a series, newest first. */
export function recallLessons(notes: NotesStore, series: string): string[] {
  const tag = `[series:${series}]`;
  return notes
    .getNotesByType(CREW_ENTITY, LESSON_TYPE, 200)
    .filter((n) => n.content.startsWith(tag))
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_LESSONS)
    .map((n) => n.content.slice(tag.length).trim());
}

/** Record what a resolved round taught: the crew's error next to persistence's. */
export function learn(
  notes: NotesStore,
  round: ArenaRound,
  lock: ArenaLock,
  filed: Distribution,
  outcome: number,
): void {
  const last = historyOf(lock).at(-1)?.value;
  if (last === undefined) return;
  const ours = crpsNormal(filed.mean, filed.sd, outcome);
  const pers = crpsNormal(last, 1.5, outcome);
  const moved = filed.mean - last;
  const actual = outcome - last;
  const verdict =
    ours < pers ? "beat persistence" : ours > pers ? "lost to persistence" : "tied persistence";
  const lean =
    Math.abs(moved) < 1e-9
      ? "stayed on the last value"
      : Math.sign(moved) === Math.sign(actual)
        ? `leaned the right way (${moved > 0 ? "up" : "down"})`
        : `leaned the WRONG way (${moved > 0 ? "up" : "down"})`;
  const content = `[series:${round.series ?? round.round_id}] ${round.round_id}: last ${last}, filed ${filed.mean}±${filed.sd}, published ${outcome} (move ${actual >= 0 ? "+" : ""}${Math.round(actual * 100) / 100}); ${verdict}, ${lean}.`;
  notes.createNote(CREW_ENTITY, content, undefined, {
    noteType: LESSON_TYPE,
    importance: ours > pers ? 7 : 5,
    skipDedup: true,
  });
}

export async function crewForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  members: CrewMembers,
  notes?: NotesStore,
): Promise<CrewForecast> {
  const baseline = forecastRound(round, lock);
  if (round.target_type !== "continuous_normal" || !baseline.topline) {
    return { ...baseline, fallback: "crew answers numeric rounds; baseline for this shape" };
  }
  const base = baseline.topline;
  const history = historyOf(lock);
  const series = round.series ?? round.round_id;
  const lessons = notes ? recallLessons(notes, series) : [];
  const head = `Question: ${round.question}\nUnit: ${round.unit ?? "(see question)"}\nPublished around ${round.release_at}; forecasts lock ${round.lock_at}.`;
  const hist = history
    .slice(-30)
    .map((p) => `${p.date} ${p.value}`)
    .join("\n");
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
    ask(
      "statistician",
      members.statistician,
      ROLE_SYSTEM.statistician,
      `${head}\n\nHistory (date value), oldest first:\n${hist}\n\nBaseline: ${JSON.stringify(base)}`,
    ),
    ask(
      "analyst",
      members.analyst,
      ROLE_SYSTEM.analyst,
      `${head}\n\nLast 8 values: ${history
        .slice(-8)
        .map((p) => p.value)
        .join(
          ", ",
        )}\nBaseline: ${JSON.stringify(base)}\n\nLESSONS (newest first):\n${lessons.length ? lessons.map((l) => `- ${l}`).join("\n") : "- none yet"}`,
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
    `${head}\n\nLast 8 values: ${history
      .slice(-8)
      .map((p) => p.value)
      .join(", ")}\nBaseline: ${JSON.stringify(base)}\nProposals: ${JSON.stringify(proposals)}`,
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
    roles,
    note: `marina crew (statistician, analyst, skeptic; ${lessons.length} lessons recalled) over the calibrated baseline`,
  };
}
