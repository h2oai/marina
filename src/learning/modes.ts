// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** The lesson switches, read from the environment (no I/O; safe to import anywhere). */

export type LessonsMode = "on" | "off" | "observe";

export function lessonsMode(env: NodeJS.ProcessEnv = process.env): LessonsMode {
  const v = env.MARINA_LESSONS?.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return "off";
  if (v === "observe") return "observe";
  return "on";
}

/**
 * `MARINA_LESSONS_META=on|observe|off` (default on): the cross-board pool.
 *   on       trusted, transferable, non-case lessons are mirrored into
 *            `lessons:meta` and every work surface also serves them, labelled
 *            `cross-board <scope>`, within a third of its lesson budget
 *   observe  mirrored and recalled; ids recorded, nothing injected
 *   off      no mirror writes and no meta recall
 * `MARINA_LESSONS=off` turns this off too; `observe` there caps it at observe.
 */
export function lessonsMetaMode(env: NodeJS.ProcessEnv = process.env): LessonsMode {
  const base = lessonsMode(env);
  if (base === "off") return "off";
  const v = env.MARINA_LESSONS_META?.trim().toLowerCase();
  const meta: LessonsMode =
    v === "off" || v === "false" || v === "0" ? "off" : v === "observe" ? "observe" : "on";
  return meta === "on" && base === "observe" ? "observe" : meta;
}

/**
 * `MARINA_LESSONS_RESIDENT=off|observe|on` (default off): resident agents'
 * continuation prompt. `on` adds a `[Lessons]` section for the agent's focus
 * (judged lessons from every domain, cross-board meta included, labelled);
 * `observe` logs the ids it would have shown; `off` never asks. Capped by
 * `MARINA_LESSONS` (off ⇒ off, observe ⇒ at most observe).
 */
export function residentLessonsMode(env: NodeJS.ProcessEnv = process.env): LessonsMode {
  const base = lessonsMode(env);
  const v = env.MARINA_LESSONS_RESIDENT?.trim().toLowerCase();
  const mode: LessonsMode = v === "on" || v === "true" ? "on" : v === "observe" ? "observe" : "off";
  if (base === "off") return "off";
  return mode === "on" && base === "observe" ? "observe" : mode;
}
