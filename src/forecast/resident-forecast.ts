// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A forecast as a task, done by residents, run as a Score.
 *
 * `forecast <q> crew:<c> pattern:<p>` (and `POST /v1/forecast` with
 * `pattern`/`crew`/`role`) creates a world task and runs the typed formation
 * through the Score executor (`src/sdk/score-executor.ts`) with resident
 * dispatch (`./resident-part.ts`). The Score is the formation's catalogue
 * template (`src/orchestration/formations/catalogue.ts`, `TYPED_TEMPLATES`)
 * with its `forecaster` slot resolved to the assignee:
 *
 *   ensemble   research → f1 … fK (one resident each, in parallel) → combine
 *   delphi     research → f1 … fK → summary → v1 … vK (each revises once) → combine
 *   tournament research → f1 … fK → m1 … m(K-1) (knockout, refereed by the
 *              pipeline's critic) → combine
 *   skeptic    research → f1 (statistician), f2 (analyst) → skeptic (the
 *              pipeline's critic) → combine
 *
 * Step 0 is the typed pipeline's own research round (plan, retrieval, the
 * mechanical citation check, lookups); its dossier is what every resident
 * step reads, and residents may extend it with their own tools — within the
 * as-of fence when the cutoff is past or the forecast is measured. Combining
 * stays pure code (`forecastFormed`: the catalogue's combiners, the critique
 * rule, the answer contract, triage and the Arbiter are unchanged).
 *
 * How the pipeline and the Score meet: the formation runs as usual over K
 * slot parts; each slot's run (and, for delphi, its revision) is handed to
 * the Score step that owns it, which asks the resident and hands the answer
 * back. Anything else the pipeline asks a slot (a format repair, a crux run,
 * a follow-up re-run) is asked of the resident directly, under the same
 * budget. Steps the pipeline's own parts work (research, the referee's
 * matches, the skeptic, the combine) finish with the pipeline.
 *
 * Assignees are interchangeable: `role:<r>` and `marina:<crew>` are residents
 * (`residentPart`); `model:<id>` is a bare model through `src/model`
 * (`modelSlotPart`) in the same slot — same template, same combiner.
 *
 * Bounds: one `WorkBudget` (resident calls, concurrency, wall clock) and one
 * `SpendGuard` per forecast (`MARINA_FORECAST_RESIDENT_BUDGET_USD`); each
 * resident call's deadline is what is left of the forecast's, so a crew
 * answers with its best draft. Attribution: every resident's run is filed as
 * its own answer (owner = the resident, tagged `q:` / `method:` / `model:` /
 * `resident:`), so `resolveForecast` credits the resident that produced it.
 */

import { WorkBudget } from "../coordination/work-budget";
import { getErrorMessage } from "../engine/errors";
import { withEvidenceCutoff } from "../engine/evidence-fence";
import { SpendGuard } from "../engine/spend-guard";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { modelComplete } from "../model/complete";
import { TYPED_PIPELINE_ASSIGNEE, TYPED_TEMPLATES } from "../orchestration/formations/catalogue";
import { formationScore, membersFor } from "../orchestration/formations/template";
import type { MarinaDB } from "../persistence/database";
import type { Score } from "../sdk/score";
import { type DispatchContext, executeScore, type ScoreStepEvent } from "../sdk/score-executor";
import {
  type FormedAnswer,
  forecastFormed,
  TYPED_FORMATIONS,
  type TypedFormation,
} from "./formations";
import {
  type ResidentCall,
  type ResidentPart,
  type ResidentPartOptions,
  residentFenceAt,
  residentPart,
  residentProducers,
  residentsMode,
} from "./resident-part";
import {
  chooseCutoff,
  type ModelPart,
  type TypedForecastDeps,
  type TypedForecastRequest,
  type TypedRun,
} from "./typed";

/** Every typed formation runs with resident (or model) slots: the catalogue's typed templates. */
export const RESIDENT_PATTERNS = TYPED_FORMATIONS;
export type ResidentPattern = TypedFormation;

