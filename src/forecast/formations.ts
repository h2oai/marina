// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Formations over the typed forecaster (`./typed.ts`): HOW several runs
 * combine, never WHAT they know. Every formation starts from one ordinary
 * typed forecast (plan → research → lookups → K independent runs), so the
 * evidence and its cutoff are identical; only the combination differs.
 *
 * Each formation is a catalogue entry (`src/orchestration/formations/`): a
 * Score template plus a pure combiner per answer type. Round one (the
 * template's `research` and `f1 … fK`) is the typed pipeline; what follows
 * runs as the template's Score through the Score executor, its member steps
 * dispatched to the run's own part — a model, a `marina:<crew>`, or a
 * resident (`./resident-forecast.ts` runs the same templates with resident
 * slots) — and its combine step is the pure combiner:
 *
 *   ensemble   — the typed forecaster as is: the runs combined by type, then
 *                the critique (the control for the others); the whole
 *                template is the pipeline's own round one and combine
 *   delphi     — independence before influence: the runs are round one; each
 *                member then sees an ANONYMOUS panel summary (per-option
 *                medians and ranges, short reason snippets, no names) and the
 *                same research, and revises once; the answer is the median of
 *                the revisions (per option for probabilities)
 *   tournament — the runs' proposals meet in pairwise knockout matches judged
 *                by the critic (an odd field gives a bye), match by match; the
 *                champion's answer and uncertainty are the forecast; the
 *                bracket is kept
 *   skeptic    — the arena's crew: a statistician and an analyst propose, a
 *                skeptic sets how much of their move away from the prior to
 *                trust; deterministic aggregation that can only shrink toward
 *                the prior (`./skeptic.ts`)
 *
 * Whatever the formation, the finished answer then goes through the prior
 * shrink and recalibration stage when the operator turned it on
 * (`deps.adjust`, `./adjust.ts`).
 *
 * The verification formation is the typed forecaster's own `verify` option,
 * and a crew formation is a `marina:<crew>` analyst — both compose with these.
 * A failed member or match drops out (a match falls to the first proposal);
 * with fewer than two usable runs every formation returns the runs' answer.
 * The catalogue implementation reproduces the pre-catalogue one exactly
 * (`test/formation-equivalence-typed.test.ts`).
 */

import {
  partAssignee,
  TYPED_PIPELINE_ASSIGNEE,
  TYPED_TEMPLATES,
  type TypedFormationName,
} from "../orchestration/formations/catalogue";
import {
  championAnswer,
  combineDelphi,
  matchWinner,
  panelSummary,
} from "../orchestration/formations/combine-typed";
import { runFormationScore, seeded } from "../orchestration/formations/run";
import { formationScore, knockout } from "../orchestration/formations/template";
import type { Score } from "../sdk/score";
import { adjustActive, adjustForecast } from "./adjust";
import {
  type AnswerContract,
  contractInstruction,
  enforceContract,
  parseAnswerContract,
  reaskPrompt,
} from "./answer-contract";
import { type AnswerSpec, type AnswerValue, formatAnswer, validateAnswer } from "./answer-types";
import {
  completeMarginals,
  type Distribution,
  parseDistribution,
  parseMarginals,
  pickDistribution,
} from "./distribution";
import { askAnalyst } from "./judge";
import { fencedForResidents } from "./resident-part";
import { type SkepticRecord, skepticCrew } from "./skeptic";
import { forecastTriaged } from "./triage-route";
import {
  answerInstruction,
  forecastTyped,
  type ModelPart,
  type TypedForecastAnswer,
  type TypedForecastDeps,
  type TypedForecastRequest,
  type TypedRun,
} from "./typed";

// The pure Delphi helpers live with the catalogue's combiners.
export { median, panelSummary } from "../orchestration/formations/combine-typed";

/** The typed formations: the catalogue's typed templates, in routing order. */
export const TYPED_FORMATIONS = [
  "ensemble",
  "delphi",
  "tournament",
  "skeptic",
] as const satisfies readonly TypedFormationName[];
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
  /** Skeptic crew: the roles, the start forecast, the proposals and the trust. */
  crew?: SkepticRecord;
  /** Why the formation fell back to the runs' own answer. */
  fallback?: string;
}

