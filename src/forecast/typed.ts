// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecast any question with a TYPED answer — one option, a set of options, a
 * number, a ranked list or a short string (src/forecast/answer-types.ts).
 *
 *   plan       decompose the question: what resolves it, the key quantities,
 *              the search queries, what would change the answer
 *   research   bounded rounds of search (the forecast retriever); after each,
 *              the planner names what is still missing, or stops
 *   lookups    optional structured sources (market prices, sports odds, official
 *              series), opt-in, steered by the plan's `data` hints; a number
 *              is anchored on the freshest official reading with a spread
 *              from that series' own changes over the question's horizon
 *   verify     cited figures (and quoted passages) checked mechanically against
 *              the cited pages; the dossier is sized to the analysts' context
 *              window and, when it must be cut, keeps verified lines first
 *   runs       K independent answers (analyst models used round-robin), each
 *              weighted by the judge's grounding score when a judge is set
 *   combine    by type: plurality / per-option frequency / median / Borda;
 *              agreement between the runs is the confidence
 *   follow-up  when no run is grounded in verified evidence, ONE more research
 *              round on the gaps the runs and the judge leave; the runs are
 *              redone only if it verified something new (the first runs stay in
 *              `initialRuns`)
 *   critique   a disconfirmation pass searches for evidence AGAINST the leading
 *              answer; the critic may revise it only when its own confidence
 *              exceeds the runs' agreement
 *
 * A research outage (every round failed) does not stop the forecast: the runs
 * answer from the question and its notes, and the answer says so.
 *
 * Evidence is frozen at a cutoff: the request's `asOf`, else the earlier of now
 * and the question's `endTime`. Retrieval is asked for nothing after it (engines
 * that filter by date drop later results), lookups read values as of the
 * cutoff or, when they only know current values, are skipped for a past
 * cutoff, and the cutoff is recorded.
 *
 * Every stage is returned — the answer object is the audit trail. Pure
 * orchestration over injected parts; `service.ts` wires the real ones.
 */

import { type BudgetForced, budgetPhase } from "../agent/budget-terminal";
import type { ResearchReport, RetrievalFunnel, Retriever } from "../arena/research/retrieve";
import { type PageText, verifyDossier } from "../arena/research/verify";
import type { Evidence } from "../decisions/evidence";
import type { DecisionProvider } from "../decisions/types";
import { maxToolResultTokensForWindow } from "../engine/constants";
import {
  extractJsonValue,
  groundedIn,
  type Repaired,
  type RepairLabel,
  repairOutput,
} from "../repair/output-repair";
import type { AdjustmentRecord, AdjustSettings } from "./adjust";
import {
  type AnswerOption,
  type AnswerSpec,
  type AnswerValue,
  type CombinedAnswer,
  combineAnswers,
  formatAnswer,
  type SelectionMode,
  validateAnswer,
} from "./answer-types";
import {
  argmax,
  averageDistributions,
  averageMarginals,
  blendDistributions,
  blendMarginals,
  combinedSd,
  completeMarginals,
  type Distribution,
  logOddsDistributions,
  logOddsMarginals,
  type PoolMethod,
  parseDistribution,
  parseMarginals,
  pickDistribution,
} from "./distribution";
import { askAnalyst, type JudgeRecord, judgeAudit, judgeClaim, newJudgeRecord } from "./judge";
import type { LessonStore } from "./lessons";
import {
  anchorLine,
  type DataHints,
  type ForecastLookup,
  type LookupResult,
  type NumericAnchor,
  numericAnchor,
  runLookups,
} from "./lookups";
import type { SuppliedPrior } from "./prior";

export interface TypedForecastRequest {
  question: string;
  answer: AnswerSpec;
  /** ISO time the question closes. The answer uses nothing published after it. */
  endTime?: string;
  /** Freeze evidence at this ISO time instead (default: the earlier of now and endTime). */
  asOf?: string;
  /** Resolution rules, format notes or background the asker supplies. */
  context?: string;
  /**
   * A stable question id (a ledger item id, never text): a forecast never
   * learns from its own resolved record.
   */
  id?: string;
  /** The question's reference class, as the asker names it (base rates, calibration evidence). */
  category?: string;
  /**
   * Priors the asker already has — a market price, a community forecast — each
   * with the time it was observed. One observed after the cutoff is rejected.
   */
  priors?: SuppliedPrior[];
}

export interface TypedForecastOptions {
  /** Plan before researching (default true). */
  plan?: boolean;
  /** Research rounds, 1–4 (default 2). */
  researchRounds?: number;
  /** Independent answer runs, 1–9 (default 3). */
  runs?: number;
  /** Disconfirmation pass (default true). */
  critique?: boolean;
  /** How far back research looks before the cutoff, in days (default 45). */
  lookbackDays?: number;
  /**
   * Verify every run's draft with `deps.verifier` before it is combined — the
   * verification formation inside one forecast: an independent model checks
   * the draft against the dossier and the resolution rules and may correct it
   * (default false).
   */
  verify?: boolean;
  /**
   * Wall-clock budget for the whole forecast, in ms (budget-terminal
   * answering, `src/agent/budget-terminal.ts`). From about 75 % no further
   * research round starts; at the cap lookups, verification and the critique
   * are skipped and the answer is combined from the runs finished so far (the
   * first run to finish, when none has) — labelled `budgetForced`. Unset = no
   * time budget.
   */
  budgetMs?: number;
  /**
   * How the K runs become one answer (`answer-types.ts` `SelectionMode`):
   * `agreement` (default) combines by type with agreement as the confidence;
   * `confidence` takes the most self-confident run with its own confidence.
   */
  selection?: SelectionMode;
  /**
   * Characters of research dossier each run reads (default: sized to the
   * analysts' context windows — `dossierBudgetChars`).
   */
  dossierChars?: number;
  /**
   * When no run is grounded in verified evidence, one more research round on
   * the gaps the runs and the judge leave; the runs are redone only if it
   * verified something new (default true).
   */
  followUp?: boolean;
  /**
   * Verified dossier lines wanted before the runs; fewer triggers one more
   * research round (default 5; 0 = off). Shares the single extra round with
   * `followUp`.
   */
  minEvidenceLines?: number;
  /**
   * When the runs disagree (agreement below 0.7 — a 2–1 split), one research round on the
   * crux and one more run that reads it, pooled with the others (default true).
   */
  disagreementRound?: boolean;
  /**
   * How the runs' probabilities are averaged: `linear` (default) or `logodds`
   * (a geometric pool — confident, agreeing runs are not dragged toward uniform).
   */
  pool?: PoolMethod;
  /**
   * A role per run (run i gets role i mod n): an instruction added to that
   * run's system prompt — how a crew formation gives its members their parts.
   */
  roles?: string[];
  /**
   * When a run's answer has the right type but is incomplete — a ranking short
   * of its size, a multi-select short of its minimum, a probability missing for
   * some option, no answer at all — ONE more call to the same analyst names
   * exactly what is missing and shows it its own answer; the reply is used
   * only if it now validates, labelled `repaired:completion` (default true).
   * Skipped in the budget's final phase.
   */
  completion?: boolean;
}

export interface ModelPart {
  name: string;
  complete: (system: string, user: string) => Promise<string>;
  /** The model's context window in tokens, when known (sizes the dossier). */
  contextWindow?: number;
}

export interface TypedForecastDeps {
  retriever: Retriever;
  /** Models for the K runs, used round-robin. */
  analysts: ModelPart[];
  /** Plans and names research gaps (default: the first analyst). */
  planner?: ModelPart;
  /** The disconfirmation pass (default: the planner). */
  critic?: ModelPart;
  /** Checks each run's draft when `options.verify` (default: the critic). */
  verifier?: ModelPart;
  /**
   * Lessons from resolved questions. Only lessons whose outcome was known at
   * the evidence cutoff are recalled (`visibleAt`); the ones used are recorded.
   */
  lessons?: LessonStore;
  judge?: DecisionProvider;
  pageText?: PageText;
  lookups?: ForecastLookup[];
  now?: () => Date;
  options?: TypedForecastOptions;
  /**
   * Prior shrink and recalibration from resolved history (`./adjust.ts`),
   * applied once at the end of a formation (`forecastFormed`).
   */
  adjust?: AdjustSettings;
}

