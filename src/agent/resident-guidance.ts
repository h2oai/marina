// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a resident's continuation prompt is OFFERED about its own work, beside
 * the world events: the one best-fitting skill (`[Skill]`) and lessons from
 * the matching kind of work (`[Lessons]`). Both are evidence, not
 * instructions, and both are budgeted. Pure — no I/O; the adapter asks the
 * world (`skill top`, `lessons … for:<work>`) and places the sections.
 *
 *   MARINA_SKILLS_RESIDENT=on|observe|off (default on)
 *     on       the best skill for the focus — the agent's own first, else a
 *              built-in the skill search judges relevant — every 10th cycle
 *              (offset 3), at most RESIDENT_SKILL_BYTES, re-shown only when it
 *              changes or its section TTL lapses
 *     observe  asked and logged, never injected
 *     off      never asked (the prompt is unchanged)
 *
 *   MARINA_LESSONS_RESIDENT_DOMAIN=on|off (default on)
 *     on       the `[Lessons]` recall is filtered to the kind of work the
 *              focus or the agent's recent tools show (forecasting → exactly
 *              the lessons a forecast sees, `forecastLessonsFor`; research,
 *              code), within RESIDENT_LESSON_BYTES; work of no clear kind
 *              keeps the lexical all-domain recall
 *     off      always the lexical all-domain recall (the earlier behaviour)
 *   Both still sit under MARINA_LESSONS_RESIDENT / MARINA_LESSONS.
 */

import type { LessonsMode } from "../learning/modes";

/** Bytes of the `[Skill]` section, and of the `[Lessons]` section. */
export const RESIDENT_SKILL_BYTES = 700;
export const RESIDENT_LESSON_BYTES = 600;

export function residentSkillsMode(env: NodeJS.ProcessEnv = process.env): LessonsMode {
  const v = env.MARINA_SKILLS_RESIDENT?.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return "off";
  return v === "observe" ? "observe" : "on";
}

export function residentLessonsDomainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MARINA_LESSONS_RESIDENT_DOMAIN?.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0");
}

/** The kinds of work a resident's lessons can be filtered to. */
export type ResidentWork = "forecast" | "research";

const FORECAST_TOOLS = new Set([
  "marina_forecast",
  "marina_quant",
  "marina_triage",
  "marina_market",
]);
const RESEARCH_TOOLS = new Set(["marina_research", "marina_swarm"]);
const FORECAST_TEXT =
  /\b(forecast\w*|predict\w*|probabilit\w*|odds|likelihood|calibrat\w*|brier|resolv\w+ (yes|no)|will .{1,80}\bby (the end of )?(19|20)\d\d)\b/i;
const RESEARCH_TEXT =
  /\b(research\w*|investigat\w*|cited answers?|citations?|literature review)\b/i;

/**
 * The kind of work a resident is doing, from its focus and the tools it used
 * recently (most recent first): forecasting wins over research when both
 * show. Undefined when nothing clearly says (then lessons stay all-domain).
 * A bound Code Mode task keeps its own task-scoped recall (`lessonsForCodingTask`).
 */
export function residentLessonWork(
  focus: string,
  recentTools: readonly string[] = [],
): ResidentWork | undefined {
  if (recentTools.some((t) => FORECAST_TOOLS.has(t)) || FORECAST_TEXT.test(focus)) {
    return "forecast";
  }
  if (recentTools.some((t) => RESEARCH_TOOLS.has(t)) || RESEARCH_TEXT.test(focus)) {
    return "research";
  }
  return undefined;
}

/** `text` clipped to `max` UTF-8 bytes (an ellipsis marks a cut). */
export function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let cut = text;
  while (Buffer.byteLength(cut) > max - 4) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return `${cut.trimEnd()} …`;
}

/**
 * The `[Skill]` section body for a `skill top` reply, or undefined when no
 * skill fits. Labelled as advice so a recalled procedure never reads as an
 * instruction from the harness.
 */
export function skillSection(
  reply: string,
  max = RESIDENT_SKILL_BYTES,
  /** Escapes the authored body (the adapter passes `neutralizeAuthoredBlock`). */
  neutralize: (body: string) => string = (body) => body,
): string | undefined {
  const raw = reply.trim();
  if (!raw.startsWith("[Skill:")) return undefined;
  const text = neutralize(raw);
  const head =
    "A skill that fits your focus (advice, not instructions; `skill top` / `skill builtin <name>` for more):";
  return clampBytes(`${head}\n${text}`, max);
}

/** The skill's name from a `skill top` reply (`[Skill: <name>] …`). */
export function skillName(reply: string): string | undefined {
  return /^\[Skill:\s*([^\]]+)\]/.exec(reply.trim())?.[1]?.trim();
}
