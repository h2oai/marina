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
 *   lookups    optional structured sources (prediction markets), opt-in
 *   verify     cited figures checked mechanically against the cited pages
 *   runs       K independent answers (analyst models used round-robin), each
 *              weighted by the judge's grounding score when a judge is set
 *   combine    by type: plurality / per-option frequency / median / Borda;
 *              agreement between the runs is the confidence
 *   critique   a disconfirmation pass searches for evidence AGAINST the leading
 *              answer; the critic may revise it only when its own confidence
 *              exceeds the runs' agreement
 *
 * A research outage (every round failed) does not stop the forecast: the runs
 * answer from the question and its notes, and the answer says so.
 *
 * Evidence is frozen at a cutoff: the request's `asOf`, else the earlier of now
 * and the question's `endTime`. Retrieval is asked for nothing after it (engines
 * that filter by date drop later results), lookups that only know current
 * values are skipped for a past cutoff, and the cutoff is recorded.
 *
 * Every stage is returned — the answer object is the audit trail. Pure
 * orchestration over injected parts; `service.ts` wires the real ones.
 */

import type { ResearchReport, Retriever } from "../arena/research/retrieve";
import { type PageText, verifyDossier } from "../arena/research/verify";
import type { Evidence } from "../decisions/evidence";
import type { DecisionProvider } from "../decisions/types";
import {
  type AnswerSpec,
  type AnswerValue,
  type CombinedAnswer,
  combineAnswers,
  formatAnswer,
  validateAnswer,
} from "./answer-types";
import { askAnalyst, type JudgeRecord, judgeAudit, judgeClaim, newJudgeRecord } from "./judge";
import { type ForecastLookup, type LookupResult, runLookups } from "./lookups";

export interface TypedForecastRequest {
  question: string;
  answer: AnswerSpec;
  /** ISO time the question closes. The answer uses nothing published after it. */
  endTime?: string;
  /** Freeze evidence at this ISO time instead (default: the earlier of now and endTime). */
  asOf?: string;
  /** Resolution rules, format notes or background the asker supplies. */
  context?: string;
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
}

export interface ModelPart {
  name: string;
  complete: (system: string, user: string) => Promise<string>;
}

export interface TypedForecastDeps {
  retriever: Retriever;
  /** Models for the K runs, used round-robin. */
  analysts: ModelPart[];
  /** Plans and names research gaps (default: the first analyst). */
  planner?: ModelPart;
  /** The disconfirmation pass (default: the planner). */
  critic?: ModelPart;
  judge?: DecisionProvider;
  pageText?: PageText;
  lookups?: ForecastLookup[];
  now?: () => Date;
  options?: TypedForecastOptions;
}

export interface ForecastPlan {
  restatement?: string;
  resolutionSource?: string;
  keyQuantities?: string[];
  queries: string[];
  whatWouldChange?: string[];
  error?: string;
}

export interface ResearchRound {
  round: number;
  queries: string[];
  sources: number;
  chars: number;
  costUsd: number;
  error?: string;
  /** What the planner said was still missing after this round. */
  missing?: string;
}

export interface TypedRun {
  run: number;
  model: string;
  value?: AnswerValue;
  formatted?: string;
  confidence?: number;
  reason?: string;
  weight: number;
  grounded?: number;
  quality?: number;
  judgeError?: string;
  status: string;
}

