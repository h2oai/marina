// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Arbiter in typed forecasts (`MARINA_FORECAST_ARBITER`, default `off`),
 * over the shared core in `src/orchestration/arbiter.ts`.
 *
 *   off      nothing changes: no call, no field, prompts byte-identical.
 *   observe  the forecast runs as today; a contested forecast is adjudicated
 *            and the verdict recorded on the answer (`arbiter`), never applied.
 *   on       verifier corrections and critic revisions become advisory: each
 *            is recorded as dissent and none changes the answer by itself. A
 *            contested forecast (runs disagree, a reviewer dissents, or judge
 *            scores spread) is adjudicated, and only an overrule that clears
 *            the bar (and the earned-trust rule) changes the runs' answer.
 *   replace  as `on`, but the per-run verifier does not run at all: the
 *            Arbiter, called only on contested forecasts, replaces always-on
 *            verification.
 *
 * Contested is judged on the runs' DRAFTS, so a same-model verifier's
 * correction is a dissent to weigh, not a fact. Earned trust reads the
 * forecast history (`MARINA_FORECAST_HISTORY`): each resolved record carries
 * whether the Arbiter overruled and whether that overrule beat the majority
 * (`ResolvedRecord.arbiter`, booleans only). General capability: nothing here
 * knows a benchmark.
 */

import {
  type ArbiterDissent,
  type ArbiterItem,
  ArbiterQuota,
  type ArbiterResult,
  type ArbiterRun,
  type ArbiterTrackRecord,
  type ArbiterValue,
  arbiterPolicyFromEnv,
  arbiterTrackRecord,
  arbitrate,
  overruleRight,
} from "../orchestration/arbiter";
import { type AnswerSpec, formatAnswer, validateAnswer } from "./answer-types";
import { type ForecastHistory, type ResolvedRecord, visibleRecords } from "./history";
import type { ModelPart, TypedForecastAnswer, TypedForecastRequest } from "./typed";

export type ForecastArbiterMode = "off" | "observe" | "on" | "replace";

/** `MARINA_FORECAST_ARBITER` (default off; junk is off). */
export function forecastArbiterModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ForecastArbiterMode {
  const v = env.MARINA_FORECAST_ARBITER?.trim().toLowerCase();
  return v === "observe" || v === "on" || v === "replace" ? v : "off";
}

/** The Arbiter decides the answer (verifier and critic only advise). */
export const arbiterDecides = (m: ForecastArbiterMode | undefined): boolean =>
  m === "on" || m === "replace";

/** The per-run verifier is replaced by the Arbiter. */
export const arbiterReplacesVerify = (m: ForecastArbiterMode | undefined): boolean =>
  m === "replace";

/** The audit record on a typed answer (`TypedForecastAnswer.arbiter`). */
export interface ForecastArbiterRecord {
  mode: Exclude<ForecastArbiterMode, "off">;
  /** The core's record: disagreement signals, verdict, bar, trust. */
  result?: ArbiterResult;
  /** The runs' majority answer (drafts), formatted. */
  majority?: string;
  /** The answer an overrule cleared the bar for (applied or not), formatted. */
  overrule?: string;
  /** True when the overrule replaced the answer. */
  applied: boolean;
  /** The Arbiter's overrule record when it adjudicated. */
  track?: ArbiterTrackRecord;
  /** Why it did not run (time budget, no model). */
  skipped?: string;
}

/** One process-wide daily allowance (`MARINA_ARBITER_CAP`). */
let quota: ArbiterQuota | undefined;
let quotaCap: number | undefined;
function processQuota(cap: number): ArbiterQuota {
  if (!quota || quotaCap !== cap) {
    quota = new ArbiterQuota(cap);
    quotaCap = cap;
  }
  return quota;
}

/** Tests: start the daily allowance afresh. */
export function resetForecastArbiterQuotaForTests(): void {
  quota = undefined;
  quotaCap = undefined;
}

const toValue = (spec: AnswerSpec, raw: unknown): ArbiterValue | undefined => {
  const v = validateAnswer(spec, raw);
  return "error" in v ? undefined : v.value;
};

/** The runs' drafts (before any verifier correction) as Arbiter runs. */
export function draftRuns(spec: AnswerSpec, runs: TypedForecastAnswer["runs"]): ArbiterRun[] {
  const out: ArbiterRun[] = [];
  for (const r of runs) {
    if (r.value === undefined || r.weight <= 0) continue;
    const corrected = r.verified?.verdict === "correct" && r.verified.draft !== undefined;
    const draft = corrected ? toValue(spec, r.verified!.draft) : r.value;
    if (draft === undefined) continue;
    out.push({ answer: draft, label: `run ${r.run}` });
  }
  return out;
}