/** Residents asked per forecast by default (K) and the range allowed. */
export const RESIDENT_K_DEFAULT = 3;
const K_MAX = 7;
/** Default resident calls per forecast: K runs, K revisions, repairs and re-runs. */
export const RESIDENT_CALLS_DEFAULT = 24;
/** Default wall clock per resident forecast (ms). */
export const RESIDENT_TIMEOUT_MS_DEFAULT = 15 * 60_000;

/** The pure-code steps of a template (no resident). */
const PIPELINE = TYPED_PIPELINE_ASSIGNEE;

/** The residents a formation asks when K are wanted (the skeptic crew is always two). */
export function residentCount(pattern: ResidentPattern, k: number): number {
  return membersFor(TYPED_TEMPLATES[pattern], Math.max(1, Math.min(K_MAX, Math.round(k))));
}

/**
 * The Score a resident formation runs as: the catalogue's typed template with
 * its `forecaster` slot resolved to `assignee` (default `role:forecaster`);
 * every other slot is the pipeline (research, summaries, the critic's
 * referee and skeptic calls, the pure-code combine).
 */
export function residentForecastScore(
  pattern: ResidentPattern,
  k: number,
  assignee = "role:forecaster",
  id = `forecast-${pattern}`,
): Score {
  const n = residentCount(pattern, k);
  return formationScore(TYPED_TEMPLATES[pattern], {
    k: n,
    id,
    goal: `Resident forecast (${pattern}, ${n} residents)`,
    assign: (slot) => (slot === "forecaster" ? assignee : PIPELINE),
  });
}

// ─── Slots: where the pipeline's calls meet the Score's steps ────────────────

type CallKind = "run" | "revise";

interface PendingCall {
  system: string;
  user: string;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}

/** What a pipeline call to a slot is: a run, a Delphi revision, or anything else. */
function classify(system: string, user: string): CallKind | undefined {
  if (system.includes("(Delphi method)")) return "revise";
  if (user.includes("(Independent run ")) return "run";
  return undefined;
}

class Slot {
  private readonly queues: Record<CallKind, PendingCall[]> = { run: [], revise: [] };
  private readonly waiters: Record<CallKind, Array<(c: PendingCall | undefined) => void>> = {
    run: [],
    revise: [],
  };
  private readonly claimed: Record<CallKind, number> = { run: 0, revise: 0 };
  private closed = false;
  /** The residents that answered this slot's step calls, by kind. */
  readonly answeredBy: Partial<Record<CallKind, string>> = {};
  readonly part: ModelPart;

  constructor(
    readonly name: string,
    private readonly expected: Record<CallKind, number>,
    readonly resident: SlotPart,
    private readonly onCall: (kind: CallKind, user: string) => void,
  ) {
    this.part = {
      name,
      complete: (system, user) => {
        const kind = classify(system, user);
        if (!kind || this.closed || this.claimed[kind] >= this.expected[kind])
          return resident.complete(system, user);
        this.claimed[kind]++;
        this.onCall(kind, user);
        return new Promise<string>((resolve, reject) => {
          const call = { system, user, resolve, reject };
          const waiter = this.waiters[kind].shift();
          if (waiter) waiter(call);
          else this.queues[kind].push(call);
        });
      },
    };
  }

  /** The next call of `kind` for this slot's step, or undefined once the pipeline is done. */
  take(kind: CallKind): Promise<PendingCall | undefined> {
    const queued = this.queues[kind].shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters[kind].push(resolve));
  }

  /** The pipeline finished: steps still waiting get nothing; later calls go direct. */
  close(): void {
    this.closed = true;
    for (const kind of ["run", "revise"] as const) {
      for (const waiter of this.waiters[kind].splice(0)) waiter(undefined);
    }
  }
}

/** A promise with its resolver, settled once. */
function latch<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  let done = false;
  return {
    promise,
    resolve: (v) => {
      if (done) return;
      done = true;
      resolve(v);
    },
  };
}

// ─── Running one ─────────────────────────────────────────────────────────────

