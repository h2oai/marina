#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prophet Arena write-back: the answers the agent (`marina_agent.py`) got
 * from `POST /v1/forecast` are filed on the one outcome path, and resolved
 * there when their events resolve, so they teach lessons and write history
 * like every other board's answers.
 *
 *   bun run benchmarks/prophet/writeback.ts file --journal <answers.jsonl> [--db <path>]
 *   bun run benchmarks/prophet/writeback.ts resolve --resolutions <file> [--db <path>]
 *
 * `file`     each journal line (`{ event, part?, mode, answer }`, written by the
 *            agent) becomes one answer under `marina:prophet`, source
 *            `prophet-arena`, external id `prophet:<event>[#<part>]`, filed once
 *            (`fileTypedAnswer`). `mode` is the agent's eval mode: a live window
 *            files `eval_mode = live` (teaches, writes history, never earns
 *            standing); a dataset replay (a past window) files `measure` (teaches
 *            other boards, never this one, never history).
 * `resolve`  a JSON array or JSONL of `{ event, outcomes: [names that happened],
 *            resolvedAt? }` (or `outcome: <name>`) — each filed answer of the
 *            event is resolved through `resolveFiled` → `resolveForecast`, which
 *            records the one outcome; lessons and history are delivered by the
 *            server's delivery pass from that row.
 *
 * Ids and numbers only on the outcome; the question text stays on the filed
 * answer (private context for the lesson judge), as for every board.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { TypedForecastAnswer } from "../../src/forecast/typed";
import { fileTypedAnswer, resolveFiled } from "../../src/outcomes/filing";
import { MarinaDB } from "../../src/persistence/database";

export const PROPHET_OWNER = "marina:prophet";
export const PROPHET_SOURCE = "prophet-arena";

/** One answer the agent recorded (`marina_agent.py` journal line). */
export interface ProphetJournalEntry {
  /** The event's stable id (Prophet's event id, else its slug). */
  event: string;
  /** The part index when a wide event was asked in parts (absent: one question). */
  part?: number;
  /** The agent's eval mode: `live` (a live window) or `measure` (a replay). */
  mode: "live" | "measure";
  /** The typed answer `POST /v1/forecast` returned. */
  answer: TypedForecastAnswer;
}