export interface Critique {
  model: string;
  verdict: "keep" | "revise" | "error";
  /** The answer the critic proposed (present on revise). */
  proposed?: string;
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
  combined?: CombinedAnswer;
  runs: TypedRun[];
  plan?: ForecastPlan;
  research: ResearchRound[];
  lookups?: LookupResult[];
  critique?: Critique;
  /** The evidence cutoff (ISO) and how it was chosen. */
  cutoff: { at: string; basis: "asOf" | "endTime" | "now"; pastCutoff: boolean };
  sources: Array<{ url: string; title?: string }>;
  verification?: Record<string, number>;
  judge?: JudgeRecord;
  costUsd: number;
  latencyMs: number;
  caveat?: string;
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
      ].join("\n");
    case "multi":
      return [
        `Pick EVERY option that will be true${spec.maxPicks ? ` (at most ${spec.maxPicks})` : ""}. Options:`,
        ...spec.options.map((o) => `  ${o.id}${o.label ? ` — ${o.label}` : ""}`),
        `"answer" is an array of option ids, e.g. ["${spec.options[0]!.id}"].`,
      ].join("\n");
    case "number":
      return [
        `"answer" is ONE number${spec.unit ? ` in ${spec.unit}` : ""}: your single most likely value, exactly as the resolution source will publish it — not a hedge between outcomes.`,
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
    '"queries": ["<up to 6 short web search queries, most useful first>"],',
    '"whatWouldChange": ["<events or readings that would move the answer>"]}.',
  ].join(" ");
}

function gapSystem(): string {
  return [
    "You review a research dossier for a forecaster. Do not forecast.",
    'Reply with ONE JSON object: {"done": true|false, "missing": "<what decisive fact is still missing>",',
    '"queries": ["<up to 4 NEW short search queries that would find it>"]}. Say done when the dossier already holds the decisive facts.',
  ].join(" ");
}

function runSystem(spec: AnswerSpec): string {
  return [
    "You are a careful forecaster. Given a question, how it resolves, and a research dossier of dated, sourced facts, predict the answer.",
    "Start from the latest published value or the base rate, then adjust for the specific evidence. Rely on [verified] lines; treat [unverified] figures as suspect.",
    "Use nothing dated after the stated cutoff.",
    answerInstruction(spec),
    'Reply with ONE JSON object: {"answer": <as above>, "confidence": <0..1, how likely your answer is exactly right>,' +
      `${spec.type === "number" ? ' "sd": <number>,' : ""} "reason": "<two sentences citing the facts that decided it>"}.`,
  ].join("\n");
}