export interface ForecastPlan {
  restatement?: string;
  resolutionSource?: string;
  keyQuantities?: string[];
  queries: string[];
  whatWouldChange?: string[];
  /** Where structured lookups should look (markets, sports odds, official series). */
  data?: DataHints;
  error?: string;
}

export interface ResearchRound {
  evidence?: ResearchReport["evidence"];
  researchLoop?: ResearchReport["researchLoop"];
  round: number;
  queries: string[];
  sources: number;
  chars: number;
  costUsd: number;
  error?: string;
  /** What the planner said was still missing after this round. */
  missing?: string;
  /** Where evidence was found and lost in this round, per engine that reports it. */
  funnels?: RetrievalFunnel[];
  /** Engines that failed while others answered. */
  warnings?: string[];
  /** The follow-up round on the gaps left after the runs (`followUp`). */
  followUp?: boolean;
  /** Verified dossier lines this follow-up round added. */
  verifiedAdded?: number;
  /** Why an extra round ran: too little verified evidence, ungrounded runs, or disagreeing runs. */
  trigger?: "evidence" | "grounding" | "disagreement";
}

export interface TypedRun {
  run: number;
  model: string;
  value?: AnswerValue;
  formatted?: string;
  confidence?: number;
  /** Asked with `probabilities`: this run's probability per option. */
  distribution?: Distribution;
  /** A number: this run's stated uncertainty (sd, same unit). */
  sd?: number;
  reason?: string;
  weight: number;
  grounded?: number;
  quality?: number;
  judgeError?: string;
  status: string;
  /** The extra run made on the crux after the runs disagreed. */
  crux?: boolean;
  /**
   * The answer met its format only after output repair (`output-repair`), or
   * only after the completion call (`repaired:completion`).
   */
  repaired?: RepairLabel | "repaired:completion";
  /** The completion call (`options.completion`): what was missing, and whether its reply was used. */
  completion?: { missing: string; accepted: boolean; error?: string };
  /** The verifier's check of this draft (`options.verify`). */
  verified?: {
    model: string;
    /** `not_run`: the time budget was spent before the check (never a failed check). */
    verdict: "accept" | "correct" | "error" | "not_run";
    /** The draft before a correction replaced it. */
    draft?: string;
    reason?: string;
  };
}

export interface Critique {
  model: string;
  verdict: "keep" | "revise" | "error";
  /** The answer the critic proposed (present on revise). */
  proposed?: string;
  /** The critic's probability per option, when the question asks for probabilities. */
  distribution?: Distribution;
  confidence?: number;
  reason?: string;
  /** True when the revision replaced the runs' answer. */
  applied: boolean;
  counterEvidenceSources?: number;
  error?: string;
}

export interface TypedForecastAnswer {
  question: string;
  answer: AnswerSpec;
  /** The final typed value (absent when no run produced a usable answer). */
  prediction?: AnswerValue;
  /** `prediction` as one string (comma-separated lists, plain digits). */
  formatted?: string;
  /** 0–1: the runs' agreement, or the critic's confidence when it revised. */
  confidence?: number;
  /**
   * Asked with `probabilities`: the forecast probability of every option (the
   * runs' weighted average, blended with an applied critique). A choice's sum
   * to 1 and `prediction` is then the most probable option; a multi-select's
   * are each option's own probability of being true.
   */
  distribution?: Distribution;
  /** A number: the combined uncertainty — the runs' own sd and their spread, in quadrature. */
  uncertainty?: { sd: number };
  combined?: CombinedAnswer;
  runs: TypedRun[];
  plan?: ForecastPlan;
  research: ResearchRound[];
  lookups?: LookupResult[];
  /** Lessons recalled for this forecast (all resolved at or before the cutoff). */
  lessons?: Array<{ id?: string; text: string; resolvedAt: string }>;
  /** `MARINA_LESSONS=observe`: lessons that would have been injected, recorded only. */
  observedLessons?: Array<{ id?: string; text: string; resolvedAt: string }>;
  /** For a number: the freshest official reading the runs started from, and its horizon spread. */
  anchor?: NumericAnchor;
  critique?: Critique;
  /** The first runs, when a follow-up round added verified evidence and the runs were redone. */
  initialRuns?: TypedRun[];
  /** How much evidence the runs read: the budget, the dossier, the verified part. */
  evidence?: {
    budgetChars: number;
    dossierChars: number;
    verifiedLines: number;
    verifiedChars: number;
  };
  /** The evidence cutoff (ISO) and how it was chosen. */
  cutoff: { at: string; basis: "asOf" | "endTime" | "now"; pastCutoff: boolean };
  sources: Array<{ url: string; title?: string }>;
  verification?: Record<string, number>;
  judge?: JudgeRecord;
  costUsd: number;
  latencyMs: number;
  caveat?: string;
  /** With `options.budgetMs`: the budget, what was spent, and the stages it cut. */
  budget?: { capMs: number; usedMs: number; skipped: string[] };
  /** The answer was combined at the time budget from what had finished (labelled, never silent). */
  budgetForced?: BudgetForced;
  /** Prior shrink and recalibration (`./adjust.ts`): the raw forecast, the prior, the learned settings. */
  adjustment?: AdjustmentRecord;
}

const MAX_DOSSIER_CHARS = 24_000;

const clampInt = (v: number | undefined, lo: number, hi: number, d: number) =>
  v === undefined || !Number.isFinite(v) ? d : Math.min(hi, Math.max(lo, Math.round(v)));