/** Verifier and critic disagreement as dissent. */
export function reviewerDissent(
  spec: AnswerSpec,
  out: Pick<TypedForecastAnswer, "runs" | "critique">,
): ArbiterDissent[] {
  const dissent: ArbiterDissent[] = [];
  for (const r of out.runs) {
    const v = r.verified;
    if (v?.verdict !== "correct") continue;
    // Applied corrections replaced the run's value; advisory ones are in `proposed`.
    const answer = toValue(spec, v.proposed ?? r.formatted);
    dissent.push({
      by: `verifier on run ${r.run}`,
      ...(answer !== undefined ? { answer } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
    });
  }
  const c = out.critique;
  if (c?.verdict === "revise" && c.proposed !== undefined) {
    const answer = toValue(spec, c.proposed);
    dissent.push({
      by: "critic",
      ...(answer !== undefined ? { answer } : {}),
      ...(c.reason ? { reason: c.reason } : {}),
    });
  }
  return dissent;
}

/** The overrule record of the Arbiter `evaluator` from visible resolved history. */
export async function forecastTrackRecord(
  history: ForecastHistory | undefined,
  evaluator: string,
  cutoff: string,
  exceptId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ArbiterTrackRecord | undefined> {
  if (!history) return undefined;
  let records: ResolvedRecord[];
  try {
    records = visibleRecords(await history.all(), cutoff, exceptId);
  } catch {
    return undefined;
  }
  const entries = records.flatMap((r) =>
    r.arbiter?.overruled
      ? [
          {
            evaluator: r.arbiter.evaluator,
            ...(r.arbiter.right !== undefined ? { right: r.arbiter.right } : {}),
          },
        ]
      : [],
  );
  return arbiterTrackRecord(entries, evaluator, arbiterPolicyFromEnv(env));
}

/**
 * Adjudicate a finished typed forecast. Returns the record and, when an
 * overrule is to be applied (`on`/`replace`, bar cleared, trust allowed), the
 * validated answer to apply. Never throws.
 */
export async function forecastArbiterStage(input: {
  mode: Exclude<ForecastArbiterMode, "off">;
  req: TypedForecastRequest;
  out: TypedForecastAnswer;
  arbiter: ModelPart;
  dossier: string;
  history?: ForecastHistory;
  answerFormat?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  record: ForecastArbiterRecord;
  apply?: { value: ArbiterValue; confidence: number };
}> {
  const { mode, req, out } = input;
  const env = input.env ?? process.env;
  const spec = req.answer;
  const policy = arbiterPolicyFromEnv(env);
  const runs = draftRuns(spec, out.runs);
  const item: ArbiterItem = {
    id: req.id ?? "forecast",
    question: req.question,
    type: spec.type,
    runs,
    dissent: reviewerDissent(spec, out),
    judgeScores: out.runs.flatMap((r) =>
      r.value !== undefined && r.grounded !== undefined ? [r.grounded] : [],
    ),
    evidence: input.dossier,
    sources: out.sources.map((s) => s.url),
    ...("options" in spec
      ? { options: spec.options.map((o) => ({ id: o.id, label: o.label ?? o.id })) }
      : {}),
  };
  const track = await forecastTrackRecord(
    input.history,
    input.arbiter.name,
    out.cutoff.at,
    req.id,
    env,
  );
  const result = await arbitrate(item, {
    mode: mode === "observe" ? "observe" : "on",
    complete: input.arbiter.complete,
    evaluator: input.arbiter.name,
    policy,
    quota: processQuota(policy.cap),
    ...(track ? { track } : {}),
    ...(input.answerFormat ? { answerFormat: input.answerFormat } : {}),
  });
  const majority = result.disagreement.majority;
  const overrule = result.bar?.verdict === "overrule" ? result.bar.answer : undefined;
  const record: ForecastArbiterRecord = {
    mode,
    result,
    ...(majority !== undefined ? { majority: formatAnswer(majority) } : {}),
    ...(overrule !== undefined ? { overrule: formatAnswer(overrule) } : {}),
    applied: false,
    ...(result.status === "adjudicated" && track ? { track } : {}),
  };
  if (!result.applied || result.final === undefined) return { record };
  const v = validateAnswer(spec, result.final);
  if ("error" in v) return { record };
  record.applied = true;
  return { record, apply: { value: v.value, confidence: result.verdict?.confidence ?? 0 } };
}

/**
 * The arbiter part of a resolved history record: whether an overrule cleared
 * the bar (applied or only observed) and, when the truth can judge it,
 * whether it beat the majority. Booleans and the evaluator name only.
 */
export function arbiterHistory(
  answer: Pick<TypedForecastAnswer, "answer" | "arbiter">,
  truth: { options?: string[]; value?: unknown },
): ResolvedRecord["arbiter"] | undefined {
  const a = answer.arbiter;
  if (a?.result?.status !== "adjudicated") return undefined;
  const spec = answer.answer;
  const overruled = a.result.bar?.verdict === "overrule" && a.result.bar.answer !== undefined;
  const base = { evaluator: a.result.evaluator, overruled, applied: a.applied };
  if (!overruled) return base;
  const t: ArbiterValue | undefined =
    spec.type === "choice"
      ? truth.options?.[0]
      : spec.type === "multi" || spec.type === "ranking"
        ? truth.options
        : typeof truth.value === "number" || typeof truth.value === "string"
          ? truth.value
          : undefined;
  if (t === undefined) return base;
  const right = overruleRight(spec.type, a.result.disagreement.majority, a.result.bar!.answer!, t);
  return right === undefined ? base : { ...base, right };
}