export interface ResidentForecastRequest {
  forecast: TypedForecastRequest;
  pattern: ResidentPattern;
  /**
   * `role:<r>` (resolved by standing), `marina:<crew>`, or `model:<id>` (a
   * bare model in the same slots); default `role:forecaster`.
   */
  assignee?: string;
  /** Residents asked (K), 1–7 (default 3; the skeptic crew always asks two). */
  k?: number;
  /** A measurement against a known outcome: the as-of fence is required and the filing is `measure`. */
  measure?: boolean;
}

export interface ResidentForecastBudget {
  calls?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** The forecast's own spend cap, USD (undefined = only the daily caps). */
  spendUsd?: number;
}

export interface ResidentStepRecord {
  step: string;
  assignee: string;
  resident?: string;
  status: "done" | "not-run" | "error";
  error?: string;
}

export interface ResidentForecastRecord {
  pattern: ResidentPattern;
  assignee: string;
  k: number;
  /** The as-of fence the residents ran under (ISO), when there was one. */
  fence?: string;
  measure: boolean;
  steps: ResidentStepRecord[];
  calls: ResidentCall[];
  producers: string[];
  budget: {
    calls: number;
    attempted: number;
    timeoutMs: number;
    spendUsd?: number;
    spentUsd: number;
  };
  error?: string;
}

export type ResidentFormedAnswer = FormedAnswer & { residents: ResidentForecastRecord };

/**
 * What works one Score slot: a resident part, or a model part in the same
 * place (`calls` stays empty: a model is never a producer).
 */
export type SlotPart = ModelPart & { spec: string; calls: ResidentCall[] };

/** Makes the part behind one Score slot. */
export type PartFactory = (spec: string, opts: ResidentPartOptions) => SlotPart | ResidentPart;

/**
 * A bare model in a resident slot (`model:<id>`): the shared model backend
 * (`src/model`), under the forecast's `WorkBudget` and `SpendGuard`. The
 * model is resolved at the first call, so an unusable id drops out of the
 * runs like any failed analyst.
 */
export function modelSlotPart(spec: string, opts: ResidentPartOptions = {}): SlotPart {
  const env = opts.env ?? process.env;
  let made: ReturnType<typeof modelComplete> | undefined;
  return {
    name: opts.name ?? spec,
    spec,
    calls: opts.calls ?? [],
    complete: async (system, user) => {
      const stop = opts.spend?.stopReason() ?? dailyCapRefusal(env);
      if (stop) throw new Error(`${spec}: ${stop}`);
      made ??= modelComplete(spec.slice("model:".length), env, {
        purpose: "forecast",
        trace: { caller: "forecast.resident", ...opts.trace },
      });
      const model = made;
      const before = model.usage.costUsd;
      const run = () => model.complete(system, user);
      try {
        return opts.budget ? await opts.budget.run(run) : await run();
      } finally {
        opts.spend?.record(model.usage.costUsd - before);
      }
    },
  };
}

/** The part for an assignee: `model:<id>` a model, anything else a resident. */
export function assigneePart(spec: string, opts: ResidentPartOptions): SlotPart | ResidentPart {
  return spec.startsWith("model:") ? modelSlotPart(spec, opts) : residentPart(spec, opts);
}

/**
 * Run a resident formation. `deps` is the ordinary typed wiring (retriever,
 * judge, lookups, planner/critic, lessons); its analysts are replaced by K
 * resident slots, and its planner/critic/verifier stay what they were (default:
 * its first analyst) — step 0 is the pipeline's own research.
 */