function criticSystem(spec: AnswerSpec): string {
  return [
    "You are the forecaster's critic. Look for the strongest evidence that the leading answer is WRONG — a newer reading, a misread source, a rule that changes how it resolves.",
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

  const header = [
    `Question: ${req.question}`,
    req.context ? `How it resolves / notes:\n${req.context.slice(0, 4_000)}` : "",
    req.endTime ? `The question closes: ${req.endTime}` : "",
    `Evidence cutoff: ${cutoff.at} (use nothing published after it)`,
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
  let queries = plan.queries.slice(0, 6);
  for (let r = 1; r <= rounds && queries.length; r++) {
    const brief = {
      roundId: "forecast",
      since,
      until: cutoffDay,
      queries,
      request: researchRequest(req, plan, queries, cutoffDay, r),
    };
    const round: ResearchRound = { round: r, queries, sources: 0, chars: 0, costUsd: 0 };
    let report: ResearchReport | undefined;
    try {
      report = await deps.retriever(brief);
    } catch (err) {
      round.error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
    if (report) {
      round.costUsd = report.costUsd;
      round.chars = report.report.length;
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
    if (r === rounds) break;
    const { reply } = await askAnalyst(
      planner,
      gapSystem(),
      `${header}\n\nDOSSIER SO FAR:\n${clip(lines.join("\n"))}`,
    );
    const asked = new Set(out.research.flatMap((x) => x.queries.map((q) => q.toLowerCase())));
    const next = strings(reply?.queries)
      .filter((q) => !asked.has(q.toLowerCase()))
      .slice(0, 4);
    if (typeof reply?.missing === "string") round.missing = reply.missing.slice(0, 300);
    if (reply?.done === true || next.length === 0) break;
    queries = next;
  }

  // ── Lookups ───────────────────────────────────────────────────────────────
  if (deps.lookups?.length) {
    out.lookups = await runLookups(
      deps.lookups,
      plan.restatement ?? req.question,
      new Date(cutoff.at),
      now,
    );
    for (const l of out.lookups) {
      lines.push(...l.lines);
      for (const s of l.sources) if (!sources.has(s.url)) sources.set(s.url, s);
    }
  }
  out.sources = [...sources.values()].map(({ url, title }) => ({
    url,
    ...(title ? { title } : {}),
  }));
  // A research outage is not a reason to give up: the runs still answer from
  // the question, its resolution notes and what the models know — with a caveat.
  const researchDown = lines.length === 0 && out.research.every((r) => r.error);
  if (researchDown) {
    earlier.push(
      `research failed, so the runs answered without a dossier: ${out.research[0]?.error ?? "no result"}`,
    );
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  const report = lines.join("\n");
  const checked = deps.pageText
    ? await verifyDossier(report, deps.pageText, [...sources.values()])
    : undefined;
  if (checked) out.verification = checked.stats;
  const dossier = clip(checked ? checked.annotated : report);
  const evidence: Evidence[] = [];
  const verifiedText = checked ? checked.verifiedText : report;
  for (let i = 0; i < verifiedText.length && evidence.length < 4; i += 1_400) {
    evidence.push({
      ref: `dossier:${evidence.length + 1}`,
      text: verifiedText.slice(i, i + 1_400),
    });
  }
  const judge = evidence.length ? deps.judge : undefined;
  const judgeRecord = newJudgeRecord(judge);

  // ── K independent runs ────────────────────────────────────────────────────
  const user = `${header}\n\nRESEARCH DOSSIER${checked ? " (cited lines tagged by a mechanical check against the cited page)" : ""}:\n${dossier || (researchDown ? "(research unavailable — answer from the question, its notes and what you know as of the cutoff)" : "(nothing found)")}`;
  out.runs = await Promise.all(
    Array.from({ length: k }, async (_, i): Promise<TypedRun> => {
      const analyst = deps.analysts[i % deps.analysts.length]!;
      const run: TypedRun = { run: i + 1, model: analyst.name, weight: 0, status: "ok" };
      const { reply, error } = await askAnalyst(
        analyst,
        runSystem(req.answer),
        `${user}\n\n(Independent run ${i + 1} of ${k}: reason from the evidence yourself.)`,
      );
      if (error !== undefined) return { ...run, status: `error: ${error.slice(0, 100)}` };
      const v = validateAnswer(req.answer, reply?.answer);
      if ("error" in v) return { ...run, status: `invalid: ${v.error}` };
      run.value = v.value;
      run.formatted = formatAnswer(v.value);
      const c = Number(reply?.confidence);
      if (Number.isFinite(c)) run.confidence = Math.min(1, Math.max(0, c));
      if (typeof reply?.reason === "string") run.reason = reply.reason.slice(0, 500);
      run.weight = 1;
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
    }),
  );
  Object.assign(out, judgeAudit(judgeRecord));

  const combined = combineAnswers(
    req.answer,
    out.runs
      .filter((r) => r.value !== undefined)
      .map((r) => ({
        value: r.value!,
        weight: r.weight,
        ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
      })),
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
  out.confidence = combined.agreement;

  // ── Critique ──────────────────────────────────────────────────────────────
  if (opts.critique !== false && critic) {
    out.critique = await critique(req, deps, critic, header, dossier, out, since, cutoffDay);
    if (out.critique.applied && out.critique.proposed !== undefined) {
      const v = validateAnswer(req.answer, out.critique.proposed);
      if (!("error" in v)) {
        out.prediction = v.value;
        out.formatted = formatAnswer(v.value);
        out.confidence = out.critique.confidence ?? out.confidence;
      }
    }
  }
  const lowGrounding = judge && out.runs.every((r) => (r.grounded ?? 0) < 0.3);
  return finish(
    lowGrounding ? "the judge found little verified evidence behind every run" : undefined,
  );
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
      `LEADING ANSWER: ${out.formatted} (agreement ${out.confidence} across ${out.runs.length} runs)`,
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
  // The critic overrides the runs only when it is more sure than they agree.
  result.applied = (result.confidence ?? 0) > (out.confidence ?? 0);
  return result;
}

function chooseCutoff(req: TypedForecastRequest, now: Date): TypedForecastAnswer["cutoff"] {
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
    queries: strings(reply.queries).slice(0, 6),
    whatWouldChange: strings(reply.whatWouldChange).slice(0, 8),
  };
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