export type FormedAnswer = TypedForecastAnswer & { formation: FormationRecord };

const MAX_RESEARCH = 12_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function forecastFormed(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  pattern: TypedFormation = "ensemble",
): Promise<FormedAnswer> {
  // ── As-of fence hook (`./resident-part.ts`): resident parts + a past cutoff ──
  const fenced = fencedForResidents(req, deps, () => forecastFormed(req, deps, pattern));
  if (fenced) return fenced;
  // ── end as-of fence hook ──
  // The answer contract (`./answer-contract.ts`): a caller's own, else parsed
  // from the question's instructions when the operator turned it on. Only
  // `on` carries it into the prompts; `observe` checks the result and records.
  const mode = deps.options?.contract ?? "off";
  const contract: AnswerContract | undefined =
    req.contract ?? (mode === "off" ? undefined : parseAnswerContract(req));
  const enforce = !contract ? undefined : mode === "observe" ? "observe" : "on";
  const { contract: _own, ...plain } = req;
  const carried: TypedForecastRequest = enforce === "on" ? { ...plain, contract } : plain;
  // Intake triage (`./triage-route.ts`): only when the deps carry it (`off` never does).
  const out = deps.triage
    ? await forecastTriaged(carried, { ...deps, triage: deps.triage }, pattern, (r, d) =>
        formed(r, d, pattern),
      )
    : await formed(carried, deps, pattern);
  // A triage read-off is a published figure: no prior shrink or recalibration moves it.
  if (adjustActive(deps.adjust) && !out.triage?.readoff?.answered)
    await adjustForecast(out, carried, deps.adjust);
  if (contract && enforce) await applyContract(out, carried, deps, contract, enforce);
  return out;
}

/**
 * The final validator: check the finished answer against the contract;
 * under `on`, normalise it, else re-ask the critic (else the planner, else the
 * first analyst) ONCE, else fall back deterministically — and when the
 * contract's value is a valid typed answer, it becomes the prediction (the
 * pipeline's own answer stays in `contract.before`). A forecast with no answer
 * at all is recorded, never filled in: that is the caller's fallback to make.
 */
async function applyContract(
  out: FormedAnswer,
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  contract: AnswerContract,
  mode: "observe" | "on",
): Promise<void> {
  if (out.formatted === undefined) {
    out.contract = { contract, mode, status: "violation", violations: ["no answer"] };
    return;
  }
  const model = deps.critic ?? deps.planner ?? deps.analysts[0];
  const reask = model
    ? async (violation: string) => {
        const p = reaskPrompt(contract, req.question, out.formatted!, violation);
        const { reply, error } = await askAnalyst(model, p.system, p.user);
        return {
          model: model.name,
          ...(error !== undefined ? { error } : { answer: reply?.answer }),
        };
      }
    : undefined;
  const rec = await enforceContract(contract, out.prediction ?? out.formatted, {
    mode,
    ...(reask ? { reask } : {}),
    ...(out.distribution ? { distribution: out.distribution } : {}),
  });
  out.contract = rec;
  if (mode !== "on" || rec.value === undefined) return;
  const v = validateAnswer(req.answer, rec.value);
  if ("error" in v) return;
  const formatted = formatAnswer(v.value);
  if (formatted === out.formatted) return;
  out.prediction = v.value;
  out.formatted = formatted;
}