export async function runResidentForecast(
  req: ResidentForecastRequest,
  deps: TypedForecastDeps,
  budget: ResidentForecastBudget = {},
  opts: {
    env?: NodeJS.ProcessEnv;
    onStep?: (ev: ScoreStepEvent) => void;
    /** Test seam: make the resident part for slot i (default `residentPart`). */
    part?: PartFactory;
    traceId?: string;
    /** A resident never asked: the asker (its own command slot is busy waiting). */
    exclude?: string;
  } = {},
): Promise<ResidentFormedAnswer> {
  const env = opts.env ?? process.env;
  const assignee = req.assignee?.trim() || "role:forecaster";
  const k = residentCount(req.pattern, req.k ?? RESIDENT_K_DEFAULT);
  const measure = req.measure === true;
  const cutoff = chooseCutoff(req.forecast, deps.now?.() ?? new Date());
  // A measured forecast is always fenced at its cutoff; a live one only when the cutoff is past.
  const fence = measure ? cutoff.at : residentFenceAt(cutoff.at);
  const timeoutMs = Math.max(10_000, budget.timeoutMs ?? RESIDENT_TIMEOUT_MS_DEFAULT);
  const work = new WorkBudget({
    calls: Math.max(1, budget.calls ?? RESIDENT_CALLS_DEFAULT),
    concurrency: Math.max(1, budget.concurrency ?? k),
    timeoutMs,
  });
  const spend = new SpendGuard({
    label: "resident forecast budget",
    ...(budget.spendUsd !== undefined ? { budgetUsd: budget.spendUsd } : {}),
    concurrency: Math.max(1, budget.concurrency ?? k),
    env,
  });
  const started = Date.now();
  const endsAt = started + timeoutMs;
  const make = opts.part ?? assigneePart;
  const partOpts = {
    budget: work,
    spend,
    endsAt,
    requireFence: measure,
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    env,
    trace: {
      caller: "forecast.resident",
      ...(opts.traceId ? { traceId: opts.traceId } : {}),
      ...(req.forecast.id ? { questionId: req.forecast.id } : {}),
    },
  };
  const expected = { run: 1, revise: req.pattern === "delphi" ? 1 : 0 };
  const firstRun = latch<void>();
  const firstRevise = latch<string>();
  const slots = Array.from({ length: k }, (_, i) => {
    const name = `${assignee}#${i + 1}`;
    // Each slot keeps its own call log, so a step reads only its own resident.
    return new Slot(
      name,
      expected,
      make(assignee, { ...partOpts, name, slot: i, calls: [] }),
      (kind, user) => {
        if (kind === "run") firstRun.resolve();
        // Delphi: the summary step ends when the first revision is asked (it carries the panel).
        else firstRevise.resolve(panelOf(user));
      },
    );
  });
  // Planning, critique and checking stay with the pipeline's own parts.
  const pipelinePlanner = deps.planner ?? deps.analysts[0];
  const pipelineCritic = deps.critic ?? pipelinePlanner;
  const formedDeps: TypedForecastDeps = {
    ...deps,
    analysts: slots.map((s) => s.part),
    ...(pipelinePlanner ? { planner: pipelinePlanner } : {}),
    ...(pipelineCritic ? { critic: pipelineCritic } : {}),
    options: {
      ...deps.options,
      runs: k,
      // The pipeline's own budget-terminal answer lands before the Score's wall clock.
      budgetMs: Math.min(
        deps.options?.budgetMs ?? Number.POSITIVE_INFINITY,
        Math.floor(timeoutMs * 0.85),
      ),
    },
  };
  const score = residentForecastScore(req.pattern, k, assignee);
  const steps = new Map<string, ResidentStepRecord>(
    score.steps.map((s) => [s.id, { step: s.id, assignee: s.assignee, status: "not-run" }]),
  );

  return withEvidenceCutoff(fence, async () => {
    const pipeline = forecastFormed(req.forecast, formedDeps, req.pattern).finally(() => {
      for (const s of slots) s.close();
      firstRun.resolve();
      firstRevise.resolve("");
    });
    // allow-empty-catch: observed here; its outcome is awaited by the combine step and below
    pipeline.catch(() => undefined);

    const dispatch = async (ctx: DispatchContext): Promise<string> => {
      const id = ctx.step.id;
      const record = steps.get(id)!;
      if (id === "research") {
        await firstRun.promise;
        record.status = "done";
        return "research round finished; the dossier goes to every forecaster";
      }
      if (id === "summary") {
        const panel = await firstRevise.promise;
        record.status = panel ? "done" : "not-run";
        return panel || "(no revision round: fewer than two usable runs)";
      }
      if (id === "combine") {
        const answer = await pipeline;
        record.status = "done";
        return answer.formatted ?? "(no answer)";
      }
      if (ctx.step.assignee === PIPELINE) {
        // The pipeline's own parts work it (the referee's matches, the skeptic).
        // allow-empty-catch: the combine step surfaces a failed pipeline
        await pipeline.catch(() => undefined);
        record.status = "done";
        return "(worked by the pipeline's critic; see the answer's formation record)";
      }
      const kind: CallKind = id.startsWith("v") ? "revise" : "run";
      const slot = slots[Number(id.slice(1)) - 1]!;
      const call = await slot.take(kind);
      if (!call) return "(not asked: the formation did not reach this step)";
      const before = slot.resident.calls.length;
      try {
        const text = await slot.resident.complete(call.system, call.user);
        call.resolve(text);
        const who = slot.resident.calls.slice(before).find((c) => c.resident)?.resident;
        if (who) {
          record.resident = who;
          slot.answeredBy[kind] = who;
        }
        record.status = "done";
        return text;
      } catch (error) {
        call.reject(error);
        record.status = "error";
        record.error = getErrorMessage(error).slice(0, 200);
        // A failed resident drops out of the runs; the Score goes on.
        return `(error: ${record.error})`;
      }
    };

    let scoreError: string | undefined;
    try {
      await executeScore(score, dispatch, {
        concurrency: score.steps.length,
        timeoutMs: timeoutMs + 30_000,
        signal: work.signal,
        ...(opts.onStep ? { onStep: opts.onStep } : {}),
      });
    } catch (error) {
      scoreError = getErrorMessage(error).slice(0, 200);
      work.cancel(error);
    }
    const formed = await pipeline;
    attributeRuns(formed, slots);
    const calls: ResidentCall[] = slots.flatMap((s) => s.resident.calls);
    const snap = work.snapshot();
    return {
      ...formed,
      residents: {
        pattern: req.pattern,
        assignee,
        k,
        ...(fence ? { fence } : {}),
        measure,
        steps: [...steps.values()],
        calls,
        producers: residentProducers(calls),
        budget: {
          calls: snap.limits.calls,
          attempted: snap.attempted,
          timeoutMs,
          ...(budget.spendUsd !== undefined ? { spendUsd: budget.spendUsd } : {}),
          spentUsd: spend.spentUsd,
        },
        ...(scoreError ? { error: scoreError } : {}),
      },
    };
  });
}

