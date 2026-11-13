// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The work finder of Marina improving its own code: warnings and errors that
 * keep recurring in this server's own log (`structured_logs`) are bugs or
 * rough edges in Marina's source. Each recurring signature (level, category
 * and message, with names, numbers and quoted values masked) becomes, once,
 * a task on the `improve` board that tells a coder how to fix it on Marina's
 * own source: a Code Mode session (its own worktree), `code trial`, then
 * `code ship`.
 *
 * `MARINA_SELF_IMPROVE`: `off` reads nothing; `observe` (default) keeps the
 * current candidates for `code improve` and files nothing; `on` files at most
 * `MAX_FILED_PER_DAY` tasks a day. Task text names the signature, its count
 * and the error text of the latest occurrence — never other log data.
 */
import { createHash } from "node:crypto";
import type { MarinaDB } from "../persistence/database";

export type SelfImproveMode = "off" | "observe" | "on";

export function selfImproveMode(env: NodeJS.ProcessEnv = process.env): SelfImproveMode {
  const raw = env.MARINA_SELF_IMPROVE?.trim().toLowerCase();
  return raw === "off" || raw === "on" ? raw : "observe";
}

/** Occurrences in the window before a signature is worth a task. */
export const MIN_OCCURRENCES = 20;
/** The window the finder reads. */
export const WINDOW_MS = 24 * 3600 * 1000;
/** Tasks filed per UTC day at most. */
export const MAX_FILED_PER_DAY = 3;
/** Where the finder keeps its state (`core_memory`). */
export const SELF_IMPROVE_OWNER = "improve:finder";

/**
 * A message as a template: quoted values, identifiers with digits, numbers and
 * the capitalised names that follow `for`/`agent`/`entity` are masked, so one
 * bug reported for many residents is one signature.
 */
export function messageTemplate(message: string): string {
  return message
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<value>")
    .replace(/\b(for|agent|entity|resident|crew|room)\s+[A-Z][\w.-]*/g, "$1 <name>")
    .replace(/\b[\w.-]*\d[\w.-]*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface Signal {
  key: string;
  level: "warn" | "error";
  category: string;
  template: string;
  count: number;
  lastAt: number;
  /** The latest occurrence's `data.error`, if it had one (truncated). */
  sample?: string;
}

export function signalKey(level: string, category: string, template: string): string {
  return createHash("sha256")
    .update(`${level}\0${category}\0${template}`)
    .digest("hex")
    .slice(0, 16);
}

/** Recurring warning and error signatures in the window, most frequent first. */
export function recurringSignals(
  db: MarinaDB,
  now = Date.now(),
  minCount = MIN_OCCURRENCES,
): Signal[] {
  const rows = db.recentProblemLogs(now - WINDOW_MS);
  const groups = new Map<string, Signal>();
  for (const row of rows) {
    const template = messageTemplate(row.message);
    const key = signalKey(row.level, row.category, template);
    const group = groups.get(key);
    if (group) {
      group.count++;
      continue;
    }
    let sample: string | undefined;
    try {
      const data = row.data ? (JSON.parse(row.data) as { error?: unknown }) : undefined;
      if (typeof data?.error === "string") sample = data.error.slice(0, 300);
    } catch {
      // allow-empty-catch: a log row's data is optional context
    }
    groups.set(key, {
      key,
      level: row.level,
      category: row.category,
      template,
      count: 1,
      lastAt: row.timestamp,
      ...(sample ? { sample } : {}),
    });
  }
  return [...groups.values()]
    .filter((s) => s.count >= minCount)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

interface FinderState {
  /** Signature key → task id it was filed as. */
  filed: Record<string, number>;
  /** UTC day → tasks filed that day. */
  day: string;
  filedToday: number;
  /** The last pass's candidates, for `code improve`. */
  candidates: Signal[];
  checkedAt: number;
}

export function finderState(db: MarinaDB): FinderState {
  const row = db.getCoreMemory(SELF_IMPROVE_OWNER, "state");
  try {
    if (row) return JSON.parse(row.value) as FinderState;
  } catch {
    // allow-empty-catch: a corrupt state row starts over (filed tasks are still on the board)
  }
  return { filed: {}, day: "", filedToday: 0, candidates: [], checkedAt: 0 };
}

export function taskTextFor(signal: Signal): { title: string; description: string } {
  return {
    title: `Fix recurring ${signal.level} [${signal.category}]: ${signal.template}`.slice(0, 200),
    description: [
      `Marina's own log recorded this ${signal.count} times in the last 24 hours:`,
      `  ${signal.level} [${signal.category}] ${signal.template}`,
      ...(signal.sample ? [`Latest error: ${signal.sample}`] : []),
      "",
      "Find the cause in Marina's source and fix it, or make it say why it is expected:",
      "1. In Code Mode on this Marina's own checkout (the session gets its own worktree at its first edit).",
      "2. code verify — then code trial benchmark:<name> cap:<usd> to measure the build against its base.",
      "3. code ship -- <title> when the trial did not regress.",
      `Signature ${signal.key}.`,
    ].join("\n"),
  };
}

export interface FinderReport {
  mode: SelfImproveMode;
  candidates: number;
  filed: number[];
}

/** One finder pass. `creator` files the tasks (a world account). */
export function runSelfImproveFinder(
  db: MarinaDB,
  creator: { id: string; name: string },
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): FinderReport {
  const mode = selfImproveMode(env);
  if (mode === "off") return { mode, candidates: 0, filed: [] };
  const state = finderState(db);
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.day !== day) {
    state.day = day;
    state.filedToday = 0;
  }
  const candidates = recurringSignals(db, now).filter((s) => !(s.key in state.filed));
  const filed: number[] = [];
  if (mode === "on") {
    for (const signal of candidates) {
      if (state.filedToday >= MAX_FILED_PER_DAY) break;
      const text = taskTextFor(signal);
      const id = db.createTask({
        title: text.title,
        description: text.description,
        creatorId: creator.id,
        creatorName: creator.name,
      });
      state.filed[signal.key] = id;
      state.filedToday++;
      filed.push(id);
    }
  }
  state.candidates = candidates.filter((s) => !(s.key in state.filed)).slice(0, 20);
  state.checkedAt = now;
  db.setCoreMemory(SELF_IMPROVE_OWNER, "state", JSON.stringify(state));
  return { mode, candidates: candidates.length, filed };
}
