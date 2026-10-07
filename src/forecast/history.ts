// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolved forecast history: what the forecaster said, what its prior was,
 * and what happened — numbers and option ids only, never question or answer
 * text. It is the evidence the learned parts of a forecast are fitted on:
 *
 *   prior weight   how far to pool an answer toward its prior (`./prior.ts`)
 *   base rates     how often a reference class resolved each way (`./prior.ts`)
 *   calibration    a recalibration map per answer type (`./recalibration.ts`)
 *   routing        which formation wins per question class (`./routing.ts`)
 *
 * The leakage rule is the lessons' rule (`visibleAt`): a record exists for a
 * forecast only once its outcome was known at that forecast's evidence cutoff,
 * and a question never sees its own record. `visibleRecords` applies both, so
 * no store or caller can skip them.
 *
 * Stores: `memoryHistory` (in-process — tests, backtests, replays) and
 * `jsonlHistory` (an append-only JSON-lines file, `MARINA_FORECAST_HISTORY`).
 * An adapter appends a record once a question resolves (`resolvedRecord`).
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type AnswerOption, type AnswerSpec, type AnswerType, normalizeText } from "./answer-types";
import type { Distribution } from "./distribution";

/**
 * Where a prior came from, best first: a market price, community forecast or
 * statistical prior the asker supplied, a market price a lookup found, the freshest official reading
 * of the quantity (persistence), the reference class's base rate, the type's
 * default (uniform / 0.5).
 */
export type PriorSource =
  | "market"
  | "community"
  | "statistical"
  | "market-lookup"
  | "anchor"
  | "base-rate"
  | "type-default";

export const PRIOR_SOURCES: readonly PriorSource[] = [
  "market",
  "community",
  "statistical",
  "market-lookup",
  "anchor",
  "base-rate",
  "type-default",
];

/** A forecast in numbers: per-option probabilities, or a value with its sd. */
export interface ForecastNumbers {
  distribution?: Distribution;
  value?: number;
  sd?: number;
}

/** Where a prior sat when it was used: days from the cutoff to the close, and market liquidity (USD). */
export interface PriorContext {
  horizonDays?: number;
  liquidity?: number;
}

/** An informative prior carries information beyond the answer's own shape (not the type default). */
export const informative = (source: PriorSource | undefined): boolean =>
  source !== undefined && source !== "type-default";

/** The bucket a prior's weight may be fitted in: time to close, then liquidity when known. */
export function priorBucket(c: PriorContext | undefined): string {
  const d = c?.horizonDays;
  const h = d === undefined ? "horizon ?" : d <= 7 ? "≤ 7 d" : d <= 30 ? "≤ 30 d" : "> 30 d";
  const l = c?.liquidity;
  return l === undefined ? h : `${h}, ${l < 10_000 ? "liquidity < $10k" : "liquidity ≥ $10k"}`;
}

export interface ResolvedRecord {
  /** A stable question id (a ledger item id); never question text. */
  id: string;
  answerType: AnswerType;
  /** Calibration group (`answerGroup`): `binary:<a>|<b>`, `choice`, `multi`, `number`. */
  group: string;
  /** The question's reference class, when the asker named one. */
  category?: string;
  /** When the outcome became known (ISO). The record is invisible before it. */
  resolvedAt: string;
  /** Option id → a hash of its normalised label (label base rates; no text kept). */
  labels?: Record<string, string>;
  /** The forecast before any prior shrink or recalibration. */
  raw: ForecastNumbers;
  /** The prior that forecast had at its cutoff (with its market context, when known). */
  prior?: ForecastNumbers & { source: PriorSource } & PriorContext;
  outcome: {
    /** Option ids that resolved true (choice: one; multi: the true set among `resolvedOptions`). */
    options?: string[];
    value?: number;
  };
  /** Multi-select: the options whose outcome is known (default: every option in `raw`). */
  resolvedOptions?: string[];
  /** The formation (or configuration label) that produced the forecast — routing evidence. */
  formation?: string;
  /** The board's score of the filed answer (higher is better) — routing evidence. */
  score?: number;
}

export interface ForecastHistory {
  /** Every stored record (the caller applies `visibleRecords`). */
  all(): Promise<ResolvedRecord[]>;
  add(record: ResolvedRecord): Promise<void>;
}