/** The anonymous panel text a Delphi revision prompt carries. */
function panelOf(user: string): string {
  const at = user.indexOf("THE PANEL (anonymous):");
  return at >= 0 ? user.slice(at + "THE PANEL (anonymous):".length).trim() : "panel summarised";
}

/** Stamp each run (and Delphi revision) with the resident that produced it. */
function attributeRuns(answer: FormedAnswer, slots: Slot[]): void {
  const bySlot = new Map(slots.map((s) => [s.name, s]));
  const stamp = (run: TypedRun & { resident?: string }) => {
    const who = bySlot.get(run.model)?.answeredBy.run;
    if (who) run.resident = who;
  };
  for (const run of answer.runs) stamp(run);
  for (const run of answer.initialRuns ?? []) stamp(run);
  for (const rev of answer.formation.revisions ?? []) {
    const who = bySlot.get(rev.member)?.answeredBy.revise;
    if (who) (rev as typeof rev & { resident?: string }).resident = who;
  }
}

// ─── Filing ──────────────────────────────────────────────────────────────────

/** The `method:` a resident run is filed under. */
export function residentMethod(pattern: ResidentPattern): string {
  return `residents-${pattern}`;
}

/**
 * File every resident's own run as its own answer, linked to the combined
 * one (`parent`), owned by the resident (so `resolveForecast` credits it
 * through the producer mechanism, under the usual caps and independence rule)
 * and tagged `q:` / `method:` / `model:` / `resident:`. Returns the row ids.
 */
