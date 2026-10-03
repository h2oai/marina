// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecast lessons: what a resolved question taught, kept so later forecasts
 * can use it. A lesson is written only AFTER the outcome is known (the score
 * is the evidence) and is visible only to forecasts whose evidence cutoff is
 * at or after the moment that outcome became known (`resolvedAt`). The second
 * rule is what keeps a replay or backtest honest: a forecast made "as of"
 * September never sees a lesson learned from an October result.
 *
 *   write    after scoring: one terse, typed record — the answer type, a
 *            category, the failure mode (or "hit"), a corrective rule
 *   recall   lexical search, then `visibleAt(lesson, cutoff)`, newest first,
 *            byte-budgeted; the forecast records which lessons it used
 *
 * Storage goes through the canonical memory service (`durableLessonStore`,
 * driven by a `DurableMemoryAPI`-style `run`), so lessons are ordinary
 * versioned memory records — reflection tier, subject `forecast-lesson`,
 * `valid_time.from` = resolvedAt. `memoryLessonStore` is the in-process store
 * for tests and one-off runs.
 */

import type { MemoryOperationRequest } from "../sdk/memory-operations";
import type { AnswerSpec } from "./answer-types";

export const LESSON_SUBJECT = "forecast-lesson";

export interface ForecastLesson {
  id?: string;
  /** One terse line, the part a forecaster reads. */
  text: string;
  answerType: AnswerSpec["type"];
  category?: string;
  /** "hit", or what went wrong (wrong option, numeric error, …). */
  failure?: string;
  rule?: string;
  score?: number;
  /** ISO time the outcome became known; the lesson is invisible before it. */
  resolvedAt: string;
  /** A free label for where the question came from (metadata only). */
  origin?: string;
}

export interface LessonStore {
  write(lesson: ForecastLesson): Promise<{ id?: string }>;
  /** Lessons known at `asOf` that match `query`, newest first, within `maxBytes`. */
  recall(
    query: string,
    asOf: string,
    opts?: { limit?: number; maxBytes?: number },
  ): Promise<ForecastLesson[]>;
}

/** The leakage rule: a lesson exists for a forecast only once its outcome was known. */
export function visibleAt(lesson: Pick<ForecastLesson, "resolvedAt">, asOf: string): boolean {
  const r = Date.parse(lesson.resolvedAt);
  const a = Date.parse(asOf);
  return Number.isFinite(r) && Number.isFinite(a) && r <= a;
}

const DEFAULT_LIMIT = 6;
const DEFAULT_MAX_BYTES = 1_500;

const TOKEN = /[a-z0-9]{3,}/g;
const STOP = new Set([
  "the",
  "and",
  "will",
  "for",
  "what",
  "which",
  "who",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "how",
  "many",
  "much",
  "when",
  "event",
  "predict",
  "answer",
]);
const tokens = (s: string) =>
  new Set([...(s.toLowerCase().match(TOKEN) ?? [])].filter((t) => !STOP.has(t)));

/** Visible lessons, newest first, trimmed to the byte budget. */
export function selectLessons(
  candidates: ForecastLesson[],
  asOf: string,
  opts: { limit?: number; maxBytes?: number } = {},
): ForecastLesson[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const budget = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const out: ForecastLesson[] = [];
  let bytes = 0;
  const visible = candidates
    .filter((l) => visibleAt(l, asOf))
    .sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt));
  for (const l of visible) {
    const n = Buffer.byteLength(l.text);
    if (out.length >= limit || bytes + n > budget) break;
    out.push(l);
    bytes += n;
  }
  return out;
}

/** In-process store: token-overlap ranking, then the same visibility and budget rules. */
export function memoryLessonStore(initial: ForecastLesson[] = []): LessonStore & {
  all(): ForecastLesson[];
} {
  const lessons = [...initial];
  return {
    all: () => [...lessons],
    async write(lesson) {
      const id = lesson.id ?? `lesson-${lessons.length + 1}`;
      lessons.push({ ...lesson, id });
      return { id };
    },
    async recall(query, asOf, opts) {
      const q = tokens(query);
      const ranked = lessons
        .map((l) => ({
          l,
          hits: [...tokens(`${l.text} ${l.category ?? ""}`)].filter((t) => q.has(t)).length,
        }))
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      return selectLessons(
        ranked.map((x) => x.l),
        asOf,
        opts,
      );
    },
  };
}

