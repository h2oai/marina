// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory relevance gate: an optional step after retrieval and before memories
 * are served that DROPS retrieved items that do not bear on the query.
 *
 *   MARINA_MEMORY_RELEVANCE_GATE=off|observe|on   (default off)
 *     off      today's behaviour: no call, no change
 *     observe  every item is scored and the would-be drops are reported in the
 *              result's `relevance` block; what is served is unchanged
 *     on       items judged irrelevant are dropped; when nothing relevant is
 *              left the context says so explicitly ("no relevant memory
 *              found"), so a reader can answer unknown instead of guessing
 *              from keyword noise
 *
 * Backends, all optional, resolved in order:
 *   1. the decision layer (`harnessDecisionProvider`: `MARINA_DECISIONS` /
 *      `MARINA_DECISION_ENGINE`) — one `noul` question per item, batched;
 *   2. the single-LLM fallback — one model through this Marina's own `/v1`
 *      (`MARINA_MEMORY_RELEVANCE_GATE_MODEL`, default `marina/default`) as an
 *      uncalibrated chat classifier: ONE verbalized call per batch;
 *   3. the mechanical floor — query-term coverage, when the model is `none`
 *      (no model available).
 *
 * Policy (pure, `gateVerdicts`):
 *   - drop only: items are kept or removed, never rewritten or reordered;
 *   - fail OPEN: a backend outage, a reply past the bound
 *     (`MARINA_MEMORY_RELEVANCE_GATE_TIMEOUT_MS`, reason `timeout`), an
 *     incomplete reply or the daily spend cap serves the ungated set,
 *     labelled in `relevance.outcome` / `reason`;
 *     an item the backend left unanswered is kept;
 *   - exempt: `core` and pinned items are never dropped and never judged;
 *   - at most `maxItems` judged items are kept (highest relevance first);
 *   - a calibrated backend keeps p ≥ 0.3; an uncalibrated one gets one cut
 *     at 0.5 (`UNCALIBRATED_GATE_POLICY`'s convention).
 *
 * Spend: the decision layer's metered provider records its cost and refuses
 * at the daily cap; the `/v1` fallback is recorded by the passthru hop it
 * goes through; the gate checks `dailyCapRefusal` before asking either. The
 * report and the log line carry counts, ids and numbers — never content.
 */

import { classifierEngine, type EngineDeps, harnessDecisionProvider } from "../decisions/engines";
import { DecisionError, type DecisionProvider, type DecisionQuestions } from "../decisions/types";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type {
  UnifiedRelevanceMode,
  UnifiedRelevanceReport,
  UnifiedTier,
} from "../sdk/memory-context";
import { queryTerms, termCoverage } from "./term-match";

const logger = new Logger();

/** The gate's own deadline (distinct from a backend's error). */
class GateTimeout extends Error {}

export type RelevanceGateMode = UnifiedRelevanceMode;
export type RelevanceGateReport = UnifiedRelevanceReport;

/** The single-LLM fallback model when no decision backend is configured. */
export const DEFAULT_RELEVANCE_GATE_MODEL = "marina/default";
/** Judged items kept at most (exempt items do not count). */
export const RELEVANCE_GATE_MAX_ITEMS = 8;
/** Items per decision request. */
export const RELEVANCE_GATE_BATCH = 12;
/** Bytes of each item the judge sees (head of the content). */
export const RELEVANCE_GATE_ITEM_BYTES = 800;
/** Bytes of the query the judge sees. */
export const RELEVANCE_GATE_QUERY_BYTES = 1000;
/** Keep threshold for a calibrated backend (p of "bears on the query"). */
export const CALIBRATED_KEEP_AT = 0.3;
/** The one cut for an uncalibrated backend. */
export const UNCALIBRATED_KEEP_AT = 0.5;
/** Mechanical floor: share of distinct query terms an item must contain. */
export const MECHANICAL_COVERAGE_FLOOR = 0.4;
/** Default bound on the gate's model calls (`MARINA_MEMORY_RELEVANCE_GATE_TIMEOUT_MS`). */
export const DEFAULT_RELEVANCE_GATE_TIMEOUT_MS = 30_000;

/** `MARINA_MEMORY_RELEVANCE_GATE` (default off; anything unrecognised is off). */
export function relevanceGateMode(env: NodeJS.ProcessEnv = process.env): RelevanceGateMode {
  const v = env.MARINA_MEMORY_RELEVANCE_GATE?.trim().toLowerCase();
  if (v === "on" || v === "true") return "on";
  if (v === "observe") return "observe";
  return "off";
}

/** `MARINA_MEMORY_RELEVANCE_GATE_MODEL`; undefined when set to `none` / `off`. */
export function relevanceGateModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.MARINA_MEMORY_RELEVANCE_GATE_MODEL?.trim();
  if (!v) return DEFAULT_RELEVANCE_GATE_MODEL;
  if (v.toLowerCase() === "none" || v.toLowerCase() === "off") return undefined;
  return v;
}

/**
 * `MARINA_MEMORY_RELEVANCE_GATE_TIMEOUT_MS`: how long the gate waits for its
 * model backend (default 30 000; a positive integer, else the default). Past
 * it the gate fails open, labelled `timeout`.
 */
export function relevanceGateTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_MEMORY_RELEVANCE_GATE_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RELEVANCE_GATE_TIMEOUT_MS;
}