export function fileResidentRuns(
  db: Pick<MarinaDB, "saveForecastAnswer" | "getForecastAnswerByExternalId" | "getAgentConfig">,
  answer: ResidentFormedAnswer,
  link: { parentId?: number; questionId: string; sampleId?: string },
): number[] {
  const ids: number[] = [];
  const method = residentMethod(answer.residents.pattern);
  const spec = answer.answer;
  for (const run of answer.runs as Array<TypedRun & { resident?: string }>) {
    if (!run.resident || run.formatted === undefined || run.weight <= 0) continue;
    const externalId = `${link.questionId}#${run.resident}#run${run.run}`;
    const existing = db.getForecastAnswerByExternalId(run.resident, externalId);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const model = safeTag(db.getAgentConfig(run.resident)?.model);
    try {
      ids.push(
        db.saveForecastAnswer({
          entityName: run.resident,
          question: answer.question,
          kind: spec.type,
          ...(typeof run.value === "number" ? { mean: run.value } : {}),
          ...(typeof run.value === "number" && run.sd ? { sd: run.sd } : {}),
          prediction: run.formatted,
          answerJson: JSON.stringify({
            question: answer.question,
            answer: spec,
            prediction: run.value,
            formatted: run.formatted,
            ...(run.distribution ? { distribution: run.distribution } : {}),
            ...(run.sd ? { uncertainty: { sd: run.sd } } : {}),
            confidence: run.confidence,
            cutoff: answer.cutoff,
            ...(link.parentId !== undefined ? { parent: link.parentId } : {}),
            routing: {
              question: link.questionId,
              method,
              ...(model ? { model } : {}),
              resident: run.resident,
            },
            producers: [run.resident],
          }),
          ...(link.sampleId ? { sampleId: link.sampleId } : {}),
          source: "forecast-resident",
          externalId,
          // No eval mode on a live run: any eval mode (`live` included) never earns.
          ...(answer.residents.measure ? { evalMode: "measure" as const } : {}),
        }),
      );
    } catch {
      // Best-effort: the combined answer stands without the per-resident rows.
    }
  }
  return ids;
}

const SAFE_TAG = /^[A-Za-z0-9:._/+-]{1,120}$/;
function safeTag(v: string | undefined): string | undefined {
  return v && SAFE_TAG.test(v) ? v : undefined;
}

// ─── The task ────────────────────────────────────────────────────────────────

const intEnv = (v: string | undefined): number | undefined => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The per-forecast bounds from the environment. */
export function residentBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResidentForecastBudget {
  const calls = intEnv(env.MARINA_FORECAST_RESIDENT_CALLS);
  const timeoutS = intEnv(env.MARINA_FORECAST_RESIDENT_TIMEOUT_S);
  const spendUsd = intEnv(env.MARINA_FORECAST_RESIDENT_BUDGET_USD);
  return {
    ...(calls ? { calls: Math.floor(calls) } : {}),
    ...(timeoutS ? { timeoutMs: Math.floor(timeoutS * 1000) } : {}),
    ...(spendUsd ? { spendUsd } : {}),
  };
}

export interface ForecastTaskInput {
  request: ResidentForecastRequest;
  /** Who asked: the task's creator and the combined answer's owner. */
  filer: { id: string; name: string };
  /** Where the combined answer is filed (`command`, `api`, a board). */
  source?: string;
  /** The resolver Sample both the combined and the per-resident answers resolve on. */
  sampleId?: string;
}

export interface ForecastTaskResult {
  answer: ResidentFormedAnswer;
  taskId?: number;
  answerId?: number;
  residentAnswerIds: number[];
}

/**
 * `forecast … crew:|role:|pattern:` as a world task: create the task (value 0
 * — a forecast earns `forecast_resolved` when it resolves, not task credit),
 * run the resident formation, file the combined answer and every resident's
 * own run, and close the task. Needs `MARINA_FORECAST_RESIDENTS=on`.
 */
