// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Proposition features: what routing needs to know about a question before it
 * picks a method — mechanical facts first, then, optionally, two cheap
 * judgements from the decisions primitive (`src/decisions`):
 *
 *   mechanical   answer type and calibration group, the asker's category and
 *                board, the horizon from the evidence cutoff to the close,
 *                whether the question has a close at all, supplied priors
 *   decisions    `choice` over a small domain taxonomy and `noul` "is a
 *                discrete scheduled event inside the horizon?" — numbers and
 *                fixed labels only; the backend sees the question text
 *                (masked: emails and secrets removed, clipped) and the answer
 *                type, which the forecast already sends to its own models,
 *                never the asker's context, priors or identity
 *
 * `MARINA_FORECAST_FEATURES`: `auto` (default — the decisions judgements when a
 * decision backend is configured, else mechanical only), `on`, `observe`
 * (asked and recorded, but the class key stays mechanical) or `off`. Any
 * failure — no backend, timeout, spend cap — falls open to the mechanical
 * features; the judgement's receipt (numbers, no text) goes on the answer.
 *
 * The class chain is what evidence is read for, most specific first:
 * `board:<b>`, `category:<c>`, `domain:<d>/<group>` (decisions on), then the
 * calibration group `group:<g>` — the class routing has always fallen back to.
 */

import { type AdvisoryOptions, askAdvisory } from "../decisions/advisory";
import { harnessDecisionProvider } from "../decisions/engines";
import { maskSensitiveText } from "../decisions/gate";
import { choice, noul } from "../decisions/questions";
import type { DecisionProvider } from "../decisions/types";
import type { DecisionReceipt } from "../sdk/decision-receipt";
import type { AnswerType } from "./answer-types";
import { answerGroup } from "./history";
import { chooseCutoff, type TypedForecastRequest } from "./typed";

/** Domains a question is classified into (fixed labels; `other` when none fits). */
export const DOMAIN_TAXONOMY = {
  politics: "elections, polls, legislation, government action, officials",
  economy: "macro data, inflation, jobs, central banks, consumer sentiment",
  markets: "prices of assets, companies, earnings, crypto",
  geopolitics: "wars, diplomacy, international relations, sanctions",
  "science-tech": "science, technology, AI, space, product launches",
  health: "medicine, disease, public health, drug approvals",
  sports: "games, matches, tournaments, athletes",
  culture: "entertainment, media, awards, attention and popularity",
  "weather-climate": "weather events, climate measurements, natural disasters",
  other: "none of the above",
} as const;

export type Domain = keyof typeof DOMAIN_TAXONOMY;

export type FeatureMode = "auto" | "on" | "observe" | "off";

export function featureModeFromEnv(env: NodeJS.ProcessEnv = process.env): FeatureMode {
  const m = env.MARINA_FORECAST_FEATURES?.trim().toLowerCase();
  return m === "on" || m === "observe" || m === "off" ? m : "auto";
}

