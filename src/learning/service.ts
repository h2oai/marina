// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring for outcome learning (`./outcomes.ts`) inside a running Marina.
 *
 *   MARINA_LESSONS=on|off|observe   (default on)
 *     on       outcomes become judged lessons; recall injects served lessons
 *     observe  outcomes become lessons; recall returns them for recording only
 *              (the caller logs what it WOULD have used, the ablation arm)
 *     off      no lesson writes and no recall
 *   MARINA_LESSONS_WRITER=<model>   the rule writer. A `provider/model` id
 *              uses that vendor; the default `marina/default` asks this
 *              Marina's own `/v1` (whatever model the operator runs, local
 *              included). `none` = mechanical lessons only.
 *   MARINA_LESSONS_JUDGE_MODEL=<model>   the fallback judge model when no
 *              decision backend is configured (default `marina/default`).
 *
 * Marina works with whatever intelligence it has. The judge is the configured
 * decision backend (`harnessDecisionProvider`); without one, a chat-classifier
 * on the single available model through Marina's own `/v1` — uncalibrated, so
 * one conservative cut at 0.5, and every lesson it passes is labelled with that
 * judge. No vendor key is ever required: with no model reachable at all, the
 * writer falls back to the mechanical candidate and the judge to `unverified`,
 * so outcomes are still recorded and nothing is promoted.
 *   MARINA_LESSONS_MAX_PER_HOUR=<n>          outcomes processed per hour (default 120)
 *
 * Learning is armed per database by `enableOutcomeLearning(db)` — the server
 * (`main.ts`) and operator scripts call it; library code and tests that never
 * arm it see `noteOutcome` as a no-op. Recall needs no arming: it reads the
 * pool through `lessonRecallSinkFor`, which never creates anything. The lessons are owned by a server
 * account named `marina:lessons` — a name login cannot produce (login names are
 * alphanumeric + underscore), so no participant can claim or edit the pool.
 * Lessons live in one shared space per domain (`lessons:<domain>`).
 */

import { modelComplete } from "../arena/model-backend";
import { harnessDecisionProvider } from "../decisions/engines";
import { chatClassifierProvider } from "../decisions/providers";
import type { DecisionProvider } from "../decisions/types";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { residentMemoryOperation } from "../memory/resident-service";
import type { MarinaDB } from "../persistence/database";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import {
  formatLesson,
  type Lesson,
  type LessonRetirement,
  type LessonSelector,
  type LessonSink,
  type LessonWriter,
  type Outcome,
  type OutcomeDomain,
  recordOutcomes,
  selectServed,
} from "./outcomes";
import { durableLessonSink } from "./store";

const logger = new Logger();

export const LESSONS_ACCOUNT = "marina:lessons";
export const DEFAULT_LESSONS_MODEL = "marina/default";
const SELF_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PER_HOUR = 120;
const MAX_QUEUE = 500;

export type LessonsMode = "on" | "off" | "observe";

export function lessonsMode(env: NodeJS.ProcessEnv = process.env): LessonsMode {
  const v = env.MARINA_LESSONS?.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return "off";
  if (v === "observe") return "observe";
  return "on";
}

function maxPerHour(env: NodeJS.ProcessEnv): number {
  const n = Number(env.MARINA_LESSONS_MAX_PER_HOUR);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_PER_HOUR;
}

interface Armed {
  sink: LessonSink;
  writer?: LessonWriter;
  judge?: DecisionProvider;
  queue: Outcome[];
  draining?: Promise<void>;
  windowStart: number;
  processed: number;
  dropped: number;
}

const armed = new WeakMap<object, Armed>();

/** The memory-service run bound to the lessons account (created on first use). */
export function lessonsRun(db: MarinaDB) {
  if (!db.getUserByName(LESSONS_ACCOUNT))
    db.createUser({ id: crypto.randomUUID(), name: LESSONS_ACCOUNT });
  return (request: MemoryOperationRequest) =>
    residentMemoryOperation(db, LESSONS_ACCOUNT, request) as Promise<{
      ok: true;
      result: unknown;
    }>;
}

/** A durable lesson sink over `db`, one shared space per domain. */
export function lessonSinkFor(db: MarinaDB): LessonSink {
  const run = lessonsRun(db);
  const spaces = new Map<OutcomeDomain, Promise<string | undefined>>();
  const spaceFor = (domain: OutcomeDomain) => {
    let p = spaces.get(domain);
    if (!p) {
      p = (async () => {
        const name = `lessons:${domain}`;
        const listed = (await run({ operation: "spaces" })).result as {
          spaces?: Array<{ id: string; name: string }>;
        };
        const found = listed.spaces?.find((s) => s.name === name)?.id;
        if (found) return found;
        const made = (await run({ operation: "create_space", input: { name } })).result as {
          id?: string;
        };
        return made.id;
      })();
      p.catch(() => spaces.delete(domain));
      spaces.set(domain, p);
    }
    return p;
  };
  return durableLessonSink(run, spaceFor);
}

