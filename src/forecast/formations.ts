// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Formations over the typed forecaster (`./typed.ts`): HOW several runs
 * combine, never WHAT they know. Every formation starts from one ordinary
 * typed forecast (plan → research → lookups → K independent runs), so the
 * evidence and its cutoff are identical; only the combination differs.
 *
 *   ensemble   — the typed forecaster as is: the runs combined by type, then
 *                the critique (the control for the others)
 *   delphi     — independence before influence: the runs are round one; each
 *                member then sees an ANONYMOUS panel summary (per-option
 *                medians and ranges, short reason snippets, no names) and the
 *                same research, and revises once; the answer is the median of
 *                the revisions (per option for probabilities)
 *   tournament — the runs' proposals meet in pairwise knockout matches judged
 *                by the critic (an odd field gives a bye); the champion's
 *                answer and uncertainty are the forecast; the bracket is kept
 *
 * The verification formation is the typed forecaster's own `verify` option,
 * and a crew formation is a `marina:<crew>` analyst — both compose with these.
 * A failed member or match drops out (a match falls to the first proposal);
 * with fewer than two usable runs every formation returns the runs' answer.
 */

import {
  type AnswerOption,
  type AnswerSpec,
  type AnswerValue,
  combineAnswers,
  formatAnswer,
  validateAnswer,
} from "./answer-types";
import {
  argmax,
  combinedSd,
  completeMarginals,
  type Distribution,
  normalise,
  parseDistribution,
  parseMarginals,
  pickDistribution,
} from "./distribution";
import { askAnalyst } from "./judge";
import {
  answerInstruction,
  forecastTyped,
  type ModelPart,
  type TypedForecastAnswer,
  type TypedForecastDeps,
  type TypedForecastRequest,
  type TypedRun,
} from "./typed";

export const TYPED_FORMATIONS = ["ensemble", "delphi", "tournament"] as const;
export type TypedFormation = (typeof TYPED_FORMATIONS)[number];

export function typedFormation(name: string | undefined): TypedFormation | undefined {
  const n = name?.trim().toLowerCase();
  return (TYPED_FORMATIONS as readonly string[]).includes(n ?? "")
    ? (n as TypedFormation)
    : undefined;
}

/** The operator's formation for typed forecasts (`MARINA_FORECAST_FORMATION`, default ensemble). */
export function formationFromEnv(env: NodeJS.ProcessEnv = process.env): TypedFormation {
  return typedFormation(env.MARINA_FORECAST_FORMATION) ?? "ensemble";
}

export interface FormationStep {
  member: string;
  formatted?: string;
  distribution?: Distribution;
  sd?: number;
  reason?: string;
  error?: string;
}

export interface FormationMatch {
  a: number;
  b: number;
  winner: number;
  reason?: string;
  error?: string;
}

export interface FormationRecord {
  pattern: TypedFormation;
  /** Delphi: the revisions. */
  revisions?: FormationStep[];
  /** Tournament: the bracket, by run number. */
  matches?: FormationMatch[];
  champion?: number;
  /** Why the formation fell back to the runs' own answer. */
  fallback?: string;
}

export type FormedAnswer = TypedForecastAnswer & { formation: FormationRecord };

const SNIPPET = 160;
const MAX_RESEARCH = 12_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function forecastFormed(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  pattern: TypedFormation = "ensemble",
): Promise<FormedAnswer> {
  if (pattern === "ensemble") {
    return { ...(await forecastTyped(req, deps)), formation: { pattern } };
  }
  // Round one: the ordinary forecast without its critique (the formation replaces it),
  // keeping the research the runs read so the second step sees the same evidence.
  const research: string[] = [];
  const first = await forecastTyped(req, {
    ...deps,
    retriever: async (brief) => {
      const r = await deps.retriever(brief);
      research.push(r.report);
      return r;
    },
    options: { ...deps.options, critique: false },
  });
  const usable = first.runs.filter((r) => r.weight > 0 && r.formatted !== undefined);
  if (usable.length < 2) {
    return { ...first, formation: { pattern, fallback: "fewer than two usable runs" } };
  }
  const evidence = clip(research.join("\n\n"), MAX_RESEARCH);
  return pattern === "delphi"
    ? delphi(req, deps, first, usable, evidence)
    : tournament(req, deps, first, usable, evidence);
}

// ─── Delphi ──────────────────────────────────────────────────────────────────

function describeRun(spec: AnswerSpec, r: Pick<TypedRun, "formatted" | "distribution" | "sd">) {
  const parts = [`answer ${r.formatted}`];
  if (r.distribution) {
    parts.push(
      `probabilities ${Object.entries(r.distribution)
        .map(([k, p]) => `${k}=${p.toFixed(2)}`)
        .join(" ")}`,
    );
  }
  if (spec.type === "number" && r.sd !== undefined) parts.push(`sd ${r.sd}`);
  return parts.join("; ");
}

