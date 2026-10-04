// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The skeptic crew — the arena's crew formation (`src/arena/crew.ts`) for any
 * typed question. Three roles, each its own model (one per vendor where the
 * operator configured several):
 *
 *   statistician  the first analyst — reasons from numbers: base rates, the
 *                 latest readings, the start forecast, the usual change
 *   analyst       the second analyst — reasons from the specifics: who and
 *                 what decide it, scheduled events, the sources, the lessons
 *   skeptic       the critic (else the third analyst) — sees the start
 *                 forecast, both proposals, the research and the forecaster's
 *                 track record in this answer group, and says how much of the
 *                 proposals' move away from the start forecast to TRUST
 *
 * The start forecast is the question's INFORMATIVE prior (`./prior.ts`: a
 * supplied market or community forecast, a market lookup, the freshest
 * official reading, the class base rate) — never the uniform type default.
 *
 * Aggregation is deterministic code, not a fourth model: the proposals' mean
 * (geometric for a choice, in log-odds per option for a multi-select, the mean
 * for a number) moved back toward the start forecast by (1 − trust). Trust is
 * bounded to [0, 1], so the skeptic can only move the answer toward the prior,
 * never add extremity; for a number it may widen the spread, never narrow it.
 * Without an informative prior the proposals' mean stands (shrinking toward
 * uniform would only add to the hedging LLM forecasters already show) and
 * extremity is left to calibration. A failed role drops out; a failed skeptic
 * trusts half-way. Rankings and short strings have no start forecast: the two
 * proposals are combined like runs and the skeptic is not asked.
 *
 * With one configured model every role runs on it (the formation still works,
 * it is just less diverse). The research, lookups and cutoff are the ordinary
 * typed forecast's; the critique is replaced by the skeptic.
 */

import { picksFrom } from "./adjust";
import { type AnswerSpec, formatAnswer } from "./answer-types";
import { argmax, combinedSd, type Distribution, normalise } from "./distribution";
import {
  clampP,
  logit,
  meanLoss,
  poolDistribution,
  poolMarginals,
  round,
  sigmoid,
} from "./fitting";
import { answerGroup, informative, type ResolvedRecord, visibleRecords } from "./history";
import { askAnalyst } from "./judge";
import { type ChosenPrior, choosePrior, shrink } from "./prior";
import {
  answerInstruction,
  chooseCutoff,
  forecastTyped,
  type ModelPart,
  type TypedForecastAnswer,
  type TypedForecastDeps,
  type TypedForecastRequest,
} from "./typed";

export const STATISTICIAN_ROLE =
  "ROLE: you are the statistician on a forecasting crew. Reason from numbers: base rates, the latest published readings, the start forecast (when the notes give one), and how much such quantities usually change over this horizon. Move from the start forecast only for a concrete pattern in the data.";
export const ANALYST_ROLE =
  "ROLE: you are the analyst on a forecasting crew. Reason from the specifics: who and what decide the outcome, scheduled events before it resolves, what the sources say, and the lessons given. The start forecast (when the notes give one) is the default; move from it for specific, dated evidence.";

const MAX_SD_MOVE = 4;
const MAX_EVIDENCE = 10_000;