const fallbacks = new Map<string, DecisionProvider>();

/**
 * The gate's model backend from the environment: the decision layer, else the
 * single-LLM fallback through this Marina's `/v1`, else undefined (the
 * mechanical floor).
 */
export function relevanceGateProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: EngineDeps = {},
): DecisionProvider | undefined {
  const configured = harnessDecisionProvider(env, deps);
  if (configured) return configured;
  const model = relevanceGateModel(env);
  if (!model) return undefined;
  const timeoutMs = relevanceGateTimeoutMs(env);
  const key = `${model}|${env.WS_PORT ?? ""}|${timeoutMs}`;
  let provider = fallbacks.get(key);
  if (!provider || deps.fetch || deps.selfBaseUrl || deps.token) {
    // A yes/no judgement needs no reasoning; reasoning-by-default models
    // otherwise spend the whole bound thinking (`reasoning: off`).
    provider = classifierEngine(model, env, deps, "verbalized", { timeoutMs, reasoning: "off" });
    if (!deps.fetch && !deps.selfBaseUrl && !deps.token) fallbacks.set(key, provider);
  }
  return provider;
}

/** A label for the backend (`decision:<kind>:<model>`, `model:<id>`, `mechanical`). */
export function relevanceBackendLabel(provider: DecisionProvider | undefined): string {
  if (!provider) return "mechanical";
  return provider.kind === "marina-classifier"
    ? `model:${provider.model}`
    : `decision:${provider.kind}:${provider.model}`;
}

// ─── Policy ─────────────────────────────────────────────────────────────────

export interface RelevanceCandidate {
  /** Stable key (`<tier>:<id>`) the caller maps back to its item. */
  key: string;
  tier: UnifiedTier;
  content: string;
  /** `core` / pinned: never judged, never dropped. */
  exempt: boolean;
}

/** One candidate's score: a relevance in 0..1, or undefined (unanswered ⇒ kept). */
export type RelevanceScore = number | undefined;

export interface GateVerdicts {
  keep: boolean[];
  /** Why each dropped item went: below the threshold, or past `maxItems`. */
  why: ("kept" | "exempt" | "unscored" | "irrelevant" | "max")[];
}

/**
 * Pure verdicts: exempt and unscored items stay; a scored item stays when its
 * score clears `keepAt`; of those, at most `maxItems` (highest score first,
 * ties by position) stay. Never reorders.
 */
export function gateVerdicts(
  candidates: readonly Pick<RelevanceCandidate, "exempt">[],
  scores: readonly RelevanceScore[],
  opts: { keepAt: number; maxItems: number },
): GateVerdicts {
  const why: GateVerdicts["why"] = candidates.map((c, i) => {
    if (c.exempt) return "exempt";
    const s = scores[i];
    if (s === undefined || !Number.isFinite(s)) return "unscored";
    return s >= opts.keepAt ? "kept" : "irrelevant";
  });
  const ranked = why
    .map((w, i) => ({ i, w, s: scores[i] ?? Number.POSITIVE_INFINITY }))
    .filter((x) => x.w === "kept" || x.w === "unscored")
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const cap = Math.max(0, Math.floor(opts.maxItems));
  for (const extra of ranked.slice(cap)) why[extra.i] = "max";
  return { keep: why.map((w) => w === "kept" || w === "exempt" || w === "unscored"), why };
}