type MemoryRun = (request: MemoryOperationRequest) => Promise<{ ok: true; result: unknown }>;

interface RecordLike {
  id?: string;
  content?: string;
  subject?: string | null;
  metadata?: Record<string, unknown>;
  valid_time?: { from: number | null; until: number | null } | null;
}

function fromRecord(r: RecordLike): ForecastLesson | undefined {
  const m = r.metadata ?? {};
  if (m.kind !== LESSON_SUBJECT || typeof r.content !== "string") return undefined;
  const resolvedAt =
    typeof m.resolved_at === "string"
      ? m.resolved_at
      : typeof r.valid_time?.from === "number"
        ? new Date(r.valid_time.from).toISOString()
        : undefined;
  if (!resolvedAt) return undefined;
  return {
    ...(r.id ? { id: r.id } : {}),
    text: r.content,
    answerType: (typeof m.answer_type === "string" ? m.answer_type : "text") as AnswerSpec["type"],
    ...(typeof m.category === "string" ? { category: m.category } : {}),
    ...(typeof m.failure === "string" ? { failure: m.failure } : {}),
    ...(typeof m.rule === "string" ? { rule: m.rule } : {}),
    ...(typeof m.score === "number" ? { score: m.score } : {}),
    resolvedAt,
    ...(typeof m.origin === "string" ? { origin: m.origin } : {}),
  };
}

/**
 * `rawRun` retried on a busy store (HTTP 503 / 429) with the same request key,
 * after the delay the store asks for.
 */
export function retryingMemoryRun(
  rawRun: MemoryRun,
  opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): MemoryRun {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (request) => {
    const keyed = request.key ? request : { ...request, key: crypto.randomUUID() };
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawRun(keyed);
      } catch (err) {
        const e = err as { status?: number; retryAfterMs?: number };
        const busy = e?.status === 503 || e?.status === 429;
        if (!busy || attempt >= (opts.retries ?? 6)) throw err;
        await sleep(Math.min(10_000, (e.retryAfterMs ?? 500) * (attempt + 1)));
      }
    }
  };
}

/**
 * Lessons as canonical memory records through a memory-service `run` (a
 * `DurableMemoryAPI.run` or a bound `residentMemoryOperation`). `spaceId`
 * selects a shared space; absent, the caller's resident space is used.
 * Recall over-fetches lexical matches and applies `visibleAt` itself, so the
 * leakage rule never depends on the store's own temporal filters. A busy
 * store (HTTP 503 / 429, e.g. another writer holds the database) is retried
 * with the same request key after the delay it asks for.
 */
