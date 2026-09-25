// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecast any question — the arena's research pipeline, generalised.
 *
 *   question → retrieve (search-grounded, dated, cited)
 *            → verify citations mechanically (figures looked up in the cited pages)
 *            → analysts, one per vendor, each answer + rationale
 *            → judge (Jev when configured) scores each rationale's grounding in
 *              the VERIFIED facts; ungrounded ⇒ no weight
 *            → aggregate: judge-weighted, in log-odds for probabilities
 *
 * Two answer kinds: `probability` (will X happen?) and `number` (how much?).
 * Every stage's output is returned, so an answer can be audited — sources,
 * which lines verified, what each analyst said, how the judge weighted them,
 * and what it cost. Pure orchestration over injected parts; `service.ts`
 * wires the real retriever, models and judge.
 */

import { parseReply } from "../arena/model-forecaster";
import type { ResearchReport, Retriever } from "../arena/research/retrieve";
import { type PageText, verifyDossier } from "../arena/research/verify";
import type { Evidence } from "../decisions/evidence";
import type { DecisionProvider } from "../decisions/types";
import { checkDraft } from "../decisions/verify";

export type ForecastKind = "probability" | "number";

export interface ForecastRequest {
  question: string;
  /** Default: inferred — a yes/no question asks for a probability. */
  kind?: ForecastKind;
  /** ISO date by which the question resolves, if the question does not say. */
  resolveBy?: string;
  unit?: string;
}

export interface AnalystAnswer {
  name: string;
  probability?: number;
  mean?: number;
  sd?: number;
  reason?: string;
  grounded?: number;
  quality?: number;
  weight: number;
  status: string;
}

export interface ForecastAnswer {
  question: string;
  kind: ForecastKind;
  probability?: number;
  mean?: number;
  sd?: number;
  /** 10th–90th percentile for a number forecast. */
  interval?: [number, number];
  analysts: AnalystAnswer[];
  sources: Array<{ url: string; title?: string }>;
  verification?: Record<string, number>;
  report: string;
  costUsd: number;
  latencyMs: number;
  /** Why the answer is unavailable or weak, when it is. */
  caveat?: string;
}

export interface ForecastDeps {
  retriever: Retriever;
  analysts: Array<{ name: string; complete: (system: string, user: string) => Promise<string> }>;
  judge?: DecisionProvider;
  pageText?: PageText;
  now?: () => Date;
}

const YES_NO = /^\s*(will|is|are|does|do|did|has|have|can|could|should|would|was|were)\b/i;

export function inferKind(question: string): ForecastKind {
  return YES_NO.test(question) ? "probability" : "number";
}

function researchRequest(req: ForecastRequest, today: string): string {
  return [
    `A forecaster must answer: ${req.question}`,
    req.resolveBy ? `It resolves by ${req.resolveBy}.` : "",
    `Today is ${today}. Report the most recent dated facts relevant to the answer:`,
    "1. The current state of whatever the question is about, with the latest numbers.",
    "2. Base rates: how often things like this have happened, or the usual range of this quantity.",
    "3. Scheduled events and recent news before the resolution date that could change the outcome.",
    "4. What forecasters, markets or experts currently expect, with their numbers.",
    "Rules: every fact needs its date and source; numbers exactly as published; say when you found nothing; do not forecast yourself.",
  ]
    .filter(Boolean)
    .join("\n");
}