/** Mechanical relevance: the share of distinct query terms the item contains. */
export function mechanicalScores(
  query: string,
  candidates: readonly Pick<RelevanceCandidate, "content">[],
): number[] {
  const terms = queryTerms(query);
  return candidates.map((c) => termCoverage(c.content, terms));
}

// ─── Decision request ───────────────────────────────────────────────────────

const encoder = new TextEncoder();

function headBytes(text: string, max: number): string {
  if (encoder.encode(text).length <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = encoder.encode(ch).length;
    if (used + b > max - 3) break;
    out += ch;
    used += b;
  }
  return `${out}…`;
}

const label = (i: number) => `M${i + 1}`;

/** One batch as a decision request: the query plus one `noul` per memory. */
export function relevanceRequest(
  query: string,
  batch: readonly Pick<RelevanceCandidate, "content">[],
): { state: unknown; questions: DecisionQuestions } {
  const questions: DecisionQuestions = {};
  batch.forEach((_, i) => {
    const m = label(i);
    questions[m] = {
      type: "noul",
      instructions: `Does memory ${m} bear on answering the query? Sharing words or a broad topic with the query is not enough.`,
      criteria: {
        true: `${m} states a fact, event or detail the answer depends on, or shows that the query's premise is false.`,
        false: `${m} is about something else; at most it shares some words or a general topic with the query.`,
      },
    };
  });
  return {
    state: {
      task: "Retrieved memories are about to be shown to a reader answering the query. Judge each memory independently.",
      query: headBytes(query, RELEVANCE_GATE_QUERY_BYTES),
      memories: batch.map((c, i) => ({
        id: label(i),
        text: headBytes(c.content, RELEVANCE_GATE_ITEM_BYTES),
      })),
    },
    questions,
  };
}

// ─── The gate ───────────────────────────────────────────────────────────────

export interface GateOptions {
  mode: Exclude<RelevanceGateMode, "off">;
  /** A model backend; undefined ⇒ the mechanical floor. */
  provider?: DecisionProvider;
  maxItems?: number;
  /** The daily-cap check (default `dailyCapRefusal`). */
  spendCheck?: () => string | undefined;
  signal?: AbortSignal;
  /** Bound on the backend calls (default `relevanceGateTimeoutMs()`); past it ⇒ fail open, `timeout`. */
  timeoutMs?: number;
}

export interface GateResult {
  /** Keys to serve (all of them unless mode is `on` and the gate applied). */
  keep: Set<string>;
  report: RelevanceGateReport;
}

/**
 * Score `candidates` against `query` and decide what to serve. Never throws:
 * every failure serves the ungated set with the reason labelled.
 */