/** The anonymous panel summary: medians, ranges and reason snippets, never who said what. */
export function panelSummary(spec: AnswerSpec, runs: TypedRun[]): string {
  const lines: string[] = [`${runs.length} forecasters answered independently.`];
  const withDist = runs.filter((r) => r.distribution);
  if (withDist.length && "options" in spec) {
    for (const o of spec.options) {
      const ps = withDist.map((r) => r.distribution![o.id] ?? 0);
      lines.push(
        `  ${o.id}${o.label ? ` (${clip(o.label, 60)})` : ""}: median ${median(ps).toFixed(2)}, range ${Math.min(...ps).toFixed(2)}–${Math.max(...ps).toFixed(2)}`,
      );
    }
  } else if (spec.type === "number") {
    const xs = runs.map((r) => r.value as number);
    lines.push(`  median ${median(xs)}, range ${Math.min(...xs)}–${Math.max(...xs)}`);
  } else {
    const counts = new Map<string, number>();
    for (const r of runs) counts.set(r.formatted!, (counts.get(r.formatted!) ?? 0) + 1);
    for (const [a, n] of counts) lines.push(`  ${n}× ${clip(a, 80)}`);
  }
  const reasons = runs.map((r) => r.reason).filter((x): x is string => !!x);
  if (reasons.length) {
    lines.push("Reasons given (anonymous):");
    for (const r of reasons) lines.push(`  - ${clip(r, SNIPPET)}`);
  }
  return lines.join("\n");
}

function reviseSystem(spec: AnswerSpec): string {
  return [
    "You are one member of an anonymous forecasting panel (Delphi method). You answered independently;",
    "now you see the panel's anonymous summary and the same research. Revise your forecast ONCE: move",
    "toward the others only where their reasons are better than yours; keep your view where yours is.",
    "Forecast AS OF the evidence cutoff; nothing after it exists.",
    answerInstruction(spec),
    'Reply with ONE JSON object: {"answer": <as above>, "confidence": <0..1>,' +
      `${spec.type === "number" ? ' "sd": <number>,' : ""}${"options" in spec && (spec as { probabilities?: boolean }).probabilities ? ' "probabilities": {<option id>: <0..1>, …},' : ""} "reason": "<two sentences: what you kept or changed and why>"}.`,
  ].join("\n");
}