export interface PropositionFeatures {
  answerType: AnswerType;
  /** Calibration group (`answerGroup`). */
  group: string;
  category?: string;
  board?: string;
  /** Days from the evidence cutoff to the close (undefined without a close). */
  horizonDays?: number;
  /** The question names when it closes. */
  closes: boolean;
  /** Priors the asker supplied (market, community, statistical). */
  suppliedPriors: number;
  /** Decisions: the question's domain. */
  domain?: Domain;
  /** Decisions: probability a discrete scheduled event falls inside the horizon. */
  scheduledEvent?: number;
  /** Where the features came from. */
  source: "mechanical" | "mechanical+decisions";
  /** The decisions judgement's receipt (numbers and fixed labels only). */
  receipt?: DecisionReceipt;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** The class key for a free label (lowercase, safe characters, bounded). */
export function classLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Mechanical features: no model call, deterministic. */
export function mechanicalFeatures(
  req: TypedForecastRequest,
  opts: { board?: string; now?: Date } = {},
): PropositionFeatures {
  const now = opts.now ?? new Date();
  const cutoff = Date.parse(chooseCutoff(req, now).at);
  const end = req.endTime ? Date.parse(req.endTime) : Number.NaN;
  const category = req.category?.trim() ? classLabel(req.category) : "";
  const board = opts.board?.trim() ? classLabel(opts.board) : "";
  return {
    answerType: req.answer.type,
    group: answerGroup(req.answer),
    ...(category ? { category } : {}),
    ...(board ? { board } : {}),
    ...(Number.isFinite(end) && Number.isFinite(cutoff)
      ? { horizonDays: round(Math.max(0, (end - cutoff) / 86_400_000)) }
      : {}),
    closes: Number.isFinite(end),
    suppliedPriors: req.priors?.length ?? 0,
    source: "mechanical",
  };
}

const QUESTIONS = {
  domain: choice(
    "Which domain is this forecasting question about? Classify the subject only; do not forecast it.",
    { ...DOMAIN_TAXONOMY },
  ),
  scheduled_event: noul(
    "Does a discrete, scheduled event that could settle or strongly move this question (an election, data release, meeting, launch, match, ruling) fall before the question closes?",
    {
      true: "A specific scheduled event inside the horizon could settle or move it.",
      false: "No such scheduled event; the answer drifts with ongoing conditions.",
    },
  ),
};

/**
 * Mechanical features, plus the decisions judgements when the mode and a
 * backend allow. Never throws; never blocks longer than the advisory deadline.
 */
export async function featurise(
  req: TypedForecastRequest,
  opts: {
    board?: string;
    now?: Date;
    env?: NodeJS.ProcessEnv;
    mode?: FeatureMode;
    /** Explicit backends (tests, standalone callers); default: the configured harness backend. */
    providers?: readonly DecisionProvider[];
    advisory?: Omit<AdvisoryOptions, "providers" | "env">;
  } = {},
): Promise<PropositionFeatures> {
  const base = mechanicalFeatures(req, opts);
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? featureModeFromEnv(env);
  if (mode === "off") return base;
  let providers = opts.providers;
  if (!providers) {
    let configured: DecisionProvider | undefined;
    try {
      configured = harnessDecisionProvider(env);
    } catch {
      configured = undefined;
    }
    // `auto` asks only a configured backend; `on`/`observe` likewise never fall
    // back to a self-hosted classifier this process may not be serving.
    providers = configured ? [configured] : [];
  }
  if (providers.length === 0) return base;
  const { receipt, result } = await askAdvisory(
    "routing",
    mode === "observe" ? "observe" : "on",
    {
      state: {
        question: maskSensitiveText(req.question, 600),
        answer_type: req.answer.type,
        ...(base.horizonDays !== undefined ? { horizon_days: base.horizonDays } : {}),
      },
      questions: QUESTIONS,
    },
    { ...opts.advisory, env, providers },
  );
  const answers = result?.answers;
  const d = answers?.domain;
  const e = answers?.scheduled_event;
  const domain =
    d?.type === "choice" && Object.hasOwn(DOMAIN_TAXONOMY, d.choice)
      ? (d.choice as Domain)
      : undefined;
  const scheduledEvent = e?.type === "noul" && Number.isFinite(e.noul) ? round(e.noul) : undefined;
  receipt.applied = mode !== "observe" && domain !== undefined;
  receipt.action = receipt.applied ? "class" : "baseline";
  return {
    ...base,
    ...(domain ? { domain } : {}),
    ...(scheduledEvent !== undefined ? { scheduledEvent } : {}),
    ...(domain || scheduledEvent !== undefined ? { source: "mechanical+decisions" as const } : {}),
    receipt,
  };
}

/**
 * The classes evidence is read for, most specific first. A domain enters the
 * chain only when the judgement was applied (`on`/`auto`, not `observe`).
 */
export function classChain(f: PropositionFeatures): string[] {
  const chain: string[] = [];
  if (f.board) chain.push(`board:${f.board}`);
  if (f.category) chain.push(`category:${f.category}`);
  if (f.domain && f.receipt?.applied) chain.push(`domain:${f.domain}/${f.group}`);
  chain.push(`group:${f.group}`);
  return chain;
}