/** How the answer must be given, per type — shared by runs and critic. */
export function answerInstruction(spec: AnswerSpec): string {
  switch (spec.type) {
    case "choice":
      return [
        "Pick exactly ONE option. Options:",
        ...spec.options.map((o) => `  ${o.id}${o.label ? ` — ${o.label}` : ""}`),
        `"answer" is the option id as a string, e.g. "${spec.options[0]!.id}".`,
        spec.probabilities ? probabilitiesInstruction(spec.options) : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "multi":
      return [
        `Pick EVERY option that will be true${spec.maxPicks ? ` (at most ${spec.maxPicks})` : ""}. Options:`,
        ...spec.options.map((o) => `  ${o.id}${o.label ? ` — ${o.label}` : ""}`),
        `"answer" is an array of option ids, e.g. ["${spec.options[0]!.id}"]${spec.minPicks === 0 ? " (or [] when none will be)" : ""}.`,
        spec.probabilities
          ? `Also give "probabilities": an object mapping EVERY option id to your probability (0..1) that THAT option is true — each judged on its own, they need not sum to 1. Calibrate: never 0 or 1.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "number":
      return [
        `"answer" is ONE number${spec.unit ? ` in ${spec.unit}` : ""}: your single most likely value, exactly as the resolution source will publish it — not a hedge between outcomes.`,
        `Write it at the source's own scale${spec.unit ? ` (${spec.unit})` : ""} — check thousands vs millions against the latest published reading — and keep its sign (negative for a fall or a downward revision).`,
        'Also give "sd", your uncertainty (> 0), in the same unit.',
        spec.integer ? "The answer is an integer." : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "ranking":
      return [
        `"answer" is an ordered array${spec.size ? ` of exactly ${spec.size} items` : ""}, first = top.`,
        spec.candidates?.length ? `Choose from: ${spec.candidates.join("; ")}.` : "",
        "Write each item exactly as the resolution source names it.",
      ]
        .filter(Boolean)
        .join("\n");
    case "text":
      return '"answer" is a short string, written exactly as the resolution source will write it.';
  }
}

function plannerSystem(): string {
  return [
    "You plan research for a forecaster. Do not forecast.",
    'Reply with ONE JSON object: {"restatement": "<the question in one precise sentence>",',
    '"resolutionSource": "<who or what publishes the answer, and when>",',
    '"keyQuantities": ["<the facts that decide it>"],',
    '"queries": ["<up to 8 short web search queries, most useful first, each a different angle: the named entities and their latest results; recent news; the resolution source by name; official data or schedules; base rates and past editions; what markets, polls or experts expect — in the local language too when the event is local>"],',
    '"whatWouldChange": ["<events or readings that would move the answer>"],',
    '"data": {"markets": "<a short prediction-market search phrase, or empty>",',
    '"sport": "<a The Odds API sport key such as basketball_nba or soccer_epl when this is a sports match, else empty>",',
    '"teams": ["<the competitors, as the sport names them>"],',
    '"fred": ["<FRED series ids when the answer is an official US statistic, e.g. UNRATE>"],',
    '"bls": ["<BLS series ids, e.g. CUUR0000SA0>"]}}.',
    "Leave a data field empty when it does not apply.",
  ].join(" ");
}

function gapSystem(): string {
  return [
    "You review a research dossier for a forecaster. Do not forecast.",
    'Reply with ONE JSON object: {"done": true|false, "missing": "<what decisive fact is still missing>",',
    '"queries": ["<up to 4 NEW short search queries that would find it>"]}. Say done when the dossier already holds the decisive facts.',
  ].join(" ");
}

/**
 * The forecast is MADE at the cutoff; the event happens later. Said plainly,
 * because a model otherwise reads "no result by the cutoff" as "no official
 * result" and picks that option for every future event.
 */
const TIMING =
  "You are forecasting AS OF the evidence cutoff: the event has not happened yet, and the question asks what WILL be true when it resolves. That the outcome is unknown at the cutoff is the point of forecasting, never a reason to answer that there will be no result.";

function runSystem(spec: AnswerSpec): string {
  return [
    "You are a careful forecaster. Given a question, how it resolves, and a research dossier of dated, sourced facts, predict the answer.",
    "Start from the latest published value or the base rate, then adjust for the specific evidence. Rely on [verified] lines; treat [unverified] figures as suspect.",
    "Use nothing dated after the stated cutoff.",
    TIMING,
    'Pick an option such as "no official result", "cancelled" or "not reported" only when you expect the event itself to be cancelled, postponed or unreported — rarely the case.',
    "With little specific evidence, predict the most likely outcome from base rates and priors (favourites, seasonality, the latest trend) — still a real forecast.",
    answerInstruction(spec),
    'Reply with ONE JSON object: {"answer": <as above>, "confidence": <0..1, how likely your answer is exactly right>,' +
      `${spec.type === "number" ? ' "sd": <number>,' : ""}${probabilistic(spec) ? ' "probabilities": {<option id>: <0..1>, …},' : ""} "reason": "<two sentences citing the facts that decided it>"}.`,
  ].join("\n");
}

function criticSystem(spec: AnswerSpec): string {
  return [
    "You are the forecaster's critic. Look for the strongest evidence that the leading answer is WRONG — a newer reading, a misread source, a rule that changes how it resolves.",
    TIMING,
    'Keep it unless the evidence clearly points elsewhere. Reply with ONE JSON object: {"verdict": "keep" | "revise",',
    '"answer": <only on revise, same format as below>, "confidence": <0..1 that YOUR verdict\'s answer is exactly right>, "reason": "<two sentences>"}.',
    "Answer format:",
    answerInstruction(spec),
  ].join("\n");
}

export async function forecastTyped(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
): Promise<TypedForecastAnswer> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date();
  const opts = deps.options ?? {};
  const rounds = clampInt(opts.researchRounds, 1, 4, 2);
  const k = clampInt(opts.runs, 1, 9, 3);
  const lookbackDays = clampInt(opts.lookbackDays, 1, 3650, 45);
  const planner = deps.planner ?? deps.analysts[0];
  const critic = deps.critic ?? planner;
  const verifier = deps.verifier ?? critic;
  // Budget-terminal answering: steer from ~75 % (no new research round), and
  // at the cap combine what has finished rather than return nothing.
  const budgetMs = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : undefined;
  const phase = () => (budgetMs ? budgetPhase(Date.now() - started, budgetMs) : "work");
  const skipped: string[] = [];
  let forced = false;
  const budget = dossierBudgetChars(
    deps.analysts.map((a) => a.contextWindow),
    opts.dossierChars,
  );

  const cutoff = chooseCutoff(req, now);
  const cutoffDay = cutoff.at.slice(0, 10);
  const since = new Date(Date.parse(cutoff.at) - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const out: TypedForecastAnswer = {
    question: req.question,
    answer: req.answer,
    runs: [],
    research: [],
    cutoff,
    sources: [],
    costUsd: 0,
    latencyMs: 0,
  };
  /** Caveats gathered on the way (a research outage, …), reported with the final one. */
  const earlier: string[] = [];
  const finish = (caveat?: string): TypedForecastAnswer => {
    out.latencyMs = Date.now() - started;
    if (budgetMs) {
      out.budget = { capMs: budgetMs, usedMs: out.latencyMs, skipped };
      if (forced && out.formatted !== undefined) {
        out.budgetForced = {
          reason: "time",
          used: out.latencyMs,
          cap: budgetMs,
          source: "runs-so-far",
        };
      }
    }
    const notes = [
      ...earlier,
      caveat,
      cutoff.pastCutoff
        ? "the cutoff is in the past: date-filtered engines honour it, others may still surface later pages"
        : undefined,
    ].filter(Boolean);
    if (notes.length) out.caveat = notes.join("; ");
    return out;
  };
  if (deps.analysts.length === 0 || !planner) return finish("no analyst models configured");

  // ── Lessons (only those whose outcome was known at the cutoff) ────────────
  if (deps.lessons) {
    try {
      const recalled = await deps.lessons.recall(`${req.question} ${req.answer.type}`, cutoff.at);
      const record = (l: (typeof recalled)[number]) => ({
        ...(l.id ? { id: l.id } : {}),
        text: l.text,
        resolvedAt: l.resolvedAt,
      });
      // Observe mode: recorded on the answer, never shown to a model.
      const observed = recalled.filter((l) => l.observed);
      out.lessons = recalled.filter((l) => !l.observed).map(record);
      if (observed.length) out.observedLessons = observed.map(record);
    } catch (err) {
      earlier.push(
        `lesson recall failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
      );
    }
  }

  const header = [
    `Question: ${req.question}`,
    req.context ? `How it resolves / notes:\n${req.context.slice(0, 4_000)}` : "",
    req.endTime ? `The question closes: ${req.endTime}` : "",
    `Forecast made as of: ${cutoff.at} (the evidence cutoff — use nothing published after it; the event itself happens later)`,
    out.lessons?.length
      ? `Lessons from earlier resolved questions (apply where relevant):\n${out.lessons.map((l) => `- ${l.text}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // ── Plan ──────────────────────────────────────────────────────────────────
  let plan: ForecastPlan = { queries: [] };
  if (opts.plan !== false) {
    const { reply, error } = await askAnalyst(planner, plannerSystem(), header);
    plan = parsePlan(reply);
    if (error !== undefined) plan.error = error.slice(0, 200);
    out.plan = plan;
  }
  if (plan.queries.length === 0) plan.queries = [req.question.slice(0, 200)];

  // ── Research rounds ───────────────────────────────────────────────────────
  const lines: string[] = [];
  const sources = new Map<string, { url: string; title?: string; text?: string }>();
  /** One research round through the retriever; its lines and sources join the dossier. */
  const settlement = settlementUrls(req, plan);
  const research = async (round: ResearchRound, request: string): Promise<void> => {
    const brief = {
      roundId: "forecast",
      since,
      until: cutoffDay,
      untilAt: cutoff.at,
      queries: round.queries,
      request,
      maxChars: Math.floor(budget / (rounds + 1)),
      // The question's named resolution source is read before anything else.
      ...(round.round === 1 && settlement.length ? { readFirst: settlement } : {}),
    };
    let report: ResearchReport | undefined;
    try {
      report = await deps.retriever(brief);
    } catch (err) {
      round.error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
    if (report) {
      round.costUsd = report.costUsd;
      if (report.evidence) round.evidence = report.evidence;
      if (report.researchLoop) round.researchLoop = report.researchLoop;
      round.chars = report.report.length;
      if (report.funnels?.length) round.funnels = report.funnels;
      if (report.warnings?.length) round.warnings = report.warnings.map((w) => w.slice(0, 200));
      for (const s of report.sources) {
        if (s.published && s.published.slice(0, 10) > cutoffDay) continue;
        if (!sources.has(s.url)) {
          sources.set(s.url, s);
          round.sources++;
        }
      }
      lines.push(...report.report.split("\n").filter((l) => l.trim()));
    }
    out.research.push(round);
  };
  let queries = researchQueries(plan);
  for (let r = 1; r <= rounds && queries.length; r++) {
    const round: ResearchRound = { round: r, queries, sources: 0, chars: 0, costUsd: 0 };
    await research(round, researchRequest(req, plan, queries, cutoffDay, r));
    if (r === rounds) break;
    if (phase() !== "work") {
      skipped.push(`research rounds ${r + 1}–${rounds}`);
      break;
    }
    const { reply } = await askAnalyst(
      planner,
      gapSystem(),
      `${header}\n\nDOSSIER SO FAR:\n${clip(lines.join("\n"), budget)}`,
    );
    const next = newQueries(reply?.queries, out.research, 4);
    if (typeof reply?.missing === "string") round.missing = reply.missing.slice(0, 300);
    if (reply?.done === true || next.length === 0) break;
    queries = next;
  }

  // ── Lookups ───────────────────────────────────────────────────────────────
  if (deps.lookups?.length && phase() === "final") {
    skipped.push("lookups");
    forced = true;
  } else if (deps.lookups?.length) {
    out.lookups = await runLookups(
      deps.lookups,
      plan.restatement ?? req.question,
      new Date(cutoff.at),
      now,
      {
        ...(plan.data ? { hints: plan.data } : {}),
        answerType: req.answer.type,
        ...(req.endTime ? { endTime: req.endTime } : {}),
      },
    );
    for (const l of out.lookups) {
      lines.push(...l.lines);
      for (const s of l.sources) if (!sources.has(s.url)) sources.set(s.url, s);
    }
    // A number starts from the freshest official reading, with the spread of
    // that series' own changes over the question's horizon.
    if (req.answer.type === "number") {
      const readings = out.lookups.flatMap((l) => l.readings ?? []);
      const anchor = numericAnchor(readings, new Date(cutoff.at), req.endTime);
      if (anchor) {
        out.anchor = anchor;
        lines.push(anchorLine(anchor));
      }
    }
  }
  // A research outage is not a reason to give up: the runs still answer from
  // the question, its resolution notes and what the models know — with a caveat.
  const researchDown = lines.length === 0 && out.research.every((r) => r.error);
  if (researchDown) {
    earlier.push(
      `research failed, so the runs answered without a dossier: ${out.research[0]?.error ?? "no result"}`,
    );
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  /** The dossier as the runs see it, and the verified evidence the judge reads. */
  const assemble = async () => {
    const report = lines.join("\n");
    const checked = deps.pageText
      ? await verifyDossier(report, deps.pageText, [...sources.values()])
      : undefined;
    const dossier = budgetDossier(checked ? checked.annotated : report, budget);
    const verifiedText = checked ? checked.verifiedText : report;
    const evidence: Evidence[] = [];
    const maxChunks = Math.max(4, Math.min(12, Math.floor(budget / 4 / EVIDENCE_CHUNK)));
    for (let i = 0; i < verifiedText.length && evidence.length < maxChunks; i += EVIDENCE_CHUNK) {
      evidence.push({
        ref: `dossier:${evidence.length + 1}`,
        text: verifiedText.slice(i, i + EVIDENCE_CHUNK),
      });
    }
    const user = `${header}\n\nRESEARCH DOSSIER${checked ? " (cited lines tagged by a mechanical check against the cited page)" : ""}:\n${dossier || (researchDown ? "(research unavailable — answer from the question, its notes and what you know as of the cutoff)" : "(nothing found)")}`;
    return { checked, dossier, evidence, verifiedChars: verifiedText.length, user };
  };
  let assembled = await assemble();
  /** One extra research round per forecast, at most: for missing evidence or for the gaps. */
  let extraRound = false;
  const minEvidence = clampInt(opts.minEvidenceLines, 0, 50, MIN_EVIDENCE_LINES);
  if (
    opts.followUp !== false &&
    !researchDown &&
    phase() === "work" &&
    assembled.checked !== undefined &&
    assembled.checked.stats.verified < minEvidence
  ) {
    // Too little verified evidence to answer from: search again before the runs.
    extraRound = true;
    const { reply } = await askAnalyst(
      planner,
      gapSystem(),
      `${header}\n\nOnly ${assembled.checked.stats.verified} dossier line(s) could be verified against their cited pages; find the decisive facts where they are published.\n\nDOSSIER SO FAR:\n${clip(assembled.dossier, Math.min(budget, 12_000))}`,
    );
    const next = newQueries(reply?.queries, out.research, 4);
    if (next.length > 0) {
      const round: ResearchRound = {
        round: out.research.length + 1,
        queries: next,
        sources: 0,
        chars: 0,
        costUsd: 0,
        followUp: true,
        trigger: "evidence",
        ...(typeof reply?.missing === "string" ? { missing: reply.missing.slice(0, 300) } : {}),
      };
      const before = assembled.checked.stats.verified;
      await research(round, researchRequest(req, plan, next, cutoffDay, round.round));
      assembled = await assemble();
      round.verifiedAdded = Math.max(0, (assembled.checked?.stats.verified ?? 0) - before);
    }
  }
  const judgeRecord = newJudgeRecord(deps.judge);
  /** Budget-terminal answering inside the runs: an unchecked draft at the cap, unfinished runs dropped. */
  const runBudget: RunBudget = {
    phase,
    ...(budgetMs ? { deadline: started + budgetMs } : {}),
    spent: (what) => {
      if (!skipped.includes(what)) skipped.push(what);
      forced = true;
    },
  };
  const runAll = (a: typeof assembled) =>
    runIndependent(
      req,
      deps,
      opts,
      k,
      verifier,
      a.user,
      a.evidence.length ? deps.judge : undefined,
      a.evidence,
      judgeRecord,
      runBudget,
    );
  out.runs = await runAll(assembled);

  // ── Follow-up: one bounded round on the gaps the runs and judge leave ─────
  const thin = (a: typeof assembled, runs: TypedRun[]) =>
    (a.checked !== undefined && a.checked.stats.verified === 0) ||
    (a.evidence.length > 0 && !!deps.judge && runs.every((r) => (r.grounded ?? 0) < 0.3));
  if (
    opts.followUp !== false &&
    !extraRound &&
    !researchDown &&
    phase() === "work" &&
    thin(assembled, out.runs)
  ) {
    const { reply } = await askAnalyst(
      planner,
      followUpSystem(),
      [
        header,
        "",
        "THE RUNS' ANSWERS AND REASONS:",
        ...out.runs
          .filter((r) => r.formatted !== undefined)
          .map((r) => `- ${r.formatted}: ${r.reason ?? "(no reason)"}`),
        "",
        assembled.checked?.stats.verified
          ? "A judge found little of this reasoning backed by the verified dossier lines."
          : "No dossier line could be verified against its cited page.",
        "",
        `DOSSIER SO FAR:\n${clip(assembled.dossier, Math.min(budget, 12_000))}`,
      ].join("\n"),
    );
    const next = newQueries(reply?.queries, out.research, 4);
    if (next.length > 0) {
      const round: ResearchRound = {
        round: out.research.length + 1,
        queries: next,
        sources: 0,
        chars: 0,
        costUsd: 0,
        followUp: true,
        trigger: "grounding",
        ...(typeof reply?.missing === "string" ? { missing: reply.missing.slice(0, 300) } : {}),
      };
      const before = assembled.checked?.stats.verified ?? 0;
      await research(round, researchRequest(req, plan, next, cutoffDay, round.round));
      const again = await assemble();
      round.verifiedAdded = Math.max(0, (again.checked?.stats.verified ?? 0) - before);
      // The runs are redone only when the round added verified evidence.
      if (round.verifiedAdded > 0) {
        out.initialRuns = out.runs;
        assembled = again;
        out.runs = await runAll(assembled);
      }
    }
  }

  // ── Disagreement: search the crux, and one more run on it ─────────────────
  const agreed = combineAnswers(
    req.answer,
    out.runs
      .filter((r) => r.value !== undefined)
      .map((r) => ({ value: r.value!, weight: r.weight || 1 })),
  );
  const answered = out.runs.filter((r) => r.formatted !== undefined);
  if (
    opts.disagreementRound !== false &&
    !researchDown &&
    phase() === "work" &&
    answered.length >= 2 &&
    agreed !== undefined &&
    (agreed.agreement ?? 1) < DISAGREEMENT_BELOW
  ) {
    const { reply } = await askAnalyst(
      planner,
      cruxSystem(),
      [
        header,
        "",
        "THE RUNS DISAGREE:",
        ...answered.map((r) => `- ${r.formatted}: ${r.reason ?? "(no reason)"}`),
      ].join("\n"),
    );
    const next = newQueries(reply?.queries, out.research, 3);
    if (next.length > 0) {
      const round: ResearchRound = {
        round: out.research.length + 1,
        queries: next,
        sources: 0,
        chars: 0,
        costUsd: 0,
        trigger: "disagreement",
        ...(typeof reply?.crux === "string" ? { missing: reply.crux.slice(0, 300) } : {}),
      };
      const before = assembled.checked?.stats.verified ?? 0;
      await research(round, researchRequest(req, plan, next, cutoffDay, round.round));
      assembled = await assemble();
      round.verifiedAdded = Math.max(0, (assembled.checked?.stats.verified ?? 0) - before);
      // One more run reads the crux evidence; it is pooled with the others.
      const [extra] = await runIndependent(
        req,
        deps,
        opts,
        1,
        verifier,
        `${assembled.user}\n\nThe earlier runs disagreed on: ${typeof reply?.crux === "string" ? reply.crux.slice(0, 300) : "the answer"}. Weigh the newest evidence on that point.`,
        assembled.evidence.length ? deps.judge : undefined,
        assembled.evidence,
        judgeRecord,
        runBudget,
        out.runs.length,
      );
      if (extra) out.runs.push({ ...extra, crux: true });
    }
  }

  const { checked, dossier } = assembled;
  if (checked) out.verification = checked.stats;
  out.evidence = {
    budgetChars: budget,
    dossierChars: dossier.length,
    verifiedLines: checked?.stats.verified ?? 0,
    verifiedChars: assembled.verifiedChars,
  };
  out.sources = [...sources.values()].map(({ url, title }) => ({
    url,
    ...(title ? { title } : {}),
  }));
  const judge = assembled.evidence.length ? deps.judge : undefined;
  Object.assign(out, judgeAudit(judgeRecord?.calls ? judgeRecord : undefined));

  const selection = opts.selection ?? "agreement";
  const combined = combineAnswers(
    req.answer,
    out.runs
      .filter((r) => r.value !== undefined)
      .map((r) => ({
        value: r.value!,
        weight: r.weight,
        ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
      })),
    { selection },
  );
  if (!combined) {
    const judgeDown = out.runs.some((r) => r.judgeError);
    return finish(
      judgeDown
        ? "the judge failed, so no answer could be weighed (an outage is no opinion, never a pass)"
        : "no run produced a usable answer",
    );
  }
  out.combined = combined;
  out.prediction = combined.value;
  out.formatted = formatAnswer(combined.value);
  // Agreement among same-model runs measures consistency, not correctness: with
  // confidence selection the chosen run's own stated confidence is the
  // confidence (and the bar a critique must clear to replace the answer).
  out.confidence =
    selection === "confidence"
      ? (combined.selfConfidence ?? combined.agreement)
      : combined.agreement;
  const spec = req.answer;
  const logodds = opts.pool === "logodds";
  if (spec.type === "choice" && spec.probabilities) {
    const items = out.runs
      .filter((r) => r.distribution)
      .map((r) => ({ distribution: r.distribution!, weight: r.weight }));
    const dist = logodds ? logOddsDistributions(items) : averageDistributions(items);
    if (dist) setDistribution(out, spec.options, dist);
  }
  if (spec.type === "multi" && spec.probabilities) {
    // Each option's own probability; the picked set stays the runs' combined answer.
    const items = out.runs
      .filter((r) => r.distribution)
      .map((r) => ({ distribution: r.distribution!, weight: r.weight }));
    const marginals = logodds ? logOddsMarginals(items) : averageMarginals(items);
    if (marginals) out.distribution = marginals;
  }
  if (spec.type === "number") {
    const sd = combinedSd(out.runs, combined.spread ?? 0);
    if (sd !== undefined) out.uncertainty = { sd };
  }

  // ── Critique ──────────────────────────────────────────────────────────────
  if (opts.critique !== false && critic && phase() === "final") {
    skipped.push("critique");
    forced = true;
  } else if (opts.critique !== false && critic) {
    out.critique = await critique(req, deps, critic, header, dossier, out, since, cutoffDay);
    if (out.critique.applied && out.critique.proposed !== undefined) {
      const v = validateAnswer(req.answer, out.critique.proposed);
      if (!("error" in v)) {
        out.prediction = v.value;
        out.formatted = formatAnswer(v.value);
        out.confidence = out.critique.confidence ?? out.confidence;
        if (spec.type === "choice" && spec.probabilities && out.distribution) {
          // The critic moves the probabilities halfway toward its own view,
          // never all the way: the runs' evidence still counts.
          const theirs =
            out.critique.distribution ??
            pickDistribution(spec.options, v.value as string, out.critique.confidence);
          setDistribution(out, spec.options, blendDistributions(out.distribution, theirs, 0.5));
        }
        if (spec.type === "multi" && spec.probabilities && out.distribution) {
          const theirs = completeMarginals(
            spec.options,
            out.critique.distribution,
            v.value as string[],
            out.critique.confidence,
          );
          out.distribution = blendMarginals(out.distribution, theirs, 0.5);
        }
      }
    }
  }
  const lowGrounding = judge && out.runs.every((r) => (r.grounded ?? 0) < 0.3);
  return finish(
    lowGrounding ? "the judge found little verified evidence behind every run" : undefined,
  );
}

/**
 * The runs settled by `deadline` (undefined = still running). Budget-terminal:
 * when none has finished by then, wait for the FIRST to finish — an answer
 * from one run beats none — and take whatever has settled at that moment.
 */
export async function settleWithinBudget<T>(
  jobs: readonly Promise<T>[],
  deadline: number,
): Promise<Array<T | undefined>> {
  const done: Array<T | undefined> = new Array(jobs.length).fill(undefined);
  const tracked = jobs.map((p, i) =>
    p.then((v) => {
      done[i] = v;
      return v;
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"cap">((resolve) => {
    timer = setTimeout(() => resolve("cap"), Math.max(0, deadline - Date.now()));
  });
  try {
    const first = await Promise.race([Promise.all(tracked), cap]);
    if (first !== "cap") return first;
    if (done.every((v) => v === undefined)) await Promise.race(tracked);
    return [...done];
  } finally {
    clearTimeout(timer);
  }
}

/** K independent runs on one dossier, each judged against the verified evidence. */
async function runIndependent(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  opts: TypedForecastOptions,
  k: number,
  verifier: ModelPart | undefined,
  user: string,
  judge: DecisionProvider | undefined,
  evidence: Evidence[],
  judgeRecord: JudgeRecord | undefined,
  budget: RunBudget,
  /** Runs already made (an extra run continues the numbering and the analyst rotation). */
  offset = 0,
): Promise<TypedRun[]> {
  const jobs = Array.from({ length: k }, async (_, j): Promise<TypedRun> => {
    const i = j + offset;
    const analyst = deps.analysts[i % deps.analysts.length]!;
    const run: TypedRun = { run: i + 1, model: analyst.name, weight: 0, status: "ok" };
    const role = opts.roles?.length ? opts.roles[i % opts.roles.length] : undefined;
    const asked = await askAnalyst(
      analyst,
      role ? `${runSystem(req.answer)}\n${role}` : runSystem(req.answer),
      `${user}\n\n(Independent run ${i + 1} of ${k + offset}: reason from the evidence yourself.)`,
    );
    if (asked.error !== undefined) {
      return { ...run, status: `error: ${asked.error.slice(0, 100)}` };
    }
    let reply = asked.reply;
    let v = validateAnswer(req.answer, reply?.answer);
    // A parsed reply that is merely incomplete goes to the completion call:
    // re-encoding cannot add what is missing.
    const incomplete = opts.completion !== false && completionGap(req.answer, reply) !== undefined;
    if ("error" in v && asked.raw && !incomplete) {
      // The run answered, but not in the required shape: repair the format
      // (deterministic, else one re-encoding shot on the same analyst).
      const repaired = await repairRunAnswer(req.answer, asked.raw, analyst);
      if (repaired) {
        reply = repaired.value.reply;
        v = { value: repaired.value.value };
        run.repaired = repaired.label ?? "repaired:parse";
      }
    }
    // Right type, but incomplete (a short ranking, a missing probability, no
    // answer): one more call that names what is missing — never in the final phase.
    const gap = asked.raw !== undefined ? completionGap(req.answer, reply) : undefined;
    if (gap && opts.completion !== false) {
      if (budget.phase() === "final") {
        budget.spent("completion");
      } else {
        const done = await completeRunAnswer(
          req.answer,
          analyst,
          role ? `${runSystem(req.answer)}\n${role}` : runSystem(req.answer),
          user,
          asked.raw!,
          gap,
        );
        run.completion = {
          missing: gap,
          accepted: done.value !== undefined,
          ...(done.error ? { error: done.error } : {}),
        };
        if (done.value !== undefined) {
          reply = done.reply;
          v = { value: done.value };
          run.repaired = "repaired:completion";
        }
      }
    }
    if ("error" in v) return { ...run, status: `invalid: ${v.error}` };
    run.value = v.value;
    run.formatted = formatAnswer(v.value);
    const c = Number(reply?.confidence);
    if (Number.isFinite(c)) run.confidence = Math.min(1, Math.max(0, c));
    if (typeof reply?.reason === "string") run.reason = reply.reason.slice(0, 500);
    readUncertainty(req.answer, reply, run);
    run.weight = 1;
    if (opts.verify && verifier) {
      if (budget.phase() === "final") {
        // The budget is spent: the draft counts unchecked, and says so.
        run.verified = { model: verifier.name, verdict: "not_run", reason: "time budget spent" };
        budget.spent("verification");
      } else {
        await verifyRun(req, verifier, user, run);
      }
    }
    if (judge) {
      const judged = await judgeClaim(
        judge,
        judgeRecord,
        `Answer: ${run.formatted}. ${run.reason ?? ""}`,
        evidence,
        req.question,
        (g, q) => Math.max(0.05, (g ?? 0) * ((q ?? 0) / 2)),
      );
      run.weight = judged.weight;
      if (judged.grounded !== undefined) run.grounded = judged.grounded;
      if (judged.quality !== undefined) run.quality = judged.quality;
      if (judged.judgeError) run.judgeError = judged.judgeError;
    }
    return run;
  });
  if (!budget.deadline) return Promise.all(jobs);
  const settled = await settleWithinBudget(jobs, budget.deadline);
  if (settled.some((r) => r === undefined)) budget.spent("unfinished runs");
  return settled.map(
    (r, j) =>
      r ?? {
        run: j + offset + 1,
        model: deps.analysts[(j + offset) % deps.analysts.length]!.name,
        weight: 0,
        status: "budget: unfinished at the cap",
      },
  );
}

/** The time budget as the runs see it (budget-terminal answering). */
interface RunBudget {
  phase: () => ReturnType<typeof budgetPhase> | "work";
  /** The cap as an instant (ms since epoch); unset = no time budget. */
  deadline?: number;
  /** Record a step skipped because the budget was spent (the answer is then labelled forced). */
  spent: (what: string) => void;
}

/** Verified lines wanted before the runs (`minEvidenceLines`). */
const MIN_EVIDENCE_LINES = 5;
/** Run agreement below which the runs count as disagreeing. */
const DISAGREEMENT_BELOW = 0.7;

/**
 * Pages the question names as where it resolves — URLs in the question, its
 * resolution notes or the plan's resolution source — read before searching.
 */
export function settlementUrls(
  req: Pick<TypedForecastRequest, "question" | "context">,
  plan: Pick<ForecastPlan, "resolutionSource">,
): string[] {
  const text = [req.question, req.context ?? "", plan.resolutionSource ?? ""].join("\n");
  const urls = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)<>"'\]]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    try {
      new URL(url);
      urls.add(url);
    } catch {
      // allow-empty-catch: not a URL after all
    }
    if (urls.size >= 3) break;
  }
  return [...urls];
}

function cruxSystem(): string {
  return [
    "Independent forecasters disagree. Do not forecast.",
    "Name the single factual point their disagreement turns on, and how to settle it from published sources.",
    'Reply with ONE JSON object: {"crux": "<the point in one sentence>", "queries": ["<up to 3 short web search queries that would settle it>"]}.',
  ].join(" ");
}

/** Characters of verified evidence per judge evidence item. */
const EVIDENCE_CHUNK = 1_400;
/** Planned queries searched per research round. */
const MAX_QUERIES = 8;

/**
 * Characters of research dossier each run reads: `explicit` (the
 * `dossierChars` option), else sized to the smallest analyst context window
 * with the agent tool-result allowance (`maxToolResultTokensForWindow`, ~15 %
 * of the window) at ~3.5 characters per token, between 12 000 and 60 000;
 * the historical 24 000 when no window is known.
 */
export function dossierBudgetChars(
  windows: ReadonlyArray<number | undefined>,
  explicit?: number,
): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(2_000, Math.floor(explicit));
  }
  const known = windows.filter((w): w is number => !!w && Number.isFinite(w) && w > 0);
  if (known.length === 0) return MAX_DOSSIER_CHARS;
  const tokens = maxToolResultTokensForWindow(Math.min(...known));
  return Math.max(12_000, Math.min(60_000, Math.floor(tokens * 3.5)));
}

/**
 * The dossier within `budget` characters. When it is longer, every
 * [verified] line is kept first, then the rest in their original order, so
 * clipping drops unverified text before evidence; kept lines keep their order.
 */
export function budgetDossier(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const all = text.split("\n");
  const keep = new Set<number>();
  let used = 0;
  const take = (pick: (line: string) => boolean) => {
    all.forEach((line, i) => {
      if (keep.has(i) || !pick(line) || used + line.length + 1 > budget) return;
      keep.add(i);
      used += line.length + 1;
    });
  };
  take((l) => l.startsWith("[verified]"));
  take(() => true);
  return `${all.filter((_, i) => keep.has(i)).join("\n")}\n…(${all.length - keep.size} lines over the evidence budget left out)`;
}

/** The plan's queries, plus the named resolution source when the planner left room. */
function researchQueries(plan: ForecastPlan): string[] {
  const qs = plan.queries.slice(0, MAX_QUERIES);
  const source = plan.resolutionSource?.replace(/\s+/g, " ").trim();
  if (source) {
    const named = source
      .split(/[,;(]| — | - /)[0]!
      .trim()
      .slice(0, 80);
    const topic = (plan.keyQuantities?.[0] ?? plan.restatement ?? "").slice(0, 100);
    const q = `${named} ${topic}`.trim().slice(0, 200);
    const at = qs.findIndex((x) => x.toLowerCase().includes(named.toLowerCase()));
    // The settlement source is searched first.
    if (at > 0) qs.unshift(qs.splice(at, 1)[0]!);
    else if (at < 0 && named.length >= 3) qs.unshift(q);
  }
  return qs.slice(0, MAX_QUERIES);
}

/** Up to `max` queries from a model reply that no earlier round already asked. */
function newQueries(raw: unknown, done: ResearchRound[], max: number): string[] {
  const asked = new Set(done.flatMap((x) => x.queries.map((q) => q.toLowerCase())));
  return strings(raw)
    .filter((q) => !asked.has(q.toLowerCase()))
    .slice(0, max);
}

function followUpSystem(): string {
  return [
    "You direct one last research round for a forecaster. Do not forecast.",
    "Independent runs answered, but their reasoning is not backed by verified evidence.",
    "Name the decisive facts they relied on or lacked, and search for them where they are published: the resolution source itself, official data, the latest dated reports.",
    'Reply with ONE JSON object: {"missing": "<the decisive facts still unverified>", "queries": ["<up to 4 NEW short web search queries>"]}.',
  ].join(" ");
}

function verifierSystem(spec: AnswerSpec): string {
  return [
    "You verify a forecaster's draft answer before it counts. Check it against the dossier and the question's resolution rules: the right option semantics, the right unit and scale, the latest reading, arithmetic.",
    TIMING,
    "Accept the draft unless you find a concrete error; then give the corrected answer.",
    'Reply with ONE JSON object: {"verdict": "accept" | "correct", "answer": <only on correct, same format as below>, "reason": "<one sentence>"}.',
    "Answer format:",
    answerInstruction(spec),
  ].join("\n");
}

/** One run's draft checked by the verifier; a valid correction replaces the run's value. */
async function verifyRun(
  req: TypedForecastRequest,
  verifier: ModelPart,
  user: string,
  run: TypedRun,
): Promise<void> {
  const { reply, error } = await askAnalyst(
    verifier,
    verifierSystem(req.answer),
    `${user}\n\nDRAFT ANSWER: ${run.formatted}\nDRAFT REASON: ${run.reason ?? "(none)"}`,
  );
  if (error !== undefined) {
    run.verified = { model: verifier.name, verdict: "error", reason: error.slice(0, 120) };
    return;
  }
  const reason = typeof reply?.reason === "string" ? reply.reason.slice(0, 300) : undefined;
  if (reply?.verdict === "correct") {
    const v = validateAnswer(req.answer, reply.answer);
    if (!("error" in v) && formatAnswer(v.value) !== run.formatted) {
      run.verified = {
        model: verifier.name,
        verdict: "correct",
        draft: run.formatted!,
        ...(reason ? { reason } : {}),
      };
      run.value = v.value;
      run.formatted = formatAnswer(v.value);
      // The run's uncertainty follows the correction (the verifier's own, else from the pick).
      delete run.distribution;
      delete run.sd;
      readUncertainty(req.answer, reply, run);
      return;
    }
  }
  run.verified = { model: verifier.name, verdict: "accept", ...(reason ? { reason } : {}) };
}

async function critique(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  critic: ModelPart,
  header: string,
  dossier: string,
  out: TypedForecastAnswer,
  since: string,
  cutoffDay: string,
): Promise<Critique> {
  const result: Critique = { model: critic.name, verdict: "keep", applied: false };
  let counter = "";
  try {
    const r = await deps.retriever({
      roundId: "forecast-critique",
      since,
      until: cutoffDay,
      untilAt: out.cutoff.at,
      queries: [`${req.question.slice(0, 150)} ${out.formatted}`.slice(0, 200)],
      request: [
        `A forecaster's leading answer to "${req.question}" is: ${out.formatted}.`,
        `Find the strongest dated, sourced evidence (published on or before ${cutoffDay}) that this answer is WRONG,`,
        "and anything about how the question resolves that the answer may have misread. Cite every fact. Do not forecast.",
      ].join(" "),
    });
    counter = r.report;
    result.counterEvidenceSources = r.sources.length;
  } catch (err) {
    result.error = `counter-research failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
  const { reply, error } = await askAnalyst(
    critic,
    criticSystem(req.answer),
    [
      header,
      "",
      `LEADING ANSWER: ${out.formatted} (${out.combined?.selfConfidence !== undefined ? "stated confidence" : "agreement"} ${out.confidence} across ${out.runs.length} runs)`,
      ...out.runs
        .filter((r) => r.formatted !== undefined)
        .map((r) => `- run ${r.run} (${r.model}): ${r.formatted} — ${r.reason ?? ""}`),
      "",
      "RESEARCH DOSSIER:",
      dossier,
      "",
      "COUNTER-EVIDENCE SEARCH:",
      clip(counter, 8_000) || "(nothing found)",
    ].join("\n"),
  );
  if (error !== undefined) return { ...result, verdict: "error", error: error.slice(0, 200) };
  const c = Number(reply?.confidence);
  if (Number.isFinite(c)) result.confidence = Math.min(1, Math.max(0, c));
  if (typeof reply?.reason === "string") result.reason = reply.reason.slice(0, 500);
  if (reply?.verdict !== "revise") return result;
  const v = validateAnswer(req.answer, reply.answer);
  if ("error" in v) return { ...result, verdict: "keep", reason: `revision invalid: ${v.error}` };
  const proposed = formatAnswer(v.value);
  if (proposed === out.formatted) return result;
  result.verdict = "revise";
  result.proposed = proposed;
  if (probabilistic(req.answer)) {
    const d =
      req.answer.type === "choice"
        ? parseDistribution(req.answer.options, reply.probabilities)
        : parseMarginals(req.answer.options, reply.probabilities);
    if (d) result.distribution = d;
  }
  result.applied = critiqueApplies(result.confidence, out.confidence);
  return result;
}

/**
 * The critic's revision replaces the runs' answer only when the critic is more
 * sure than the forecast's own confidence (the runs' agreement, or the chosen
 * run's stated confidence under `selection: "confidence"`).
 */
export function critiqueApplies(
  critiqueConfidence: number | undefined,
  forecastConfidence: number | undefined,
): boolean {
  return (critiqueConfidence ?? 0) > (forecastConfidence ?? 0);
}

/**
 * The final typed answer a stored forecast would give under `selection`, from
 * its recorded runs and critique — no model calls. For offline re-scoring of
 * saved forecasts (`benchmarks/futurex/rescore-selection.ts`). The critique is
 * the recorded one: it saw the leading answer of the selection that ran.
 */
export function reselect(
  answer: Pick<TypedForecastAnswer, "answer" | "runs" | "critique">,
  selection: SelectionMode,
): string | undefined {
  const combined = combineAnswers(
    answer.answer,
    answer.runs
      .filter((r) => r.value !== undefined)
      .map((r) => ({
        value: r.value!,
        weight: r.weight,
        ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
      })),
    { selection },
  );
  if (!combined) return undefined;
  const confidence =
    selection === "confidence"
      ? (combined.selfConfidence ?? combined.agreement)
      : combined.agreement;
  const c = answer.critique;
  if (
    c?.verdict === "revise" &&
    c.proposed !== undefined &&
    critiqueApplies(c.confidence, confidence)
  ) {
    const v = validateAnswer(answer.answer, c.proposed);
    if (!("error" in v)) return formatAnswer(v.value);
  }
  return formatAnswer(combined.value);
}

function probabilitiesInstruction(options: AnswerOption[]): string {
  const example = options
    .map(
      (o, i) =>
        `"${o.id}": ${i === 0 ? "0.7" : (0.3 / Math.max(1, options.length - 1)).toFixed(2)}`,
    )
    .join(", ");
  return `Also give "probabilities": an object mapping EVERY option id to your probability (0..1) that it is the outcome, summing to 1, e.g. {${example}}. Calibrate: never 0 or 1, and keep some mass on outcomes you think unlikely.`;
}

/** A choice or multi-select that asks for a probability on every option. */
function probabilistic(
  spec: AnswerSpec,
): spec is Extract<AnswerSpec, { type: "choice" | "multi" }> & { probabilities: true } {
  return (spec.type === "choice" || spec.type === "multi") && spec.probabilities === true;
}

/**
 * A run's stated uncertainty: per-option probabilities for a probabilistic
 * choice or multi-select (from its picks and confidence where it gave none),
 * an sd for a number.
 */
function readUncertainty(
  spec: AnswerSpec,
  reply: Record<string, unknown> | undefined,
  run: TypedRun,
): void {
  if (spec.type === "choice" && spec.probabilities && typeof run.value === "string") {
    run.distribution =
      parseDistribution(spec.options, reply?.probabilities) ??
      pickDistribution(spec.options, run.value, run.confidence);
  }
  if (spec.type === "multi" && spec.probabilities && Array.isArray(run.value)) {
    run.distribution = completeMarginals(
      spec.options,
      parseMarginals(spec.options, reply?.probabilities),
      run.value as string[],
      run.confidence,
    );
  }
  if (spec.type === "number") {
    const sd = Number(reply?.sd);
    if (Number.isFinite(sd) && sd > 0) run.sd = sd;
  }
}

/** The forecast distribution, with `prediction` its most probable option. */
function setDistribution(
  out: TypedForecastAnswer,
  options: AnswerOption[],
  dist: Distribution,
): void {
  out.distribution = dist;
  const top = argmax(options, dist);
  out.prediction = top;
  out.formatted = top;
  out.confidence = dist[top];
}

export function chooseCutoff(req: TypedForecastRequest, now: Date): TypedForecastAnswer["cutoff"] {
  const slack = 3_600_000;
  const asOf = req.asOf ? Date.parse(req.asOf) : Number.NaN;
  if (Number.isFinite(asOf)) {
    return {
      at: new Date(asOf).toISOString(),
      basis: "asOf",
      pastCutoff: now.getTime() - asOf > slack,
    };
  }
  const end = req.endTime ? Date.parse(req.endTime) : Number.NaN;
  if (Number.isFinite(end) && end < now.getTime()) {
    return {
      at: new Date(end).toISOString(),
      basis: "endTime",
      pastCutoff: now.getTime() - end > slack,
    };
  }
  return { at: now.toISOString(), basis: "now", pastCutoff: false };
}

function researchRequest(
  req: TypedForecastRequest,
  plan: ForecastPlan,
  queries: string[],
  cutoffDay: string,
  round: number,
): string {
  return [
    `A forecaster must answer: ${req.question}`,
    plan.resolutionSource ? `It resolves from: ${plan.resolutionSource}.` : "",
    req.endTime ? `The question closes ${req.endTime}.` : "",
    `Report only facts published on or before ${cutoffDay}.`,
    round === 1
      ? "Report the most recent dated facts: the latest readings of what decides the answer, the base rate or usual range, scheduled events before it resolves, and what markets or experts expect."
      : "Find the facts still missing for this answer.",
    plan.keyQuantities?.length ? `Decisive facts: ${plan.keyQuantities.join("; ")}.` : "",
    `Search for: ${queries.join(" | ")}`,
    "Rules: every fact needs its date and source; numbers exactly as published; say when you found nothing; do not forecast yourself.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A run's answer in the required shape from raw text that missed it: the JSON
 * reply anywhere in the text, else ONE re-encoding shot on the same analyst
 * whose answer (and reason) must appear verbatim in the original text.
 */
async function repairRunAnswer(
  spec: AnswerSpec,
  raw: string,
  analyst: { complete: (system: string, user: string) => Promise<string> },
): Promise<Repaired<{ reply: Record<string, unknown>; value: AnswerValue }> | undefined> {
  return repairOutput({
    raw,
    parse: (text) => {
      const json = extractJsonValue(text);
      if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
      const reply = json as Record<string, unknown>;
      const v = validateAnswer(spec, reply.answer);
      return "error" in v ? undefined : { reply, value: v.value };
    },
    contract: `ONE JSON object {"answer": …, "reason": "…"} where ${answerInstruction(spec)}`,
    shot: (system, user) => analyst.complete(system, user),
    // Every field the run reports must be in its own words: answer, reason,
    // confidence and sd — a shot never supplies one.
    preserves: ({ reply }, source) =>
      groundedIn([reply.answer, reply.reason, reply.confidence, reply.sd], source),
  });
}

/**
 * What a run's answer is missing, when it has the right type but is incomplete:
 * a ranking short of its size, a multi-select short of its minimum, a choice
 * or number with no answer, or a probability missing for some option of a
 * probabilistic choice or multi-select. Undefined when complete — or when it is
 * wrong rather than incomplete (an unknown option, too many picks), or when
 * there is no JSON reply at all (output repair's job): asking again would not
 * be adding what is missing.
 */
export function completionGap(
  spec: AnswerSpec,
  reply: Record<string, unknown> | undefined,
): string | undefined {
  // No JSON reply at all is a format failure (output repair's job), not a gap.
  if (!reply) return undefined;
  const raw = reply.answer;
  const absent =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && !raw.trim()) ||
    (Array.isArray(raw) && raw.every((x) => !String(x ?? "").trim()));
  const optionList = (ids: string[]) =>
    ids
      .map((id) => {
        const o = spec.type === "choice" || spec.type === "multi" ? spec.options : [];
        const label = o.find((x) => x.id === id)?.label;
        return label ? `${id} (${label})` : id;
      })
      .join("; ");
  const v = validateAnswer(spec, raw);
  if ("error" in v) {
    switch (spec.type) {
      case "ranking": {
        const n = Array.isArray(raw)
          ? raw.length
          : typeof raw === "string"
            ? raw.split(/[,;|\n]/).filter((x) => x.trim()).length
            : 0;
        const size = spec.size;
        return [
          size
            ? `rank all ${size} places: "answer" must be an array of exactly ${size} items, first = top (your answer had ${n})`
            : `"answer" must be a non-empty ranked array, first = top`,
          spec.candidates?.length ? `choose from these items: ${spec.candidates.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("; ");
      }
      case "multi":
        if (absent || v.error === "too few options picked") {
          return `pick at least ${Math.max(1, spec.minPicks ?? 1)} option(s) from: ${optionList(spec.options.map((o) => o.id))}`;
        }
        return undefined;
      case "choice":
        return absent
          ? `pick exactly ONE option id from: ${optionList(spec.options.map((o) => o.id))}`
          : undefined;
      case "number":
        return `give "answer" as ONE number${spec.unit ? ` in ${spec.unit}` : ""} (your single most likely value) and "sd"`;
      case "text":
        return absent ? `give "answer" as a short string` : undefined;
    }
  }
  if (probabilistic(spec)) {
    const covered = new Set(Object.keys(parseMarginals(spec.options, reply.probabilities) ?? {}));
    const missing = spec.options.filter((o) => !covered.has(o.id)).map((o) => o.id);
    if (missing.length > 0) {
      return `give a probability for EACH option in "probabilities": ${optionList(spec.options.map((o) => o.id))} (missing: ${missing.join(", ")})`;
    }
  }
  return undefined;
}

/**
 * The completion call: the run's own answer and reasons back to the same
 * analyst with exactly what is missing. Its reply counts only when the answer
 * now validates (and, for a probabilistic question, covers every option).
 */
async function completeRunAnswer(
  spec: AnswerSpec,
  analyst: ModelPart,
  system: string,
  user: string,
  prior: string,
  missing: string,
): Promise<{ reply?: Record<string, unknown>; value?: AnswerValue; error?: string }> {
  const asked = await askAnalyst(
    analyst,
    system,
    [
      user,
      "",
      "YOUR EARLIER ANSWER (with its reasons):",
      prior.slice(0, 4_000),
      "",
      `It is INCOMPLETE: ${missing}.`,
      "Keep your reasoning; reply again with the COMPLETE JSON object in the required format.",
    ].join("\n"),
  );
  if (asked.error !== undefined) return { error: asked.error.slice(0, 200) };
  const reply = asked.reply;
  const v = validateAnswer(spec, reply?.answer);
  if ("error" in v) return { error: `still invalid: ${v.error}` };
  if (completionGap(spec, reply)) return { error: "still incomplete" };
  return { reply: reply!, value: v.value };
}

function parsePlan(reply: Record<string, unknown> | undefined): ForecastPlan {
  if (!reply) return { queries: [] };
  return {
    ...(typeof reply.restatement === "string"
      ? { restatement: reply.restatement.slice(0, 400) }
      : {}),
    ...(typeof reply.resolutionSource === "string"
      ? { resolutionSource: reply.resolutionSource.slice(0, 300) }
      : {}),
    keyQuantities: strings(reply.keyQuantities).slice(0, 8),
    queries: strings(reply.queries).slice(0, MAX_QUERIES),
    whatWouldChange: strings(reply.whatWouldChange).slice(0, 8),
    ...dataHints(reply.data),
  };
}

function dataHints(v: unknown): { data?: DataHints } {
  if (!v || typeof v !== "object") return {};
  const d = v as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 120) : "");
  const hints: DataHints = {};
  const markets = text(d.markets);
  if (markets) hints.markets = markets;
  const sport = text(d.sport);
  if (sport) hints.sport = sport;
  const teams = strings(d.teams).slice(0, 4);
  if (teams.length) hints.teams = teams;
  const fred = strings(d.fred).slice(0, 3);
  if (fred.length) hints.fred = fred;
  const bls = strings(d.bls).slice(0, 3);
  if (bls.length) hints.bls = bls;
  return Object.keys(hints).length ? { data: hints } : {};
}

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((x) => x.trim().slice(0, 200))
    : [];
}

function clip(s: string, max = MAX_DOSSIER_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s;
}