export function durableLessonStore(
  rawRun: MemoryRun,
  opts: { spaceId?: string; retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): LessonStore {
  const space = opts.spaceId ? { space_id: opts.spaceId } : {};
  const run = retryingMemoryRun(rawRun, opts);
  return {
    async write(lesson) {
      const reply = await run({
        operation: "remember",
        ...space,
        input: {
          content: lesson.text,
          type: "inference",
          tier: "reflection",
          subject: LESSON_SUBJECT,
          metadata: {
            kind: LESSON_SUBJECT,
            resolved_at: lesson.resolvedAt,
            answer_type: lesson.answerType,
            ...(lesson.category ? { category: lesson.category } : {}),
            ...(lesson.failure ? { failure: lesson.failure } : {}),
            ...(lesson.rule ? { rule: lesson.rule } : {}),
            ...(lesson.score !== undefined ? { score: lesson.score } : {}),
            ...(lesson.origin ? { origin: lesson.origin } : {}),
          },
          valid_time: { from: Date.parse(lesson.resolvedAt), until: null },
        },
      });
      const id = (reply.result as { id?: unknown; record?: { id?: unknown } } | undefined) ?? {};
      const rid =
        typeof id.id === "string"
          ? id.id
          : typeof id.record?.id === "string"
            ? id.record.id
            : undefined;
      return rid ? { id: rid } : {};
    },
    async recall(query, asOf, recallOpts) {
      const words = [...tokens(query)].slice(0, 12).join(" ");
      if (!words) return [];
      const reply = await run({
        operation: "search",
        ...space,
        input: { query: words, mode: "lexical", subject: LESSON_SUBJECT, limit: 50 },
      });
      const results = ((reply.result as { results?: RecordLike[] } | undefined)?.results ?? [])
        .map(fromRecord)
        .filter((l): l is ForecastLesson => l !== undefined);
      return selectLessons(results, asOf, recallOpts);
    },
  };
}

// ─── Writing a lesson from an outcome ────────────────────────────────────────

export interface OutcomeInput {
  question: string;
  answer: AnswerSpec;
  prediction: string;
  /** The resolved outcome, as text (an option id, a number, a list). */
  truth: string;
  /** 0–1. */
  score: number;
  resolvedAt: string;
  /** Short reasons the forecast gave (the runs' and critic's). */
  reasons?: string[];
  /** Notes from the forecast (a research outage, a fallback answer). */
  caveat?: string;
  origin?: string;
}

export interface LessonWriter {
  name: string;
  complete: (system: string, user: string) => Promise<string>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The mechanical failure mode, from the answer type, prediction, truth and score. */
export function failureMode(input: OutcomeInput): string {
  if (input.score >= 0.99) return "hit";
  if (!input.prediction.trim()) return "no-answer";
  if (input.answer.type === "number") {
    const p = Number(input.prediction.replace(/[,\s$%]/g, ""));
    const t = Number(input.truth.replace(/[,\s$%]/g, ""));
    if (Number.isFinite(p) && Number.isFinite(t) && t !== 0) {
      const pct = ((p - t) / Math.abs(t)) * 100;
      return `numeric ${pct >= 0 ? "over" : "under"} ${Math.abs(pct).toFixed(1)}%`;
    }
    return "numeric miss";
  }
  if (input.answer.type === "multi") return input.score > 0 ? "partial set" : "wrong set";
  if (input.answer.type === "ranking") return input.score > 0 ? "partial list" : "wrong list";
  if (input.answer.type === "choice") return "wrong option";
  return "wrong text";
}

const LESSON_SYSTEM = [
  "You write one terse lesson for a forecaster from a resolved question. No pleasantries, no restating the question.",
  'Reply with ONE JSON object: {"category": "<2-4 words: domain + kind, e.g. \\"sports match winner\\", \\"equity close price\\">",',
  '"rule": "<one imperative sentence under 25 words a future forecaster should apply to similar questions>"}.',
  "The rule generalizes (base rates, source to read, option semantics, typical error) — never names this question's specific answer.",
].join(" ");

/**
 * A lesson from one resolved outcome: the mechanical part (type, failure mode,
 * score) always; a category and corrective rule from `writer` when given and
 * it answers (a failing writer still yields the mechanical lesson).
 */
export async function lessonFromOutcome(
  input: OutcomeInput,
  writer?: LessonWriter,
): Promise<ForecastLesson> {
  const failure = failureMode(input);
  let category: string | undefined;
  let rule: string | undefined;
  if (writer) {
    try {
      const raw = await writer.complete(
        LESSON_SYSTEM,
        [
          `Question: ${clip(input.question, 600)}`,
          `Answer type: ${input.answer.type}`,
          `Forecast: ${clip(input.prediction, 200)}`,
          `Outcome: ${clip(input.truth, 200)}`,
          `Score: ${input.score.toFixed(2)} (${failure})`,
          input.reasons?.length
            ? `Forecaster's reasons: ${clip(input.reasons.join(" | "), 800)}`
            : "",
          input.caveat ? `Notes: ${clip(input.caveat, 200)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const m = raw.match(/\{[\s\S]*\}/);
      const parsed = m ? (JSON.parse(m[0]) as { category?: unknown; rule?: unknown }) : {};
      if (typeof parsed.category === "string") category = clip(parsed.category.trim(), 40);
      if (typeof parsed.rule === "string") rule = clip(parsed.rule.trim(), 200);
    } catch {
      // allow-empty-catch: a lesson writer outage leaves the mechanical lesson
    }
  }
  const text = [
    `[lesson] ${input.answer.type}${category ? ` · ${category}` : ""}`,
    `score ${input.score.toFixed(2)} (${failure})`,
    rule ? `rule: ${rule}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    text,
    answerType: input.answer.type,
    ...(category ? { category } : {}),
    failure,
    ...(rule ? { rule } : {}),
    score: input.score,
    resolvedAt: input.resolvedAt,
    ...(input.origin ? { origin: input.origin } : {}),
  };
}