export async function gateRelevance(
  query: string,
  candidates: readonly RelevanceCandidate[],
  opts: GateOptions,
): Promise<GateResult> {
  const started = performance.now();
  const maxItems = opts.maxItems ?? RELEVANCE_GATE_MAX_ITEMS;
  const all = new Set(candidates.map((c) => c.key));
  const backend = relevanceBackendLabel(opts.provider);
  const calibrated = opts.provider ? opts.provider.calibrated !== false : false;
  const exempt = candidates.filter((c) => c.exempt).length;
  const base = {
    mode: opts.mode,
    backend,
    calibrated,
    candidates: candidates.length,
    exempt,
    maxItems,
  };
  const finish = (
    report: Omit<RelevanceGateReport, keyof typeof base | "latencyMs">,
    keep: Set<string>,
  ): GateResult => {
    const full: RelevanceGateReport = {
      ...base,
      ...report,
      latencyMs: Math.round(performance.now() - started),
    };
    logger.debug("memory", "relevance gate", {
      mode: full.mode,
      backend: full.backend,
      outcome: full.outcome,
      ...(full.reason ? { reason: full.reason } : {}),
      candidates: full.candidates,
      exempt: full.exempt,
      dropped: full.dropped.length,
      calls: full.calls,
      latencyMs: full.latencyMs,
      ...(full.costUsd === undefined ? {} : { costUsd: full.costUsd }),
    });
    return { keep, report: full };
  };
  const failOpen = (reason: string, calls = 0, costUsd?: number) =>
    finish(
      {
        outcome: "fail_open",
        reason,
        scored: 0,
        dropped: [],
        kept: candidates.length,
        calls,
        ...(costUsd === undefined ? {} : { costUsd }),
      },
      all,
    );

  const judged = candidates.filter((c) => !c.exempt);
  if (judged.length === 0)
    return finish(
      { outcome: "no_candidates", scored: 0, dropped: [], kept: candidates.length, calls: 0 },
      all,
    );

  const scores: RelevanceScore[] = candidates.map(() => undefined);
  let calls = 0;
  let costUsd: number | undefined;
  let keepAt = MECHANICAL_COVERAGE_FLOOR;
  if (!opts.provider) {
    const mech = mechanicalScores(query, candidates);
    candidates.forEach((c, i) => {
      if (!c.exempt) scores[i] = mech[i];
    });
  } else {
    const capped = (opts.spendCheck ?? dailyCapRefusal)();
    if (capped) return failOpen("spend_cap");
    const provider = opts.provider;
    const indices = candidates.map((c, i) => (c.exempt ? -1 : i)).filter((i) => i >= 0);
    const batches: number[][] = [];
    for (let i = 0; i < indices.length; i += RELEVANCE_GATE_BATCH)
      batches.push(indices.slice(i, i + RELEVANCE_GATE_BATCH));
    let uncalibratedReply = false;
    const timeoutMs = opts.timeoutMs ?? relevanceGateTimeoutMs();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new GateTimeout(`relevance gate timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
    // A backend that ignores its signal still cannot hold the gate past the bound.
    const expired = new Promise<never>((_, reject) =>
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), {
        once: true,
      }),
    );
    expired.catch(() => undefined);
    try {
      const replies = await Promise.race([
        Promise.all(
          batches.map((batch) =>
            provider.ask(
              relevanceRequest(
                query,
                batch.map((i) => candidates[i]!),
              ),
              signal,
            ),
          ),
        ),
        expired,
      ]);
      calls = replies.length;
      replies.forEach((reply, b) => {
        if (reply.calibrated === false) uncalibratedReply = true;
        if (reply.costUsd !== undefined) costUsd = (costUsd ?? 0) + reply.costUsd;
        batches[b]!.forEach((index, j) => {
          const answer = reply.answers[label(j)];
          if (answer?.type === "noul" && Number.isFinite(answer.noul)) scores[index] = answer.noul;
        });
      });
    } catch (error) {
      const timedOut =
        deadline.signal.aborted ||
        error instanceof GateTimeout ||
        (error instanceof DecisionError && error.code === "timeout");
      logger.debug("memory", "relevance gate backend unavailable", {
        backend,
        ...(timedOut ? { timeoutMs } : {}),
        error: getErrorMessage(error).slice(0, 200),
      });
      return failOpen(timedOut ? "timeout" : "backend_unavailable", calls);
    } finally {
      clearTimeout(timer);
    }
    if (scores.every((s) => s === undefined)) return failOpen("incomplete", calls, costUsd);
    keepAt = calibrated && !uncalibratedReply ? CALIBRATED_KEEP_AT : UNCALIBRATED_KEEP_AT;
  }

  const verdicts = gateVerdicts(candidates, scores, { keepAt, maxItems });
  const dropped = candidates.filter((_, i) => !verdicts.keep[i]).map((c) => c.key);
  const scored = scores.filter((s) => s !== undefined).length;
  const keep =
    opts.mode === "on"
      ? new Set(candidates.filter((_, i) => verdicts.keep[i]).map((c) => c.key))
      : all;
  return finish(
    {
      outcome: opts.mode === "on" ? "applied" : "observed",
      scored,
      dropped,
      kept: keep.size,
      calls,
      keepAt,
      ...(costUsd === undefined ? {} : { costUsd }),
    },
    keep,
  );
}
