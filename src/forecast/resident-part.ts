// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Residents as forecast parts: a `ModelPart` (`(system, user) → string`, the
 * seam every typed-forecast stage goes through) that asks a Marina resident
 * instead of a bare model, so the analyst answers with its own tools, memory
 * and lessons — under the as-of fence when the forecast has a past cutoff.
 *
 *   marina:<crew>  the crew serving that endpoint (its outward face, as `/v1`)
 *   role:<r>       the live resident with that role and the highest standing
 *                  (the rule `conduct resolve` uses)
 *
 * Inside the server the part dispatches in-process (`attachResidentDispatcher`,
 * wired at boot to `src/net/model-api/resident-dispatch.ts`); a command-line
 * process falls back to `marina:<crew>` over HTTP (MARINA_FORECAST_MARINA_URL /
 * _KEY), sending the fence (`x-marina-asof`) and deadline and reading back who
 * answered (`x-marina-respondent`). `role:` needs the server.
 *
 * Every call records which resident answered (`calls`), so the filing can
 * name its producers; passes the deadline (the forecast's remaining budget,
 * capped per call) so a crew returns its best draft rather than nothing;
 * joins the forecast's trace (`src/model` trace context); runs through the
 * forecast's `WorkBudget` (calls, concurrency, wall clock) and `SpendGuard`;
 * and refuses to run a measurement without the fence.
 *
 * Opt-in: `MARINA_FORECAST_RESIDENTS=on`. Off (the default) leaves
 * `modelPart` exactly as it was — `marina:` keeps its plain HTTP path.
 */

import type { WorkBudget } from "../coordination/work-budget";
import { getErrorMessage } from "../engine/errors";
import {
  ASOF_HEADER,
  currentEvidenceCutoff,
  currentEvidenceCutoffMs,
  RESPONDENT_HEADER,
  withEvidenceCutoff,
} from "../engine/evidence-fence";
import type { SpendGuard } from "../engine/spend-guard";
import { dailyCapRefusal } from "../engine/spend-ledger";
import {
  emitModelTrace,
  type ModelLifecycleEvent,
  type ModelTraceContext,
  newModelRequestId,
  traceContextAttributes,
} from "../model/trace";
import {
  chooseCutoff,
  type ModelPart,
  type TypedForecastDeps,
  type TypedForecastRequest,
} from "./typed";

/** The deadline header a `marina:` endpoint reads (`src/agent/budget-terminal.ts`). */
const DEADLINE_HEADER = "x-marina-deadline-ms";
/** One resident call never waits longer than this (a crew's own route timeout is 10 min). */
export const RESIDENT_CALL_MAX_MS = 600_000;

export { isResidentSpec, residentsMode } from "./resident-mode";

/** One question to a resident, in-process. */
export interface ResidentRequest {
  system: string;
  user: string;
  /** Answer before this many ms (the crew's best draft at the deadline). */
  deadlineMs?: number;
  /** The as-of fence (ISO), when the forecast has one. */
  evidenceCutoff?: string;
  /**
   * Which of several parallel slots asks (0-based): `role:<r>` rotates over
   * the role's residents by standing, so K slots are K residents when the
   * world has them.
   */
  slot?: number;
  /** Never route to this resident (the asker: its own command slot is busy waiting). */
  exclude?: string;
  signal?: AbortSignal;
}

export interface ResidentReply {
  text: string;
  /** The resident whose reply answered; absent for a forced draft with no author. */
  resident?: string;
  /** The routed request (`trace show <id>`). */
  requestId?: string;
  /** The answer was a draft forced at the deadline (`deadline`, `upstream_error`). */
  budgetForced?: string;
  /** What the resident's own turns cost, when they reported it. */
  costUsd?: number;
}

/** In-process dispatch to residents (the server wires one at boot). */
export interface ResidentDispatcher {
  ask(spec: string, request: ResidentRequest): Promise<ResidentReply>;
}

let dispatcher: ResidentDispatcher | undefined;

/** Attach the in-process dispatcher; returns the detach. */
export function attachResidentDispatcher(next: ResidentDispatcher): () => void {
  dispatcher = next;
  return () => {
    if (dispatcher === next) dispatcher = undefined;
  };
}

/** One resident call, as recorded on the part (and the forecast's audit trail). */
export interface ResidentCall {
  spec: string;
  resident?: string;
  requestId?: string;
  budgetForced?: string;
  costUsd?: number;
  ms: number;
  /** `in-process` (server) or `http` (a `marina:` endpoint from outside). */
  via: "in-process" | "http";
  /** The as-of fence the call ran under. */
  asOf?: string;
  error?: string;
}