const recallOnlySinks = new WeakMap<object, LessonSink>();

/**
 * A recall-only sink over `db`: reads the lessons account's existing
 * `lessons:<domain>` spaces and never creates the account or a space (no
 * account or no space ⇒ no lessons). This is what lets every surface that
 * forecasts or verifies on a database — the server, an operator script, a
 * backtest — recall the judged pool without arming the learning loop, which
 * only the writers need.
 */
export function lessonRecallSinkFor(db: MarinaDB): LessonSink {
  const cached = recallOnlySinks.get(db);
  if (cached) return cached;
  const run = (request: MemoryOperationRequest) =>
    residentMemoryOperation(db, LESSONS_ACCOUNT, request) as Promise<{
      ok: true;
      result: unknown;
    }>;
  const found = new Map<OutcomeDomain, string>();
  const spaceFor = async (domain: OutcomeDomain) => {
    const known = found.get(domain);
    if (known) return known;
    if (!db.getUserByName(LESSONS_ACCOUNT)) return undefined;
    const listed = (await run({ operation: "spaces" })).result as {
      spaces?: Array<{ id: string; name: string }>;
    };
    const id = listed.spaces?.find((s) => s.name === `lessons:${domain}`)?.id;
    if (id) found.set(domain, id);
    return id;
  };
  const sink = durableLessonSink(run, spaceFor);
  recallOnlySinks.set(db, sink);
  return sink;
}

/** This Marina's own `/v1` base and the internal model token (no vendor key). */
function selfBaseUrl(env: NodeJS.ProcessEnv): string {
  return `http://localhost:${Number(env.WS_PORT) || 3300}/v1`;
}

async function internalToken(): Promise<string> {
  const { getInternalModelToken } = await import("../agent/agent-runtime");
  return getInternalModelToken();
}

export interface SelfModelDeps {
  baseUrl?: string;
  token?: () => Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** A writer that asks a model through this Marina's own `/v1` chat completions. */
export function selfModelWriter(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: SelfModelDeps = {},
): LessonWriter {
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    name: model,
    async complete(system, user) {
      const res = await doFetch(`${deps.baseUrl ?? selfBaseUrl(env)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await (deps.token ?? internalToken)()}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(SELF_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`writer HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("writer returned no text");
      return content;
    },
  };
}

/**
 * The rule writer: an explicit vendor `provider/model` through its own key;
 * otherwise (and by default) the operator's model through this Marina's `/v1`.
 */
export function lessonWriterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: SelfModelDeps = {},
): LessonWriter | undefined {
  const spec = env.MARINA_LESSONS_WRITER?.trim() || DEFAULT_LESSONS_MODEL;
  if (spec === "none" || spec === "off") return undefined;
  if (spec.startsWith("marina/")) return selfModelWriter(spec, env, deps);
  try {
    const { complete } = modelComplete(spec, env, { maxTokens: 600, timeoutMs: SELF_TIMEOUT_MS });
    return { name: spec, complete };
  } catch (err) {
    // A missing vendor key never blocks learning: fall back to this Marina's own model.
    logger.warn("main", "lesson writer vendor unavailable; using marina/default", {
      writer: spec,
      error: (err as Error).message,
    });
    return selfModelWriter(DEFAULT_LESSONS_MODEL, env, deps);
  }
}

/**
 * The lesson judge: the configured decision backend, else a chat-classifier on
 * the single available model through this Marina's `/v1` (uncalibrated —
 * `judgeLesson` then uses one cut at 0.5).
 */