export interface SkepticRecord {
  roles: { statistician: string; analyst: string; skeptic?: string };
  /** The start forecast the crew moved from (source and detail). */
  start: { source: string; detail: string };
  proposals: Array<{ role: string; model: string; formatted?: string; error?: string }>;
  trust?: number;
  sdScale?: number;
  critique?: string;
  skepticError?: string;
  /** Why the skeptic was not asked (a ranking, a string, too few proposals). */
  note?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function skepticSystem(spec: AnswerSpec): string {
  return [
    "You are the skeptic on a forecasting crew. Most forecasters lose to a simple start forecast by moving too far from it on weak evidence.",
    "You see the start forecast, two proposals with their reasons, the research, and the forecaster's track record on resolved questions of this kind. Decide how much of the proposals' average move away from the start forecast the evidence justifies: trust 0 keeps the start forecast, 1 takes the full move. You cannot propose a move of your own.",
    "Forecast AS OF the evidence cutoff; nothing after it exists.",
    spec.type === "number"
      ? 'Reply with ONE JSON object: {"trust": <0..1>, "sd_scale": <1..2: how much to WIDEN the spread when the evidence is thin; never below 1>, "critique": "<one sentence>"}.'
      : 'Reply with ONE JSON object: {"trust": <0..1>, "critique": "<one sentence>"}.',
  ].join("\n");
}

/** A choice or multi-select asked with probabilities, so every proposal states them. */
function withProbabilities(spec: AnswerSpec): AnswerSpec {
  return spec.type === "choice" || spec.type === "multi" ? { ...spec, probabilities: true } : spec;
}

function describe(p: ChosenPrior | undefined): string {
  if (!p) return "none (no prior; a number moves from the proposals themselves)";
  const nums = p.distribution
    ? Object.entries(p.distribution)
        .map(([k, v]) => `${k}=${round(v, 3)}`)
        .join(" ")
    : `${p.value}${p.sd !== undefined ? ` ± ${round(p.sd, 4)}` : ""}`;
  return `${nums} — ${p.source}: ${p.detail}`;
}

/** The forecaster's own record in this group, before the cutoff (no question text). */
export function trackRecord(spec: AnswerSpec, visible: ResolvedRecord[]): string {
  const group = answerGroup(spec);
  const rs = visible.filter((r) => r.group === group);
  if (rs.length === 0) return "TRACK RECORD: none yet for questions of this kind.";
  const score = "brier" as const;
  const own = meanLoss(rs, (r) => r.raw, score);
  const withPrior = rs.filter((r) => r.prior);
  const prior = meanLoss(withPrior, (r) => r.prior!, score);
  const ownOnPrior = meanLoss(withPrior, (r) => r.raw, score);
  const metric = spec.type === "number" ? "CRPS" : "Brier";
  const parts = [
    `TRACK RECORD (${rs.length} resolved questions of this kind, all before the cutoff): mean ${metric} ${round(own.loss, 3)} (lower is better)`,
  ];
  if (prior.n >= 5) {
    parts.push(
      `on the ${prior.n} that had a start forecast: forecaster ${round(ownOnPrior.loss, 3)} vs start forecast ${round(prior.loss, 3)}`,
    );
  }
  return `${parts.join("; ")}.`;
}

export async function skepticCrew(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
): Promise<TypedForecastAnswer & { crew: SkepticRecord }> {
  const spec = req.answer;
  const n = deps.analysts.length;
  const statistician = deps.analysts[0];
  const analyst = deps.analysts[1 % Math.max(1, n)] ?? statistician;
  const skeptic: ModelPart | undefined =
    deps.critic ?? deps.analysts[2 % Math.max(1, n)] ?? statistician;
  const cutoff = chooseCutoff(req, deps.now?.() ?? new Date()).at;
  let history: ResolvedRecord[] = [];
  try {
    history = visibleRecords((await deps.adjust?.history?.all()) ?? [], cutoff, req.id);
  } catch {
    // allow-empty-catch: an unreadable history leaves the crew with no base rate or track record
  }
  // The start forecast known before research (a supplied prior, a base rate)
  // goes into the notes every member reads.
  const before = choosePrior({
    spec,
    cutoff,
    ...(req.priors ? { supplied: req.priors } : {}),
    history,
    ...(req.category ? { category: req.category } : {}),
  }).prior;
  const startNote =
    before && before.source !== "type-default"
      ? `START FORECAST (the crew's default; move from it only for specific evidence): ${describe(before)}`
      : "";
  const research: string[] = [];
  const first = await forecastTyped(
    {
      ...req,
      answer: withProbabilities(spec),
      ...(startNote ? { context: [req.context, startNote].filter(Boolean).join("\n\n") } : {}),
    },
    {
      ...deps,
      analysts: statistician && analyst ? [statistician, analyst] : deps.analysts,
      retriever: async (brief) => {
        const r = await deps.retriever(brief);
        research.push(r.report);
        return r;
      },
      options: {
        ...deps.options,
        runs: 2,
        critique: false,
        roles: [STATISTICIAN_ROLE, ANALYST_ROLE],
      },
    },
  );
  const out = { ...first, answer: spec } as TypedForecastAnswer & { crew: SkepticRecord };
  // A choice/multi asked without probabilities still carries the crew's (it reasons in them).
  const start = choosePrior({
    spec,
    cutoff: first.cutoff.at,
    ...(req.priors ? { supplied: req.priors } : {}),
    ...(first.lookups ? { lookups: first.lookups } : {}),
    ...(first.anchor ? { anchor: first.anchor } : {}),
    history,
    ...(req.category ? { category: req.category } : {}),
  }).prior;
  const roleNames = ["statistician", "analyst"];
  const crew: SkepticRecord = {
    roles: {
      statistician: statistician?.name ?? "",
      analyst: analyst?.name ?? "",
      ...(skeptic ? { skeptic: skeptic.name } : {}),
    },
    start: start ? { source: start.source, detail: start.detail } : { source: "none", detail: "" },
    proposals: first.runs.map((r, i) => ({
      role: roleNames[i] ?? `run ${r.run}`,
      model: r.model,
      ...(r.formatted !== undefined ? { formatted: r.formatted } : {}),
      ...(r.status !== "ok" ? { error: r.status.slice(0, 120) } : {}),
    })),
  };
  out.crew = crew;
  const usable = first.runs.filter((r) => r.weight > 0 && r.value !== undefined);
  if (usable.length === 0) {
    crew.note = "no usable proposal";
    return out;
  }
  if (spec.type === "ranking" || spec.type === "text") {
    crew.note = `the skeptic has no start forecast to shrink toward for a ${spec.type}; the proposals are combined like runs`;
    return out;
  }
  // Numbers: a proposal implausibly far from the start forecast is a blowup, as in the arena.
  let proposals = usable;
  if (
    spec.type === "number" &&
    start?.value !== undefined &&
    start.sd !== undefined &&
    start.sd > 0
  ) {
    proposals = usable.filter(
      (r) => Math.abs((r.value as number) - start.value!) <= MAX_SD_MOVE * start.sd!,
    );
    if (proposals.length === 0) {
      crew.note = `every proposal moved more than ${MAX_SD_MOVE} sd from the start forecast; the start forecast stands`;
      setNumber(out, spec, start.value, start.sd);
      return out;
    }
  }

  // ── The skeptic ─────────────────────────────────────────────────────────
  let trust = 0.5;
  let sdScale = 1;
  if (skeptic) {
    const user = [
      `Question: ${req.question}`,
      req.context ? `Notes: ${clip(req.context, 3_000)}` : "",
      `Evidence cutoff: ${first.cutoff.at}`,
      `Answer format: ${answerInstruction(spec).split("\n")[0]}`,
      `START FORECAST: ${describe(start)}`,
      ...proposals.map(
        (r, i) =>
          `PROPOSAL ${i + 1} (${crew.proposals.find((p) => p.model === r.model)?.role ?? "member"}): ${r.formatted}${
            r.distribution
              ? ` — probabilities ${Object.entries(r.distribution)
                  .map(([k, v]) => `${k}=${round(v, 3)}`)
                  .join(" ")}`
              : ""
          }${r.sd !== undefined ? ` ± ${r.sd}` : ""}\n  reason: ${clip(r.reason ?? "", 400)}`,
      ),
      trackRecord(spec, history),
      `RESEARCH:\n${clip(research.join("\n\n"), MAX_EVIDENCE) || "(none)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { reply, error } = await askAnalyst(skeptic, skepticSystem(spec), user);
    if (error !== undefined) crew.skepticError = error.slice(0, 160);
    const t = Number(reply?.trust);
    if (Number.isFinite(t)) trust = Math.min(1, Math.max(0, t));
    const s = Number(reply?.sd_scale);
    if (spec.type === "number" && Number.isFinite(s)) sdScale = Math.min(2, Math.max(1, s));
    if (typeof reply?.critique === "string") crew.critique = reply.critique.slice(0, 300);
  }
  crew.trust = round(trust, 3);
  if (spec.type === "number") crew.sdScale = round(sdScale, 3);

  // ── Deterministic aggregation ───────────────────────────────────────────
  if (spec.type === "number") {
    const values = proposals.map((r) => r.value as number);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sds = proposals.filter((r) => r.sd !== undefined).map((r) => r.sd!);
    const meanSd = sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : undefined;
    if (start?.value !== undefined) {
      const moved = shrink(
        "number",
        { value: mean, ...(meanSd !== undefined ? { sd: meanSd } : {}) },
        start,
        1 - trust,
      );
      const floor = start.sd !== undefined ? 0.5 * start.sd : 0;
      const sd = moved.sd !== undefined ? Math.max(floor, moved.sd) * sdScale : undefined;
      setNumber(out, spec, moved.value!, sd);
    } else {
      const spread = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
      const sd = combinedSd(
        proposals.map((r) => ({ ...(r.sd !== undefined ? { sd: r.sd } : {}), weight: 1 })),
        spread,
      );
      setNumber(out, spec, mean, sd !== undefined ? sd * sdScale : undefined);
    }
    return out;
  }
  const dists = proposals.map((r) => r.distribution).filter((d): d is Distribution => !!d);
  if (dists.length === 0) {
    crew.note = "no proposal stated probabilities";
    return out;
  }
  const ids = spec.options.map((o) => o.id);
  // The skeptic shrinks only toward an informative prior. Toward the uniform
  // default it would add to the hedging LLM forecasters already show; without
  // one the proposals' log-odds mean stands and extremity is calibration's job.
  const shrinkable = informative(start?.source) && !!start?.distribution;
  if (!shrinkable) crew.note = "no informative prior: the proposals' log-odds mean, unshrunk";
  if (spec.type === "choice") {
    const mean: Distribution = {};
    for (const k of ids) {
      mean[k] = Math.exp(dists.reduce((s, d) => s + Math.log(clampP(d[k] ?? 0)), 0) / dists.length);
    }
    const m = normalise(mean) ?? dists[0]!;
    const final = shrinkable ? poolDistribution(m, start!.distribution!, 1 - trust) : m;
    const top = argmax(spec.options, final);
    out.distribution = final;
    out.prediction = top;
    out.formatted = top;
    out.confidence = final[top];
    return out;
  }
  const mean: Distribution = {};
  for (const k of ids) {
    mean[k] = round(
      clampP(sigmoid(dists.reduce((s, d) => s + logit(d[k] ?? 0.5), 0) / dists.length)),
    );
  }
  const final = shrinkable ? poolMarginals(mean, start!.distribution!, 1 - trust) : mean;
  const picks = picksFrom(spec, final);
  out.distribution = final;
  out.prediction = picks;
  out.formatted = formatAnswer(picks);
  return out;
}

function setNumber(
  out: TypedForecastAnswer,
  spec: Extract<AnswerSpec, { type: "number" }>,
  value: number,
  sd: number | undefined,
): void {
  const v = spec.integer ? Math.round(value) : round(value, 6);
  out.prediction = v;
  out.formatted = formatAnswer(v);
  if (sd !== undefined && sd > 0) out.uncertainty = { sd: round(sd, 6) };
}