export interface ResidentPartOptions {
  /** Shared call/concurrency/time admission for the whole forecast. */
  budget?: WorkBudget;
  /** The forecast's own spend scope: a call does not start once it is spent. */
  spend?: SpendGuard;
  /** Per-call deadline cap, ms (default RESIDENT_CALL_MAX_MS). */
  callDeadlineMs?: number;
  /** When the forecast must end (epoch ms): each call's deadline is what is left. */
  endsAt?: number;
  /** A measurement (backtest, `eval_mode`): refuse to run without the as-of fence. */
  requireFence?: boolean;
  /** Join the forecast's trace. */
  trace?: ModelTraceContext;
  /** Shared log (several parts of one forecast write one list). */
  calls?: ResidentCall[];
  /** A distinct name for this part (a Score slot); default the spec. */
  name?: string;
  /** The slot index (0-based) this part serves; see `ResidentRequest.slot`. */
  slot?: number;
  /** A resident never asked (the forecast's asker). */
  exclude?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the HTTP fallback. */
  fetch?: typeof fetch;
}

const RESIDENT = Symbol.for("marina.forecast.residentPart");

export type ResidentPart = ModelPart & {
  spec: string;
  calls: ResidentCall[];
  readonly [RESIDENT]: true;
};

/** True for a part made by {@link residentPart} (a resident answers it). */
export function isResidentPart(part: unknown): part is ResidentPart {
  return !!part && typeof part === "object" && (part as Record<symbol, unknown>)[RESIDENT] === true;
}

/** Slack before a cutoff counts as past for the fence (a live question's "now"). */
export const FENCE_PAST_SLACK_MS = 60_000;

/**
 * The cutoff a forecast's residents are fenced at: its evidence cutoff when
 * that is in the past by the real clock (a backtest, a re-run, a measured
 * question), else undefined — a live question about the future runs unfenced.
 */
export function residentFenceAt(cutoffAt: string, now = Date.now()): string | undefined {
  const at = Date.parse(cutoffAt);
  return Number.isFinite(at) && at < now - FENCE_PAST_SLACK_MS ? cutoffAt : undefined;
}

/**
 * A resident as a forecasting part. Throws only at call time (an unusable
 * spec, a missing server for `role:`, a measurement without the fence), so a
 * failed analyst drops out of the runs like any failed model.
 */
export function residentPart(spec: string, opts: ResidentPartOptions = {}): ResidentPart {
  const env = opts.env ?? process.env;
  const calls = opts.calls ?? [];
  const name = opts.name ?? spec;
  return {
    name,
    spec,
    calls,
    [RESIDENT]: true,
    complete: async (system, user) => {
      const asOf = currentEvidenceCutoff();
      if (opts.requireFence && !asOf) {
        throw new Error(
          `${spec}: a measured forecast needs the as-of fence before a resident may answer (give it asOf/endTime in the past)`,
        );
      }
      const stop = opts.spend?.stopReason() ?? dailyCapRefusal(env);
      if (stop) throw new Error(`${spec}: ${stop}`);
      const left = opts.endsAt !== undefined ? opts.endsAt - Date.now() : Number.POSITIVE_INFINITY;
      const deadlineMs = Math.max(
        1_000,
        Math.floor(Math.min(opts.callDeadlineMs ?? RESIDENT_CALL_MAX_MS, left)),
      );
      const traceId = opts.trace?.traceId ?? newModelRequestId();
      const spanRequest = newModelRequestId();
      const started = Date.now();
      const lifecycle = (
        phase: ModelLifecycleEvent["phase"],
        extra: Partial<ModelLifecycleEvent> = {},
      ): ModelLifecycleEvent => {
        const attrs = traceContextAttributes(opts.trace);
        return {
          type: "model_request_lifecycle",
          phase,
          requestId: spanRequest,
          runId: traceId,
          traceId,
          spanId: `span-${spanRequest}`,
          ...(opts.trace?.parentSpanId ? { parentSpanId: opts.trace.parentSpanId } : {}),
          model: spec,
          routeKind: "agent",
          purpose: "forecast",
          ...(attrs ? { traceContext: attrs } : {}),
          timestamp: Date.now(),
          ...extra,
        };
      };
      emitModelTrace(lifecycle("received", { timestamp: started }));
      const via = dispatcher ? "in-process" : "http";
      const run = (signal?: AbortSignal) =>
        dispatcher
          ? dispatcher.ask(spec, {
              system,
              user,
              deadlineMs,
              ...(asOf ? { evidenceCutoff: asOf } : {}),
              ...(opts.slot !== undefined ? { slot: opts.slot } : {}),
              ...(opts.exclude ? { exclude: opts.exclude } : {}),
              ...(signal ? { signal } : {}),
            })
          : httpAsk(
              spec,
              { system, user, deadlineMs, ...(asOf ? { evidenceCutoff: asOf } : {}) },
              env,
              opts.fetch,
              signal,
            );
      try {
        const reply = opts.budget ? await opts.budget.run(run) : await run();
        opts.spend?.record(reply.costUsd);
        calls.push({
          spec,
          ...(reply.resident ? { resident: reply.resident } : {}),
          ...(reply.requestId ? { requestId: reply.requestId } : {}),
          ...(reply.budgetForced ? { budgetForced: reply.budgetForced } : {}),
          ...(reply.costUsd !== undefined ? { costUsd: reply.costUsd } : {}),
          ms: Date.now() - started,
          via,
          ...(asOf ? { asOf } : {}),
        });
        emitModelTrace(
          lifecycle("completed", {
            ...(reply.resident ? { target: reply.resident } : {}),
            durationMs: Date.now() - started,
            ...(reply.costUsd !== undefined ? { costUsd: reply.costUsd } : {}),
            ...(reply.requestId ? { detail: `resident request ${reply.requestId}` } : {}),
          }),
        );
        return reply.text;
      } catch (error) {
        const message = getErrorMessage(error);
        calls.push({
          spec,
          ms: Date.now() - started,
          via,
          ...(asOf ? { asOf } : {}),
          error: message.slice(0, 200),
        });
        emitModelTrace(
          lifecycle("failed", { durationMs: Date.now() - started, detail: message.slice(0, 200) }),
        );
        throw error;
      }
    },
  };
}