export async function forecastAsTask(
  input: ForecastTaskInput,
  deps: {
    db?: MarinaDB;
    env?: NodeJS.ProcessEnv;
    /** The typed wiring (default: `typedForecastDeps` from the environment). */
    typed?: { deps: TypedForecastDeps; costUsd: () => number };
    /** Test seam: the resident part factory. */
    part?: PartFactory;
  } = {},
): Promise<ForecastTaskResult | { error: string }> {
  const env = deps.env ?? process.env;
  if (residentsMode(env) !== "on")
    return { error: "Resident forecasts are off (set MARINA_FORECAST_RESIDENTS=on)." };
  const { request } = input;
  const measure = request.measure === true;
  let typed = deps.typed;
  if (!typed) {
    const [{ typedForecastDeps }, { forecastLessonsFor }] = await Promise.all([
      import("./service"),
      import("../learning/forecast-bridge"),
    ]);
    const made = typedForecastDeps(
      env,
      deps.db ? { lessons: forecastLessonsFor(deps.db, { env }) } : {},
    );
    if ("error" in made) return made;
    typed = made;
  }
  const db = deps.db;
  const score = residentForecastScore(
    request.pattern,
    request.k ?? RESIDENT_K_DEFAULT,
    request.assignee,
  );
  let taskId: number | undefined;
  if (db) {
    try {
      const { TaskManager } = await import("../coordination/task-manager");
      taskId = new TaskManager(db).create({
        title: `Forecast: ${request.forecast.question.slice(0, 100)}`,
        description: JSON.stringify({
          kind: "forecast",
          pattern: request.pattern,
          assignee: request.assignee ?? "role:forecaster",
          k: score.steps.filter((s) => /^f\d+$/.test(s.id)).length,
          eval_mode: measure ? "measure" : "live",
          ...(request.forecast.asOf ? { asOf: request.forecast.asOf } : {}),
          score: score.steps.map((s) => ({ id: s.id, assignee: s.assignee, access: s.access })),
        }),
        creatorId: input.filer.id,
        creatorName: input.filer.name,
        standing: 0,
      }).id;
      db.updateTaskStatus(taskId, "claimed");
    } catch {
      taskId = undefined;
    }
  }
  try {
    const answer = await runResidentForecast(request, typed.deps, residentBudgetFromEnv(env), {
      env,
      ...(deps.part ? { part: deps.part } : {}),
      ...(taskId !== undefined ? { traceId: `forecast-task-${taskId}` } : {}),
      exclude: input.filer.name,
    });
    answer.costUsd = typed.costUsd() + answer.residents.budget.spentUsd;
    const questionId = request.forecast.id ?? (taskId !== undefined ? `task:${taskId}` : undefined);
    let answerId: number | undefined;
    let residentAnswerIds: number[] = [];
    if (db) {
      try {
        answerId = db.saveForecastAnswer({
          entityName: input.filer.name,
          question: answer.question,
          kind: answer.answer.type,
          ...(typeof answer.prediction === "number" ? { mean: answer.prediction } : {}),
          ...(typeof answer.prediction === "number" && answer.uncertainty?.sd
            ? { sd: answer.uncertainty.sd }
            : {}),
          ...(answer.formatted !== undefined ? { prediction: answer.formatted } : {}),
          answerJson: JSON.stringify({
            ...answer,
            ...(taskId !== undefined ? { task: taskId } : {}),
          }),
          ...(input.sampleId ? { sampleId: input.sampleId } : {}),
          source: input.source ?? "command",
          ...(taskId !== undefined ? { externalId: `task:${taskId}` } : {}),
          ...(measure ? { evalMode: "measure" as const } : {}),
        });
      } catch {
        answerId = undefined;
      }
      if (questionId)
        residentAnswerIds = fileResidentRuns(db, answer, {
          ...(answerId !== undefined ? { parentId: answerId } : {}),
          questionId,
          ...(input.sampleId ? { sampleId: input.sampleId } : {}),
        });
      if (taskId !== undefined) {
        db.updateTaskProgress(taskId, 100);
        db.updateTaskStatus(taskId, answer.formatted !== undefined ? "completed" : "cancelled");
      }
    }
    return {
      answer,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(answerId !== undefined ? { answerId } : {}),
      residentAnswerIds,
    };
  } catch (error) {
    if (db && taskId !== undefined) db.updateTaskStatus(taskId, "cancelled");
    return { error: `Resident forecast failed: ${getErrorMessage(error)}` };
  }
}