/**
 * The records a forecast may learn from: resolved at or before its cutoff,
 * and not the question itself. Oldest first (ties by id), so a time split is
 * a plain slice.
 */
export function visibleRecords(
  records: ResolvedRecord[],
  cutoff: string,
  exceptId?: string,
): ResolvedRecord[] {
  const at = Date.parse(cutoff);
  if (!Number.isFinite(at)) return [];
  return records
    .filter((r) => {
      const t = Date.parse(r.resolvedAt);
      return Number.isFinite(t) && t <= at && (exceptId === undefined || r.id !== exceptId);
    })
    .sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || a.id.localeCompare(b.id));
}

/** The calibration group of an answer spec. */
export function answerGroup(spec: AnswerSpec): string {
  if (spec.type === "choice" && spec.options.length === 2) {
    return `binary:${spec.options
      .map((o) => o.id.toLowerCase())
      .sort()
      .join("|")}`;
  }
  return spec.type;
}

/** A label's key: a short hash of its normalised text (recurring labels match; no text kept). */
export function labelKey(label: string): string {
  return createHash("sha256").update(normalizeText(label)).digest("hex").slice(0, 12);
}

export function labelKeys(options: AnswerOption[]): Record<string, string> {
  return Object.fromEntries(options.map((o) => [o.id, labelKey(o.label ?? o.id)]));
}

/** In-process history (tests, backtests, replays). */
export function memoryHistory(initial: ResolvedRecord[] = []): ForecastHistory & {
  records: ResolvedRecord[];
} {
  const records = [...initial];
  return {
    records,
    all: async () => [...records],
    add: async (r) => {
      records.push(r);
    },
  };
}

/**
 * History in an append-only JSON-lines file. Reads are cached until the file
 * changes; a torn last line (an interrupted write) is skipped.
 */
export function jsonlHistory(path: string): ForecastHistory {
  let cache: { mtimeMs: number; size: number; records: ResolvedRecord[] } | undefined;
  return {
    async all() {
      if (!existsSync(path)) return [];
      const st = statSync(path);
      if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.records;
      const records: ResolvedRecord[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as ResolvedRecord;
          if (r && typeof r.id === "string" && typeof r.resolvedAt === "string") records.push(r);
        } catch {
          // allow-empty-catch: a torn last line is skipped; the next append starts a fresh line
        }
      }
      cache = { mtimeMs: st.mtimeMs, size: st.size, records };
      return records;
    },
    async add(r) {
      mkdirSync(dirname(path), { recursive: true });
      const torn = existsSync(path) && !readFileSync(path, "utf8").endsWith("\n");
      appendFileSync(path, `${torn ? "\n" : ""}${JSON.stringify(r)}\n`);
    },
  };
}

/** `MARINA_FORECAST_HISTORY`: a JSON-lines path, or undefined (no history). */
export function historyFromEnv(env: NodeJS.ProcessEnv = process.env): ForecastHistory | undefined {
  const path = env.MARINA_FORECAST_HISTORY?.trim();
  return path ? jsonlHistory(path) : undefined;
}

/**
 * The record for one resolved forecast. `numbers` is the answer's pre-adjustment
 * forecast (`answer.adjustment.raw`), `prior` its prior; `truth` the outcome as
 * option ids or a value.
 */
export function resolvedRecord(input: {
  id: string;
  spec: AnswerSpec;
  resolvedAt: string;
  numbers: ForecastNumbers;
  prior?: ForecastNumbers & { source: PriorSource } & PriorContext;
  truth: { options?: string[]; value?: number };
  resolvedOptions?: string[];
  category?: string;
  formation?: string;
  score?: number;
}): ResolvedRecord {
  const spec = input.spec;
  return {
    id: input.id,
    answerType: spec.type,
    group: answerGroup(spec),
    ...(input.category ? { category: input.category } : {}),
    resolvedAt: input.resolvedAt,
    ...("options" in spec ? { labels: labelKeys(spec.options) } : {}),
    raw: input.numbers,
    ...(input.prior ? { prior: input.prior } : {}),
    outcome: input.truth,
    ...(input.resolvedOptions ? { resolvedOptions: input.resolvedOptions } : {}),
    ...(input.formation ? { formation: input.formation } : {}),
    ...(input.score !== undefined ? { score: input.score } : {}),
  };
}