function baseUser(req: TypedForecastRequest, cutoff: string, evidence: string): string {
  return [
    `Question: ${req.question}`,
    req.context ? `Notes: ${clip(req.context, 3_000)}` : "",
    `Evidence cutoff: ${cutoff}`,
    `RESEARCH (as the panel saw it):\n${evidence || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A reply's answer, probabilities and sd, like a run's. */
function readReply(
  spec: AnswerSpec,
  reply: Record<string, unknown> | undefined,
): FormationStep & {
  value?: AnswerValue;
} {
  const v = validateAnswer(spec, reply?.answer);
  if ("error" in v) return { member: "", error: `invalid: ${v.error}` };
  const out: FormationStep & { value?: AnswerValue } = {
    member: "",
    value: v.value,
    formatted: formatAnswer(v.value),
  };
  const c = Number(reply?.confidence);
  const conf = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : undefined;
  if (spec.type === "choice" && spec.probabilities) {
    out.distribution =
      parseDistribution(spec.options, reply?.probabilities) ??
      pickDistribution(spec.options, v.value as string, conf);
  }
  if (spec.type === "multi" && spec.probabilities) {
    out.distribution = completeMarginals(
      spec.options,
      parseMarginals(spec.options, reply?.probabilities),
      v.value as string[],
      conf,
    );
  }
  if (spec.type === "number") {
    const sd = Number(reply?.sd);
    if (Number.isFinite(sd) && sd > 0) out.sd = sd;
  }
  if (typeof reply?.reason === "string") out.reason = reply.reason.slice(0, 400);
  return out;
}

async function delphi(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  first: TypedForecastAnswer,
  usable: TypedRun[],
  evidence: string,
): Promise<FormedAnswer> {
  const spec = req.answer;
  const summary = panelSummary(spec, usable);
  const system = reviseSystem(spec);
  const revisions = await Promise.all(
    usable.map(async (run, i) => {
      const member = memberFor(deps.analysts, run, i);
      const user = `${baseUser(req, first.cutoff.at, evidence)}\n\nYOUR EARLIER ANSWER: ${describeRun(spec, run)}${run.reason ? `\nYour reason: ${clip(run.reason, 300)}` : ""}\n\nTHE PANEL (anonymous):\n${summary}`;
      const { reply, error } = await askAnalyst(member, system, user);
      if (error !== undefined) return { member: member.name, error: error.slice(0, 160) };
      return { ...readReply(spec, reply), member: member.name };
    }),
  );
  const ok = revisions.filter((r) => r.formatted !== undefined) as Array<
    FormationStep & { value: AnswerValue }
  >;
  const record: FormationRecord = { pattern: "delphi", revisions: revisions.map(stripValue) };
  if (ok.length === 0) return { ...first, formation: { ...record, fallback: "no revision" } };
  const out: FormedAnswer = { ...first, formation: record };
  const combined = combineAnswers(
    spec,
    ok.map((r) => ({ value: r.value, weight: 1 })),
  );
  if (combined) {
    out.combined = combined;
    out.prediction = combined.value;
    out.formatted = formatAnswer(combined.value);
    out.confidence = combined.agreement;
  }
  if ("options" in spec && ok.every((r) => r.distribution)) {
    const dist = medianDistribution(
      spec.options,
      ok.map((r) => r.distribution!),
      spec.type === "choice",
    );
    out.distribution = dist;
    if (spec.type === "choice") {
      const top = argmax(spec.options, dist);
      out.prediction = top;
      out.formatted = top;
      out.confidence = dist[top];
    }
  }
  if (spec.type === "number") {
    const sd = combinedSd(
      ok.map((r) => ({ ...(r.sd !== undefined ? { sd: r.sd } : {}), weight: 1 })),
      combined?.spread ?? 0,
    );
    if (sd !== undefined) out.uncertainty = { sd };
  }
  return out;
}

/** Per-option median; a choice's renormalised to sum 1. */
function medianDistribution(
  options: AnswerOption[],
  ds: Distribution[],
  sumToOne: boolean,
): Distribution {
  const out: Distribution = {};
  for (const o of options) out[o.id] = median(ds.map((d) => d[o.id] ?? 0));
  if (sumToOne) return normalise(out) ?? out;
  return out;
}

// ─── Tournament ──────────────────────────────────────────────────────────────

const MATCH_SYSTEM = [
  "You referee a forecasting match. Two anonymous forecasts (A and B) answer the same question from the same research.",
  "Pick the one more likely to score better under a proper scoring rule: grounded in the research, consistent with the",
  "resolution rules, calibrated (not over- or under-confident). Ignore style and length.",
  'Reply with ONE JSON object: {"winner": "A" | "B", "reason": "<one sentence>"}.',
].join(" ");

async function tournament(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  first: TypedForecastAnswer,
  usable: TypedRun[],
  evidence: string,
): Promise<FormedAnswer> {
  const spec = req.answer;
  const referee = deps.critic ?? deps.planner ?? deps.analysts[0]!;
  const matches: FormationMatch[] = [];
  let field = [...usable];
  while (field.length > 1) {
    const next: TypedRun[] = [];
    for (let i = 0; i < field.length; i += 2) {
      const a = field[i]!;
      const b = field[i + 1];
      if (!b) {
        next.push(a); // a bye
        continue;
      }
      const user = `${baseUser(req, first.cutoff.at, evidence)}\n\nFORECAST A: ${describeRun(spec, a)}\nReason A: ${clip(a.reason ?? "", 400)}\n\nFORECAST B: ${describeRun(spec, b)}\nReason B: ${clip(b.reason ?? "", 400)}`;
      const { reply, error } = await askAnalyst(referee, MATCH_SYSTEM, user);
      const pick = String(reply?.winner ?? "")
        .trim()
        .toUpperCase();
      const winner = pick === "B" ? b : a;
      matches.push({
        a: a.run,
        b: b.run,
        winner: winner.run,
        ...(typeof reply?.reason === "string" ? { reason: reply.reason.slice(0, 200) } : {}),
        ...(error !== undefined
          ? { error: error.slice(0, 160) }
          : pick !== "A" && pick !== "B"
            ? { error: "no winner named; A advances" }
            : {}),
      });
      next.push(winner);
    }
    field = next;
  }
  const champ = field[0]!;
  const out: FormedAnswer = {
    ...first,
    prediction: champ.value,
    formatted: champ.formatted,
    ...(champ.confidence !== undefined ? { confidence: champ.confidence } : {}),
    formation: { pattern: "tournament", matches, champion: champ.run },
  };
  if (champ.distribution) {
    out.distribution = champ.distribution;
    if (spec.type === "choice") out.confidence = champ.distribution[champ.formatted!];
  }
  if (spec.type === "number") {
    const sd = champ.sd ?? first.uncertainty?.sd;
    if (sd !== undefined) out.uncertainty = { sd };
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function memberFor(analysts: ModelPart[], run: TypedRun, i: number): ModelPart {
  return analysts.find((a) => a.name === run.model) ?? analysts[i % analysts.length]!;
}

function stripValue(s: FormationStep & { value?: AnswerValue }): FormationStep {
  const { value: _v, ...rest } = s;
  return rest;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
