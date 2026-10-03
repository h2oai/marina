// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The analyst + judge step shared by the arena's research forecaster
 * (`src/arena/research/forecaster.ts`) and forecasting any question
 * (`src/forecast/question.ts`):
 *
 *   askAnalyst  — one analyst model, its reply parsed to a JSON object; an
 *                 error is captured, never thrown;
 *   judgeClaim  — the judge scores the analyst's claim against the verified
 *                 evidence. No judge ⇒ weight 1. A judge OUTAGE ⇒ weight 0 and
 *                 the error is recorded: an outage is no opinion, never a pass.
 *
 * Totals (calls, worst latency, cost, errors) accumulate into a `JudgeRecord`
 * that each caller returns in its answer object — the audit trail.
 */

import { parseReply } from "../arena/model-forecaster";
import type { Evidence } from "../decisions/evidence";
import type { DecisionProvider } from "../decisions/types";
import { checkDraft } from "../decisions/verify";

/** What the judge was and what it cost, summed over the claims it judged. */
export interface JudgeRecord {
  provider?: string;
  model?: string;
  calls: number;
  latencyMs: number;
  costUsd: number;
  errors: number;
  error?: string;
}

/** A judged claim: its weight and the judge's numbers (absent when unjudged). */
export interface JudgedClaim {
  weight: number;
  quality?: number;
  grounded?: number;
  /** The judge failed on this claim; it then carries no weight. */
  judgeError?: string;
  judgeLatencyMs?: number;
  judgeCostUsd?: number;
}

export interface AnalystReply {
  reply?: Record<string, unknown>;
  /** The analyst's raw text (present whenever the call returned). */
  raw?: string;
  /** The call failed; the full message (callers truncate for display). */
  error?: string;
}

/** Ask one analyst; parse the reply to a JSON object (undefined when none). Never throws. */
export async function askAnalyst(
  analyst: { complete: (system: string, user: string) => Promise<string> },
  system: string,
  user: string,
): Promise<AnalystReply> {
  try {
    const raw = await analyst.complete(system, user);
    const reply = parseReply(raw);
    return reply ? { reply, raw } : { raw };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function newJudgeRecord(judge: DecisionProvider | undefined): JudgeRecord | undefined {
  return judge
    ? {
        provider: judge.kind,
        ...(judge.model ? { model: judge.model } : {}),
        calls: 0,
        latencyMs: 0,
        costUsd: 0,
        errors: 0,
      }
    : undefined;
}

/** The record as it goes into an answer (cost rounded to micro-dollars). */
export function judgeAudit(judgeRecord: JudgeRecord | undefined): { judge?: JudgeRecord } {
  return judgeRecord
    ? { judge: { ...judgeRecord, costUsd: Math.round(judgeRecord.costUsd * 1e6) / 1e6 } }
    : {};
}

/** Default weight: grounded × quality / 2, clamped to [0, 1]. */
export function groundedWeight(grounded: number | undefined, quality: number | undefined): number {
  return Math.max(0, Math.min(1, (grounded ?? 0) * ((quality ?? 0) / 2)));
}

/**
 * One claim through the judge. No judge ⇒ weight 1. A judge outage ⇒
 * weight 0 with `judgeError` set (it used to keep weight 1 — ~10× a judged
 * run). `weightOf` maps the judge's signals to a weight (default
 * {@link groundedWeight}).
 */
export async function judgeClaim(
  judge: DecisionProvider | undefined,
  judgeRecord: JudgeRecord | undefined,
  draft: string,
  evidence: Evidence[],
  question: string,
  weightOf: (grounded: number | undefined, quality: number | undefined) => number = groundedWeight,
): Promise<JudgedClaim> {
  if (!judge) return { weight: 1 };
  const verdict = await checkDraft(judge, draft.slice(0, 3_000), evidence, question);
  if (judgeRecord) {
    judgeRecord.calls++;
    if (verdict.provider) judgeRecord.provider = verdict.provider;
    if (verdict.model) judgeRecord.model = verdict.model;
    judgeRecord.latencyMs = Math.max(judgeRecord.latencyMs, verdict.latencyMs ?? 0);
    judgeRecord.costUsd += verdict.costUsd ?? 0;
  }
  const timing = {
    ...(verdict.latencyMs === undefined ? {} : { judgeLatencyMs: verdict.latencyMs }),
    ...(verdict.costUsd === undefined ? {} : { judgeCostUsd: verdict.costUsd }),
  };
  if (verdict.error) {
    const judgeError = String(verdict.error).slice(0, 200);
    if (judgeRecord) {
      judgeRecord.errors++;
      judgeRecord.error = judgeError;
    }
    return { weight: 0, judgeError, ...timing };
  }
  const quality = verdict.signals.quality;
  const grounded = verdict.signals.grounded;
  return {
    weight: weightOf(grounded, quality),
    ...(quality === undefined ? {} : { quality }),
    ...(grounded === undefined ? {} : { grounded }),
    ...timing,
  };
}