export function lessonJudgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: SelfModelDeps = {},
): DecisionProvider {
  const configured = harnessDecisionProvider(env);
  if (configured) return configured;
  const model = env.MARINA_LESSONS_JUDGE_MODEL?.trim() || DEFAULT_LESSONS_MODEL;
  let inner: DecisionProvider | undefined;
  return {
    kind: "marina-classifier",
    model: `lesson-judge:${model}`,
    calibrated: false,
    async ask(request, signal) {
      inner ??= chatClassifierProvider({
        baseUrl: deps.baseUrl ?? selfBaseUrl(env),
        model,
        apiKey: await (deps.token ?? internalToken)(),
        timeoutMs: SELF_TIMEOUT_MS,
        method: "verbalized",
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      const result = await inner.ask(request, signal);
      return { ...result, calibrated: false };
    },
  };
}

/**
 * Arm outcome learning for `db`. Idempotent. Returns false when
 * `MARINA_LESSONS=off`. `sink` overrides the durable sink (tests).
 */
export function enableOutcomeLearning(
  db: MarinaDB,
  opts: {
    env?: NodeJS.ProcessEnv;
    sink?: LessonSink;
    writer?: LessonWriter | null;
    judge?: DecisionProvider | null;
  } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (lessonsMode(env) === "off") return false;
  if (armed.has(db)) return true;
  armed.set(db, {
    sink: opts.sink ?? lessonSinkFor(db),
    ...(opts.writer === null
      ? {}
      : opts.writer
        ? { writer: opts.writer }
        : (() => {
            const w = lessonWriterFromEnv(env);
            return w ? { writer: w } : {};
          })()),
    ...(opts.judge === null ? {} : { judge: opts.judge ?? lessonJudgeFromEnv(env) }),
    queue: [],
    windowStart: Date.now(),
    processed: 0,
    dropped: 0,
  });
  return true;
}

export function disableOutcomeLearning(db: MarinaDB): void {
  armed.delete(db);
}

export function outcomeLearningEnabled(db: MarinaDB): boolean {
  return armed.has(db);
}

/**
 * Hand an outcome to the learning loop. Never blocks or throws: the outcome is
 * queued and judged in the background, bounded per hour. A no-op unless
 * learning was armed for `db`.
 */
export function noteOutcome(
  db: object,
  outcome: Outcome,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const a = armed.get(db);
  if (!a) return;
  if (a.queue.length >= MAX_QUEUE) {
    a.dropped++;
    return;
  }
  a.queue.push(outcome);
  if (!a.draining) a.draining = drain(a, env).finally(() => (a.draining = undefined));
}

async function drain(a: Armed, env: NodeJS.ProcessEnv): Promise<void> {
  await Promise.resolve();
  while (a.queue.length) {
    const now = Date.now();
    if (now - a.windowStart >= 3_600_000) {
      a.windowStart = now;
      a.processed = 0;
    }
    const room = maxPerHour(env) - a.processed;
    if (room <= 0) {
      a.dropped += a.queue.length;
      a.queue.length = 0;
      logger.warn("main", "lesson budget for this hour is spent; outcomes dropped", {
        dropped: a.dropped,
      });
      return;
    }
    const batch = a.queue.splice(0, Math.min(room, 10));
    a.processed += batch.length;
    const judge = a.judge;
    const result = await recordOutcomes(
      {
        sink: a.sink,
        ...(a.writer ? { writer: a.writer } : {}),
        ...(judge ? { judge } : {}),
        // No onSpend: every judge here already records its own spend where it
        // leaves Marina — a configured backend through `metered()`
        // (src/decisions/config.ts), Marina engines and the fallback classifier
        // through this Marina's `/v1` passthru. Recording the verdict's cost
        // again would count each dollar twice.
      },
      batch,
      { maxOutcomes: batch.length, concurrency: 2 },
    );
    if (result.failed)
      logger.warn("main", "some outcomes could not be learned", { failed: result.failed });
  }
}

/** Wait until queued outcomes are processed (tests, scripts before exit). */
export async function settleOutcomes(db: MarinaDB): Promise<void> {
  const a = armed.get(db);
  while (a?.draining) await a.draining;
}

export interface RecalledLessons {
  /** Lessons to inject into a prompt (empty in observe/off mode). */
  inject: Lesson[];
  /** Everything recalled (observe mode records these without injecting). */
  recalled: Lesson[];
  mode: LessonsMode;
}

/**
 * Lessons for work in `domain` matching `query`, visible at `asOf` (the work's
 * evidence cutoff; default now). Never throws: a recall failure is no lessons.
 */
export async function recallLessons(
  db: MarinaDB | undefined,
  domain: OutcomeDomain,
  query: string,
  opts: {
    asOf?: string;
    limit?: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
    sink?: LessonSink;
  } = {},
): Promise<RecalledLessons> {
  const mode = lessonsMode(opts.env);
  if (mode === "off") return { inject: [], recalled: [], mode };
  // The given sink, else the armed one, else a recall-only reader of the pool:
  // recall never creates the lessons account or its spaces as a side effect,
  // and needs no arming (only writers do).
  const sink = opts.sink ?? (db ? (armed.get(db)?.sink ?? lessonRecallSinkFor(db)) : undefined);
  if (!sink) return { inject: [], recalled: [], mode };
  try {
    const recalled = await sink.recall(domain, query, opts.asOf ?? new Date().toISOString(), {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
    return { inject: mode === "on" ? recalled : [], recalled, mode };
  } catch {
    return { inject: [], recalled: [], mode };
  }
}

/**
 * Lessons across several domains for one query (a crew request, a reviewed
 * draft): each domain recalled, merged, then the one shared budget applied.
 */
export async function recallAcross(
  db: MarinaDB | undefined,
  domains: readonly OutcomeDomain[],
  query: string,
  opts: {
    asOf?: string;
    limit?: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
    sink?: LessonSink;
  } = {},
): Promise<RecalledLessons> {
  const mode = lessonsMode(opts.env);
  if (mode === "off" || (!db && !opts.sink)) return { inject: [], recalled: [], mode };
  const asOf = opts.asOf ?? new Date().toISOString();
  const per = await Promise.all(
    domains.map((d) =>
      recallLessons(db, d, query, {
        asOf,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.sink ? { sink: opts.sink } : {}),
      }),
    ),
  );
  const recalled = selectServed(
    per.flatMap((r) => r.recalled),
    asOf,
    {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    },
  );
  return { inject: mode === "on" ? recalled : [], recalled, mode };
}

// ─── Curation: retire and supersede ─────────────────────────────────────────
//
// A wrong or harmful lesson is retired, never erased: the record gets a new
// version with validity closed and `retired_reason` / `retired_at` /
// `retired_by` (+ `superseded_by`) in metadata, written through the memory
// service's audited `revise` (a `memory.revised` event and receipt per
// change). Recall never serves it again; `get` with a version reads every
// earlier version. Callers gate it (`lessons retire|supersede` checks
// `role.edit`: a lesson steers every agent it is recalled for).

/** The sink curation acts on: the armed one, else the durable sink over `db`. */
function curationSink(db: MarinaDB, sink?: LessonSink): LessonSink {
  return sink ?? armed.get(db)?.sink ?? lessonSinkFor(db);
}

/**
 * The sink a find-and-retire pass uses: the armed one, else the recall-only
 * reader (which can retire what it finds, and never creates a space to look in).
 */
export function lessonRetireSink(db: MarinaDB): LessonSink {
  return armed.get(db)?.sink ?? lessonRecallSinkFor(db);
}

/** Current lessons matching `selector` across `domains` (any trust), capped at `limit`. */
export async function findLessons(
  db: MarinaDB,
  domains: readonly OutcomeDomain[],
  selector: LessonSelector,
  opts: { limit?: number; sink?: LessonSink } = {},
): Promise<Lesson[]> {
  const sink = curationSink(db, opts.sink);
  if (!sink.find) throw new Error("this lesson store cannot list lessons");
  const limit = opts.limit ?? 200;
  const out: Lesson[] = [];
  for (const domain of domains) {
    if (out.length >= limit) break;
    out.push(...(await sink.find(domain, selector, limit - out.length)));
  }
  return out;
}

export interface RetireResult {
  retired: Lesson[];
  failed: Array<{ lesson: Lesson; error: string }>;
}

/** Retire each given lesson (from `findLessons`). Per-lesson failures are reported, not thrown. */
export async function retireLessons(
  db: MarinaDB,
  lessons: readonly Lesson[],
  retirement: LessonRetirement,
  opts: { sink?: LessonSink } = {},
): Promise<RetireResult> {
  const sink = curationSink(db, opts.sink);
  if (!sink.retire) throw new Error("this lesson store cannot retire lessons");
  const result: RetireResult = { retired: [], failed: [] };
  for (const lesson of lessons) {
    if (!lesson.id) {
      result.failed.push({ lesson, error: "no id" });
      continue;
    }
    try {
      await sink.retire(lesson.domain, lesson.id, retirement);
      result.retired.push(lesson);
    } catch (err) {
      result.failed.push({ lesson, error: getErrorMessage(err) });
    }
  }
  return result;
}

/**
 * Replace one lesson's text: write the replacement (same domain, kind,
 * category and `resolvedAt`, so the leakage rule is unchanged; labelled
 * `unverified` — curated text was not judged; `source` = `supersede:<old id>`)
 * and retire the original with `superseded_by` pointing at it.
 */
export async function supersedeLesson(
  db: MarinaDB,
  old: Lesson,
  text: string,
  retirement: Omit<LessonRetirement, "supersededBy">,
  opts: { sink?: LessonSink } = {},
): Promise<Lesson> {
  const sink = curationSink(db, opts.sink);
  if (!sink.retire) throw new Error("this lesson store cannot retire lessons");
  if (!old.id) throw new Error("the lesson has no id");
  const replacement: Lesson = {
    domain: old.domain,
    text,
    kind: old.kind,
    ...(old.category ? { category: old.category } : {}),
    trust: "unverified",
    resolvedAt: old.resolvedAt,
    source: `supersede:${old.id}`,
    refs: [old.id, ...(old.refs ?? [])],
  };
  const { id } = await sink.write(replacement);
  if (!id) throw new Error("the replacement lesson was not stored");
  await sink.retire(old.domain, old.id, { ...retirement, supersededBy: id });
  return { ...replacement, id };
}

/** A prompt block for injected lessons, or "" when none. */
export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  return `LESSONS (from past outcomes; trusted first):\n${lessons.map((l) => `- ${formatLesson(l)}`).join("\n")}`;
}