const ANALYST_SYSTEM: Record<ForecastKind, string> = {
  probability: [
    "You are a careful, calibrated forecaster. Given a question and a research dossier of dated, sourced facts,",
    "estimate the probability the answer is YES. Start from the base rate, adjust for the specific evidence, and avoid",
    "certainty you have not earned: 0.02 and 0.98 are strong claims. Rely on [verified] lines; treat [unverified] figures as suspect.",
    'Reply with ONE JSON object: {"probability": number between 0 and 1, "reason": "<two sentences citing the facts that moved you>"}.',
  ].join(" "),
  number: [
    "You are a careful, calibrated forecaster. Given a question and a research dossier of dated, sourced facts,",
    "forecast the quantity as a normal distribution. Anchor on the latest published value or base rate, then adjust;",
    "size sd honestly. Rely on [verified] lines; treat [unverified] figures as suspect.",
    'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "reason": "<two sentences citing the facts that moved you>"}.',
  ].join(" "),
};

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export async function forecastQuestion(
  req: ForecastRequest,
  deps: ForecastDeps,
): Promise<ForecastAnswer> {
  const started = Date.now();
  const kind = req.kind ?? inferKind(req.question);
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const empty = (caveat: string, research?: ResearchReport): ForecastAnswer => ({
    question: req.question,
    kind,
    analysts: [],
    sources: research?.sources ?? [],
    report: research?.report ?? "",
    costUsd: research?.costUsd ?? 0,
    latencyMs: Date.now() - started,
    caveat,
  });

  let research: ResearchReport;
  try {
    research = await deps.retriever({
      roundId: "question",
      since: today,
      request: researchRequest(req, today),
    });
  } catch (err) {
    return empty(`research failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = deps.pageText ? await verifyDossier(research.report, deps.pageText) : undefined;
  const dossier = checked ? checked.annotated : research.report;
  const user = [
    `Question: ${req.question}`,
    req.resolveBy ? `Resolves by: ${req.resolveBy}` : "",
    req.unit ? `Unit: ${req.unit}` : "",
    `Today: ${today}`,
    "",
    `RESEARCH DOSSIER${checked ? " (each cited line tagged by a mechanical check of its figures against the cited page)" : ""}:`,
    dossier,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const evidence: Evidence[] = [];
  const verifiedText = checked ? checked.verifiedText : research.report;
  for (let i = 0; i < verifiedText.length && evidence.length < 4; i += 1_400) {
    evidence.push({
      ref: `dossier:${evidence.length + 1}`,
      text: verifiedText.slice(i, i + 1_400),
    });
  }

  const analysts = await Promise.all(
    deps.analysts.map(async (a): Promise<AnalystAnswer> => {
      let reply: Record<string, unknown> | undefined;
      try {
        reply = parseReply(await a.complete(ANALYST_SYSTEM[kind], user));
      } catch (err) {
        return {
          name: a.name,
          weight: 0,
          status: `error: ${(err as Error).message.slice(0, 100)}`,
        };
      }
      const reason = typeof reply?.reason === "string" ? reply.reason.slice(0, 500) : undefined;
      const answer: AnalystAnswer = {
        name: a.name,
        weight: 1,
        status: "ok",
        ...(reason ? { reason } : {}),
      };
      if (kind === "probability") {
        const p = Number(reply?.probability);
        if (!Number.isFinite(p) || p < 0 || p > 1)
          return { ...answer, weight: 0, status: "invalid reply" };
        answer.probability = Math.min(Math.max(p, 0.01), 0.99);
      } else {
        const mean = Number(reply?.mean);
        const sd = Number(reply?.sd);
        if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
          return { ...answer, weight: 0, status: "invalid reply" };
        }
        answer.mean = mean;
        answer.sd = sd;
      }
      if (deps.judge && evidence.length) {
        const claim =
          kind === "probability"
            ? `P(yes) = ${answer.probability}. ${reason ?? ""}`
            : `Forecast ${answer.mean} ± ${answer.sd}. ${reason ?? ""}`;
        const v = await checkDraft(deps.judge, claim.slice(0, 3_000), evidence, req.question);
        if (!v.error) {
          answer.grounded = v.signals.grounded;
          answer.quality = v.signals.quality;
          // A floor keeps one weak-but-valid analyst from being erased when the
          // dossier verified little; ungrounded answers still count for little.
          answer.weight = Math.max(
            0.05,
            (v.signals.grounded ?? 0) * ((v.signals.quality ?? 0) / 2),
          );
        }
      }
      return answer;
    }),
  );

  const usable = analysts.filter((a) => a.weight > 0);
  const base = {
    ...empty("", research),
    analysts,
    ...(checked ? { verification: checked.stats } : {}),
  };
  delete base.caveat;
  if (usable.length === 0) return { ...base, caveat: "no analyst produced a usable answer" };
  const total = usable.reduce((s, a) => s + a.weight, 0);
  const lowGrounding = deps.judge && usable.every((a) => (a.grounded ?? 0) < 0.3);
  const caveat = lowGrounding
    ? "the judge found little verified evidence behind every answer"
    : undefined;
  if (kind === "probability") {
    const x = usable.reduce((s, a) => s + a.weight * logit(a.probability!), 0) / total;
    return {
      ...base,
      probability: Math.round(sigmoid(x) * 1000) / 1000,
      ...(caveat ? { caveat } : {}),
    };
  }
  const mean = usable.reduce((s, a) => s + a.weight * a.mean!, 0) / total;
  // Between-analyst disagreement widens the spread, as it should.
  const within = usable.reduce((s, a) => s + a.weight * a.sd! * a.sd!, 0) / total;
  const between = usable.reduce((s, a) => s + a.weight * (a.mean! - mean) ** 2, 0) / total;
  const sd = Math.sqrt(within + between);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    ...base,
    mean: r(mean),
    sd: r(sd),
    interval: [r(mean - 1.2816 * sd), r(mean + 1.2816 * sd)],
    ...(caveat ? { caveat } : {}),
  };
}