/** One resolved event: the outcome names that happened. */
export interface ProphetResolution {
  event: string;
  outcomes: string[];
  /** When the outcome was known (ISO); default now. */
  resolvedAt?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/;

/** The board id of an event's answer (`prophet:<event>`, `prophet:<event>#<part>`). */
export function prophetExternalId(event: string, part?: number): string {
  return part === undefined ? `prophet:${event}` : `prophet:${event}#${part}`;
}

/** Parse JSONL (or a JSON array) into objects, skipping blank lines. */
function records(text: string): unknown[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t) as unknown[];
  return t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

/** Journal lines the agent wrote; malformed ones are dropped (counted by the caller). */
export function parseJournal(text: string): { entries: ProphetJournalEntry[]; invalid: number } {
  const entries: ProphetJournalEntry[] = [];
  let invalid = 0;
  for (const raw of records(text)) {
    const r = raw as Partial<ProphetJournalEntry> | null;
    const type = r?.answer?.answer?.type;
    if (
      !r ||
      typeof r.event !== "string" ||
      !SAFE_ID.test(r.event) ||
      (r.mode !== "live" && r.mode !== "measure") ||
      (r.part !== undefined && !(Number.isInteger(r.part) && r.part >= 0)) ||
      (type !== "choice" && type !== "multi") ||
      typeof r.answer?.question !== "string"
    ) {
      invalid++;
      continue;
    }
    entries.push({
      event: r.event,
      mode: r.mode,
      answer: r.answer as TypedForecastAnswer,
      ...(r.part !== undefined ? { part: r.part } : {}),
    });
  }
  return { entries, invalid };
}

/** Resolutions from a file (`outcomes: [...]` or `outcome: "<name>"`). */
export function parseResolutions(text: string): ProphetResolution[] {
  const out: ProphetResolution[] = [];
  for (const raw of records(text)) {
    const r = raw as {
      event?: unknown;
      outcomes?: unknown;
      outcome?: unknown;
      resolvedAt?: unknown;
    } | null;
    if (!r || typeof r.event !== "string" || !SAFE_ID.test(r.event)) continue;
    const outcomes = Array.isArray(r.outcomes)
      ? r.outcomes.filter((x): x is string => typeof x === "string")
      : typeof r.outcome === "string"
        ? [r.outcome]
        : undefined;
    if (!outcomes) continue;
    out.push({
      event: r.event,
      outcomes,
      ...(typeof r.resolvedAt === "string" && Number.isFinite(Date.parse(r.resolvedAt))
        ? { resolvedAt: r.resolvedAt }
        : {}),
    });
  }
  return out;
}

export interface FileReport {
  filed: number;
  /** Already filed under that id (the first filing is kept). */
  existing: number;
  failed: number;
}

/** File every journal entry once (`fileTypedAnswer`). */
export function fileProphetAnswers(
  db: MarinaDB,
  entries: readonly ProphetJournalEntry[],
): FileReport {
  const report: FileReport = { filed: 0, existing: 0, failed: 0 };
  for (const e of entries) {
    const externalId = prophetExternalId(e.event, e.part);
    if (db.getForecastAnswerByExternalId(PROPHET_OWNER, externalId)) {
      report.existing++;
      continue;
    }
    const id = fileTypedAnswer(db, e.answer, {
      owner: PROPHET_OWNER,
      source: PROPHET_SOURCE,
      externalId,
      evalMode: e.mode,
    });
    if (id === undefined) report.failed++;
    else report.filed++;
  }
  return report;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The resolution value of one filed answer, in its own option ids: a yes/no
 * question (one outcome asked as `Yes: <name>` / `No`) resolves A or B; a
 * choice to the option of the outcome that happened; a multi-select to every
 * option whose outcome happened. Undefined when it cannot be scored (a choice
 * whose winner is not among its options, a part none of whose outcomes happened).
 */
export function prophetResolutionValue(
  answer: Pick<TypedForecastAnswer, "answer">,
  happened: readonly string[],
): { options: string[] } | undefined {
  const spec = answer.answer;
  if (spec.type !== "choice" && spec.type !== "multi") return undefined;
  const yes = new Set(happened.map(norm));
  const opts = spec.options;
  const yesNo =
    spec.type === "choice" &&
    opts.length === 2 &&
    /^yes: /i.test(opts[0]!.label ?? "") &&
    norm(opts[1]!.label ?? "") === "no";
  if (yesNo) {
    const name = (opts[0]!.label ?? "").replace(/^yes: /i, "");
    return { options: [yes.has(norm(name)) ? opts[0]!.id : opts[1]!.id] };
  }
  const ids = opts.filter((o) => yes.has(norm(o.label ?? o.id))).map((o) => o.id);
  if (spec.type === "choice") return ids.length === 1 ? { options: ids } : undefined;
  return ids.length ? { options: ids } : undefined;
}

export interface ResolveReport {
  settled: number;
  /** Already settled earlier. */
  already: number;
  /** No answer filed for the event. */
  unfiled: number;
  /** Filed but not scorable against this resolution (stays open). */
  unscored: number;
}

/** Resolve every filed answer of each resolved event through `resolveFiled`. */
export function resolveProphetAnswers(
  db: MarinaDB,
  resolutions: readonly ProphetResolution[],
  now = Date.now(),
): ResolveReport {
  const report: ResolveReport = { settled: 0, already: 0, unfiled: 0, unscored: 0 };
  for (const r of resolutions) {
    const ids: string[] = [];
    if (db.getForecastAnswerByExternalId(PROPHET_OWNER, prophetExternalId(r.event)))
      ids.push(prophetExternalId(r.event));
    for (let part = 0; part < 64; part++) {
      const id = prophetExternalId(r.event, part);
      if (!db.getForecastAnswerByExternalId(PROPHET_OWNER, id)) break;
      ids.push(id);
    }
    if (ids.length === 0) {
      report.unfiled++;
      continue;
    }
    const at = r.resolvedAt ? Math.min(Date.parse(r.resolvedAt), now) : now;
    for (const externalId of ids) {
      const row = db.getForecastAnswerByExternalId(PROPHET_OWNER, externalId)!;
      if (row.resolved_at !== null) {
        report.already++;
        continue;
      }
      let answer: TypedForecastAnswer;
      try {
        answer = JSON.parse(row.answer_json) as TypedForecastAnswer;
      } catch {
        report.unscored++;
        continue;
      }
      const value = prophetResolutionValue(answer, r.outcomes);
      if (!value) {
        report.unscored++;
        continue;
      }
      const res = resolveFiled(db, PROPHET_OWNER, externalId, value, at, [
        `prophet-event:${r.event}`,
      ]);
      if (res === "settled") report.already++;
      else if (res === "unfiled") report.unfiled++;
      else if (res === undefined) report.unscored++;
      else report.settled++;
    }
  }
  return report;
}

function main(): number {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      journal: { type: "string" },
      resolutions: { type: "string" },
      db: { type: "string" },
    },
  });
  const [cmd] = positionals;
  const dbPath = values.db ?? (process.env.DB_PATH || "marina.db");
  if (cmd === "file" && values.journal) {
    const { entries, invalid } = parseJournal(readFileSync(values.journal, "utf8"));
    const db = new MarinaDB(dbPath);
    try {
      const r = fileProphetAnswers(db, entries);
      console.log(
        `prophet write-back: filed ${r.filed}, already filed ${r.existing}, failed ${r.failed}, invalid lines ${invalid}`,
      );
    } finally {
      db.close();
    }
    return 0;
  }
  if (cmd === "resolve" && values.resolutions) {
    const resolutions = parseResolutions(readFileSync(values.resolutions, "utf8"));
    const db = new MarinaDB(dbPath);
    try {
      const r = resolveProphetAnswers(db, resolutions);
      console.log(
        `prophet resolve: settled ${r.settled}, already settled ${r.already}, unfiled ${r.unfiled}, unscorable ${r.unscored}`,
      );
    } finally {
      db.close();
    }
    return 0;
  }
  console.error(
    "usage: writeback.ts file --journal <answers.jsonl> [--db <path>]\n" +
      "       writeback.ts resolve --resolutions <file> [--db <path>]",
  );
  return 2;
}

if (import.meta.main) process.exit(main());