/**
 * `marina:<crew>` over HTTP from outside the server: the operator's endpoint
 * (MARINA_FORECAST_MARINA_URL, never a request's), with the fence and the
 * deadline as headers and the responder read back from `x-marina-respondent`.
 */
async function httpAsk(
  spec: string,
  request: ResidentRequest,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ResidentReply> {
  if (!spec.startsWith("marina:")) {
    throw new Error(
      `${spec}: role: analysts run inside the Marina server (use marina:<crew> here)`,
    );
  }
  const url = (env.MARINA_FORECAST_MARINA_URL?.trim() || "http://localhost:3300").replace(
    /\/+$/,
    "",
  );
  const key = env.MARINA_FORECAST_MARINA_KEY?.trim();
  const res = await fetcher(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(request.deadlineMs ? { [DEADLINE_HEADER]: String(request.deadlineMs) } : {}),
      ...(request.evidenceCutoff ? { [ASOF_HEADER]: request.evidenceCutoff } : {}),
    },
    body: JSON.stringify({
      model: spec,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(RESIDENT_CALL_MAX_MS + 60_000)])
      : AbortSignal.timeout(RESIDENT_CALL_MAX_MS + 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${spec} HTTP ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null } }> };
  const resident = res.headers.get(RESPONDENT_HEADER)?.trim();
  const requestId = res.headers.get("x-request-id")?.trim();
  const forced = res.headers.get("x-marina-budget-forced")?.trim();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    ...(resident ? { resident } : {}),
    ...(requestId ? { requestId } : {}),
    ...(forced ? { budgetForced: forced } : {}),
  };
}

/** The distinct residents that answered, in first-answer order (a filing's producers). */
export function residentProducers(calls: readonly ResidentCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) if (c.resident && !out.includes(c.resident)) out.push(c.resident);
  return out;
}

/**
 * The as-of fence hook of `forecastTyped` / `forecastFormed`: when any part of
 * `deps` is a resident and the forecast's cutoff is in the past, run `fn`
 * under that cutoff (everything the residents do is bounded by it) and return
 * its promise; otherwise undefined — the caller runs exactly as before.
 */
export function fencedForResidents<T>(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  fn: () => Promise<T>,
): Promise<T> | undefined {
  const parts = [deps.planner, deps.critic, deps.verifier, deps.arbiter, ...deps.analysts];
  if (!parts.some(isResidentPart)) return undefined;
  const fence = residentFenceAt(chooseCutoff(req, deps.now?.() ?? new Date()).at);
  if (!fence) return undefined;
  const outer = currentEvidenceCutoffMs();
  if (outer !== undefined && outer <= Date.parse(fence)) return undefined;
  return withEvidenceCutoff(fence, fn);
}