async function formed(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  pattern: TypedFormation,
): Promise<FormedAnswer> {
  if (pattern === "ensemble") {
    // The catalogue's ensemble template is the pipeline itself: research, K runs, combine.
    return { ...(await forecastTyped(req, deps)), formation: { pattern } };
  }
  if (pattern === "skeptic") {
    const { crew, ...answer } = await skepticCrew(req, deps);
    return { ...answer, formation: { pattern, crew } };
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

function reviseSystem(spec: AnswerSpec, contract?: TypedForecastRequest["contract"]): string {
  return [
    "You are one member of an anonymous forecasting panel (Delphi method). You answered independently;",
    "now you see the panel's anonymous summary and the same research. Revise your forecast ONCE: move",
    "toward the others only where their reasons are better than yours; keep your view where yours is.",
    "Forecast AS OF the evidence cutoff; nothing after it exists.",
    answerInstruction(spec, contract),
    'Reply with ONE JSON object: {"answer": <as above>, "confidence": <0..1>,' +
      `${spec.type === "number" ? ' "sd": <number>,' : ""}${"options" in spec && (spec as { probabilities?: boolean }).probabilities ? ' "probabilities": {<option id>: <0..1>, …},' : ""} "reason": "<two sentences: what you kept or changed and why>"}.`,
  ].join("\n");
}

function baseUser(req: TypedForecastRequest, cutoff: string, evidence: string): string {
  return [
    `Question: ${req.question}`,
    req.context ? `Notes: ${clip(req.context, 3_000)}` : "",
    req.contract ? contractInstruction(req.contract) : "",
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

/**
 * The catalogue's delphi template over the usable runs: `f1 … fn` are round
 * one (seeded), `summary` the anonymous panel, `v1 … vn` one revision each
 * (asked of the run's own part, in parallel), `combine` the pure combiner.
 */
async function delphi(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  first: TypedForecastAnswer,
  usable: TypedRun[],
  evidence: string,
): Promise<FormedAnswer> {
  const spec = req.answer;
  const members = usable.map((run, i) => memberFor(deps.analysts, run, i));
  const summary = panelSummary(spec, usable);
  const system = reviseSystem(spec, req.contract);
  const revisions: Array<FormationStep & { value?: AnswerValue }> = [];
  let formed: FormedAnswer | undefined;
  const score = typedScore("delphi", members);
  await runFormationScore(
    score,
    seeded(roundOneSeeds(usable), async ({ step }) => {
      if (step.id === "summary") return summary;
      if (step.id === "combine") {
        formed = combineRevisions(spec, first, revisions);
        return formed.formatted ?? "(no answer)";
      }
      const i = instance(step.id, "v");
      const run = usable[i]!;
      const member = members[i]!;
      const user = `${baseUser(req, first.cutoff.at, evidence)}\n\nYOUR EARLIER ANSWER: ${describeRun(spec, run)}${run.reason ? `\nYour reason: ${clip(run.reason, 300)}` : ""}\n\nTHE PANEL (anonymous):\n${summary}`;
      const { reply, error } = await askAnalyst(member, system, user);
      revisions[i] =
        error !== undefined
          ? { member: member.name, error: error.slice(0, 160) }
          : { ...readReply(spec, reply), member: member.name };
      return revisions[i]!.formatted ?? revisions[i]!.error ?? "";
    }),
  );
  return formed!;
}

/** Delphi's combine step: the revisions through the catalogue's pure combiner. */
function combineRevisions(
  spec: AnswerSpec,
  first: TypedForecastAnswer,
  revisions: Array<FormationStep & { value?: AnswerValue }>,
): FormedAnswer {
  const ok = revisions.filter((r) => r.formatted !== undefined) as Array<
    FormationStep & { value: AnswerValue }
  >;
  const record: FormationRecord = { pattern: "delphi", revisions: revisions.map(stripValue) };
  if (ok.length === 0) return { ...first, formation: { ...record, fallback: "no revision" } };
  return Object.assign({ ...first, formation: record }, combineDelphi(spec, ok));
}

// ─── Tournament ──────────────────────────────────────────────────────────────

const MATCH_SYSTEM = [
  "You referee a forecasting match. Two anonymous forecasts (A and B) answer the same question from the same research.",
  "Pick the one more likely to score better under a proper scoring rule: grounded in the research, consistent with the",
  "resolution rules, calibrated (not over- or under-confident). Ignore style and length.",
  'Reply with ONE JSON object: {"winner": "A" | "B", "reason": "<one sentence>"}.',
].join(" ");

/**
 * The catalogue's tournament template over the usable runs: a knockout
 * bracket (`knockout`), one referee step per match in play order (each match
 * waits for the one before: one referee, one match at a time), then the
 * champion through the pure combiner.
 */
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
  const entrants = usable.map((_, i) => `f${i + 1}`);
  const bracket = new Map(
    knockout(entrants, "m")
      .flat()
      .map((s) => [s.id, s]),
  );
  // Who holds each step: an entrant's run, a match's winner, a bye's runner.
  const holder = new Map<string, TypedRun>(entrants.map((id, i) => [id, usable[i]!]));
  let formed: FormedAnswer | undefined;
  const score = typedScore(
    "tournament",
    usable.map((run, i) => memberFor(deps.analysts, run, i)),
    referee,
  );
  await runFormationScore(
    score,
    seeded(roundOneSeeds(usable), async ({ step }) => {
      if (step.id === "combine") {
        const champ = holder.get(score.steps.at(-2)!.id)!;
        const { head, tail } = championAnswer(spec, champ, first.uncertainty?.sd);
        formed = Object.assign(
          {
            ...first,
            ...head,
            formation: { pattern: "tournament" as const, matches, champion: champ.run },
          },
          tail,
        );
        return formed.formatted ?? "(no answer)";
      }
      const slot = bracket.get(step.id)!;
      const a = holder.get(slot.a)!;
      if (!slot.b) {
        holder.set(slot.id, a); // a bye
        return a.formatted ?? "";
      }
      const b = holder.get(slot.b)!;
      const user = `${baseUser(req, first.cutoff.at, evidence)}\n\nFORECAST A: ${describeRun(spec, a)}\nReason A: ${clip(a.reason ?? "", 400)}\n\nFORECAST B: ${describeRun(spec, b)}\nReason B: ${clip(b.reason ?? "", 400)}`;
      const { reply, error } = await askAnalyst(referee, MATCH_SYSTEM, user);
      const { pick, winner: side } = matchWinner(reply);
      const winner = side === "b" ? b : a;
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
      holder.set(slot.id, winner);
      return winner.formatted ?? "";
    }),
  );
  return formed!;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The catalogue's typed template for these members (forecasters; referee/skeptic: the critic). */
export function typedScore(
  pattern: TypedFormation,
  members: ReadonlyArray<Pick<ModelPart, "name">>,
  judge?: Pick<ModelPart, "name">,
): Score {
  return formationScore(TYPED_TEMPLATES[pattern], {
    k: members.length,
    id: `forecast-${pattern}`,
    assign: (slot, i) =>
      slot === "forecaster"
        ? partAssignee(members[i]!.name)
        : slot !== "pipeline" && judge
          ? partAssignee(judge.name)
          : TYPED_PIPELINE_ASSIGNEE,
  });
}

/** Round one is done by the pipeline: its research and its runs seed the Score. */
function roundOneSeeds(runs: readonly TypedRun[]): Record<string, string> {
  return Object.fromEntries([
    ["research", "the typed pipeline's research round"],
    ...runs.map((r, i) => [`f${i + 1}`, r.formatted ?? ""]),
  ]);
}

/** The 0-based instance of a fanned step id (`v3` → 2). */
function instance(id: string, prefix: string): number {
  return Number(id.slice(prefix.length)) - 1;
}

function memberFor(analysts: ModelPart[], run: TypedRun, i: number): ModelPart {
  return analysts.find((a) => a.name === run.model) ?? analysts[i % analysts.length]!;
}

function stripValue(s: FormationStep & { value?: AnswerValue }): FormationStep {
  const { value: _v, ...rest } = s;
  return rest;
}
