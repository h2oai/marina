// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision engines: what `POST /v1/systemone` (and `/v1/decisions`) answers
 * with, chosen by the request's `model`:
 *
 *   the configured backend   `MARINA_DECISIONS` — real Jev, TypeSafe, OpenJev
 *                            or a chat classifier (also answers when `model`
 *                            is omitted, or names its family's `-latest`)
 *   marina/classifier[:<m>]  a chat model answering as a decision model
 *                            THROUGH MARINA'S OWN PASSTHRU (internal token →
 *                            every provider and key Marina routes, its spend
 *                            ledger and provider fallback), with the
 *                            `MARINA_DECISION_METHOD` method (default auto:
 *                            logprobs where the provider returns them).
 *                            Opt-in per model: `MARINA_DECISION_ENGINES`.
 *   marina/ensemble          the engines listed in `MARINA_DECISION_ENSEMBLE`
 *                            asked in parallel, answers combined (combine.ts);
 *                            needs a majority to answer.
 *   marina/auto              the configured backend first; a second opinion
 *                            (the ensemble, else the first classifier engine)
 *                            only when it is unsure or down — Jev's speed and
 *                            price on the easy calls, resilience on the rest.
 *
 * Optional by construction: with neither configured there are no engines and
 * the endpoint says so; nothing else in Marina depends on an engine existing.
 * An engine is never substituted silently — an unknown `model` is refused, and
 * every reply names the model that actually answered.
 */

import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type { ClassifierMethod } from "./classifier-methods";
import { combineAnswers, unsureAnswers } from "./combine";
import { classifierTuning, getDecisionProvider } from "./config";
import { acceptsRequestedModel } from "./model-ids";
import { chatClassifierProvider } from "./providers";
import {
  DecisionError,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
} from "./types";

const logger = new Logger();

/** Engine id prefix for chat models answering through Marina's passthru. */
export const CLASSIFIER_ENGINE = "marina/classifier";
export const ENSEMBLE_ENGINE = "marina/ensemble";
export const AUTO_ENGINE = "marina/auto";
/** What bare `marina/classifier` uses when no model is listed: Marina's default upstream. */
const DEFAULT_CLASSIFIER_MODEL = "marina/default";
/** A classifier through the self-proxy may take several calls (auto, sampled). */
const CLASSIFIER_TIMEOUT_MS = 15_000;

export interface EngineDeps {
  /** Marina's own `/v1` (default `http://localhost:$WS_PORT/v1`). */
  selfBaseUrl?: string;
  /** Bearer for the self-proxy (default: the process internal model token). */
  token?: () => Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface EngineInfo {
  id: string;
  kind: string;
  calibrated: boolean;
  description: string;
}

/** `MARINA_DECISION_ENGINES`: the chat models allowed, `*` for any (undefined ⇒ none). */
export function classifierEngineModels(
  env: NodeJS.ProcessEnv = process.env,
): { any: boolean; models: string[] } | undefined {
  const raw = env.MARINA_DECISION_ENGINES?.trim();
  if (!raw || raw.toLowerCase() === "off" || raw.toLowerCase() === "none") return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { any: items.includes("*"), models: items.filter((m) => m !== "*") };
}

function selfBaseUrl(env: NodeJS.ProcessEnv): string {
  return `http://localhost:${Number(env.WS_PORT) || 3300}/v1`;
}

async function internalToken(): Promise<string> {
  // Lazy: the agent runtime is heavy, and only a classifier engine needs it.
  const { getInternalModelToken } = await import("../agent/agent-runtime");
  return getInternalModelToken();
}

/**
 * A chat model as a decision engine, answering through Marina's own `/v1`.
 * `method` overrides `MARINA_DECISION_METHOD` (`verbalized` is exactly one
 * call per request, every question answered in it).
 */
export function classifierEngine(
  model: string,
  env: NodeJS.ProcessEnv,
  deps: EngineDeps,
  method?: ClassifierMethod,
): DecisionProvider {
  const tuning = classifierTuning(env);
  const id = `${CLASSIFIER_ENGINE}:${model}`;
  let inner: DecisionProvider | undefined;
  const provider: DecisionProvider = {
    kind: "marina-classifier",
    model: id,
    calibrated: false,
    async ask(request, signal) {
      inner ??= chatClassifierProvider({
        baseUrl: deps.selfBaseUrl ?? selfBaseUrl(env),
        model,
        apiKey: await (deps.token ?? internalToken)(),
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        method: method ?? tuning.method ?? "auto",
        structured: true,
        ...(tuning.samples === undefined ? {} : { samples: tuning.samples }),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      const result = await inner.ask(request, signal);
      // Name the model that ACTUALLY answered (the passthru may fall back).
      return {
        ...result,
        model: `${CLASSIFIER_ENGINE}:${result.model}`,
        provider: "marina-classifier",
      };
    },
  };
  // The passthru hop records the upstream spend itself, so this checks the cap
  // but never records the reported cost a second time.
  return {
    ...provider,
    async ask(request, signal) {
      const capped = dailyCapRefusal();
      if (capped) throw new DecisionError(capped, "spend_cap", 429);
      return provider.ask(request, signal);
    },
  };
}

export type EngineResolution =
  | { provider: DecisionProvider }
  | {
      error: {
        status: number;
        message: string;
        code: "decisions_disabled" | "unsupported_parameter";
      };
    };

type EngineError = Extract<EngineResolution, { error: unknown }>["error"];
const unknownEngine = (model: string | undefined): EngineError => ({
  status: 400,
  message: `No decision engine "${model}" on this instance; GET /v1/decisions/models lists them.`,
  code: "unsupported_parameter",
});

/** The configured backend or a classifier engine (never a composite). */
function resolveBase(
  model: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: EngineDeps,
): DecisionProvider | undefined {
  const configured = getDecisionProvider(env);
  const classifiers = classifierEngineModels(env);
  if (configured && (!model || acceptsRequestedModel(model, configured.model))) return configured;
  if (
    classifiers &&
    (!model || model === CLASSIFIER_ENGINE || model.startsWith(`${CLASSIFIER_ENGINE}:`))
  ) {
    const chat =
      !model || model === CLASSIFIER_ENGINE
        ? (classifiers.models[0] ?? DEFAULT_CLASSIFIER_MODEL)
        : model.slice(CLASSIFIER_ENGINE.length + 1).trim();
    if (chat && (classifiers.any || classifiers.models.includes(chat))) {
      return classifierEngine(chat, env, deps);
    }
  }
  return undefined;
}

/** `MARINA_DECISION_ENSEMBLE`: ≥ 2 distinct member engine ids (never a composite). */
export function ensembleMembers(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const ids = [
    ...new Set(
      (env.MARINA_DECISION_ENSEMBLE ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== ENSEMBLE_ENGINE && s !== AUTO_ENGINE),
    ),
  ];
  return ids.length >= 2 ? ids : undefined;
}

const sum = (xs: Array<number | undefined>) => {
  const known = xs.filter((x): x is number => x !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
};

/**
 * Several engines asked in parallel, answers combined. The members that
 * answered are combined; the ensemble fails only when every member fails.
 * When the caller's `signal` aborts (a deadline) while some members have
 * answered, those are combined at once (`partial`) and the stragglers are
 * aborted by the same signal. Calibrated only if every member is. Spend is
 * recorded by each member where it is spent, never here.
 */
export function ensembleEngine(members: DecisionProvider[]): DecisionProvider {
  return {
    kind: "marina-ensemble",
    model: ENSEMBLE_ENGINE,
    calibrated: members.every((m) => m.calibrated !== false),
    async ask(request, signal) {
      const started = performance.now();
      const answers: Array<Answered | undefined> = members.map(() => undefined);
      const settled = Promise.allSettled(
        members.map((m, i) =>
          m.ask(request, signal).then((result) => {
            answers[i] = { result, provider: m };
            return result;
          }),
        ),
      );
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<"aborted">((resolve) => {
        if (!signal) return;
        onAbort = () => resolve("aborted");
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      let outcome: PromiseSettledResult<DecisionResult>[] | "aborted";
      try {
        outcome = await Promise.race([settled, aborted]);
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
      const answered = answers.filter((a): a is Answered => a !== undefined);
      // A failed member is left out (`members` names who answered).
      if (answered.length === 0) {
        if (outcome === "aborted") {
          throw signal?.reason ?? new DecisionError("ensemble aborted", "timeout", 504);
        }
        throw (outcome.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
      }
      return {
        ...combined(request.questions, answered, "ensemble", started),
        ...(outcome === "aborted" && answered.length < members.length ? { partial: true } : {}),
      };
    },
  };
}

interface Answered {
  result: DecisionResult;
  provider: DecisionProvider;
}

function combined(
  questions: Parameters<typeof combineAnswers>[0],
  answered: Answered[],
  method: "ensemble" | "cascade",
  started: number,
): DecisionResult {
  const cost = sum(answered.map((a) => a.result.costUsd));
  return {
    answers:
      answered.length === 1
        ? answered[0]!.result.answers
        : combineAnswers(
            questions,
            answered.map((a) => a.result.answers),
          ),
    model: method === "ensemble" ? ENSEMBLE_ENGINE : AUTO_ENGINE,
    provider: method === "ensemble" ? "marina-ensemble" : "marina-auto",
    method,
    members: answered.map((a) => a.result.model),
    // Calibrated only if everyone who actually answered is.
    calibrated: answered.every((a) => (a.result.calibrated ?? a.provider.calibrated) !== false),
    latencyMs: Math.round(performance.now() - started),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

/** The default bound on a second opinion the primary's answer can stand without. */
export const SECOND_OPINION_TIMEOUT_MS = 3_000;

/**
 * `MARINA_DECISION_SECOND_OPINION_TIMEOUT_MS`: how long `marina/auto` waits for
 * a second opinion before the primary's answer stands. `0` = no bound; unset or
 * junk ⇒ {@link SECOND_OPINION_TIMEOUT_MS}.
 */
export function secondOpinionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_DECISION_SECOND_OPINION_TIMEOUT_MS?.trim();
  if (!raw) return SECOND_OPINION_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : SECOND_OPINION_TIMEOUT_MS;
}

/**
 * After a second opinion's deadline aborts it, how long a composite gets to
 * settle with the members that already answered (the ensemble does so at once).
 */
const DEADLINE_SETTLE_MS = 100;

/**
 * Ask `provider` within `ms` (0 = no bound). At the deadline the in-flight
 * request is aborted; a provider that then settles at once with an answer (the
 * ensemble, with the members that had answered) is returned, otherwise
 * `"timeout"`. The caller's own `signal` still aborts it too.
 */
async function askWithin(
  provider: DecisionProvider,
  request: DecisionRequest,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<DecisionResult | "timeout"> {
  if (ms <= 0) return provider.ask(request, signal);
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const pending = provider.ask(request, controller.signal);
  // Observed below or abandoned at the settle bound; never an unhandled rejection.
  pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const after = (wait: number) =>
    new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), wait);
    });
  try {
    const first = await Promise.race([pending, after(ms)]);
    if (first !== "deadline") return first;
    clearTimeout(timer);
    controller.abort(new DecisionError("second opinion deadline", "timeout", 504));
    try {
      const settled = await Promise.race([pending, after(DEADLINE_SETTLE_MS)]);
      return settled === "deadline" ? "timeout" : settled;
    } catch {
      return "timeout";
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

/**
 * The configured backend first; the fallback only when the primary's answers
 * call for it — an unsure answer (see `UNSURE`) that, when the caller gives
 * `request.escalate`, could also change the caller's verdict — or when the
 * primary failed. Escalated ⇒ both
 * answers combined, the second opinion bounded by `secondOpinionMs` (on
 * timeout or failure the primary's answer stands). Failed ⇒ the fallback alone,
 * WITHOUT the short bound: it is then the only judge, and cutting it short
 * would turn an outage into a fail-closed block. The fallback failing too
 * rethrows the primary's error, so a caller's own failure rule (the gate fails
 * closed) still applies.
 */
export function autoEngine(
  primary: DecisionProvider,
  fallback: DecisionProvider,
  secondOpinionMs: number,
): DecisionProvider {
  return {
    kind: "marina-auto",
    model: AUTO_ENGINE,
    calibrated: primary.calibrated !== false && fallback.calibrated !== false,
    async ask(request, signal) {
      const started = performance.now();
      let first: DecisionResult;
      try {
        first = await primary.ask(request, signal);
      } catch (primaryErr) {
        try {
          const second = await fallback.ask(request, signal);
          return {
            ...combined(
              request.questions,
              [{ result: second, provider: fallback }],
              "cascade",
              started,
            ),
            escalated: true,
            secondOpinion: "outage",
          };
        } catch {
          throw primaryErr;
        }
      }
      const alone = [{ result: first, provider: primary }];
      const firstCalibrated = (first.calibrated ?? primary.calibrated) !== false;
      // The caller's boundary only NARROWS the generic test: a sure primary is
      // never second-guessed (that could soften a confident verdict).
      const escalate =
        unsureAnswers(request.questions, first.answers).length > 0 &&
        (request.escalate?.(first.answers, firstCalibrated) ?? true);
      if (!escalate) {
        return { ...combined(request.questions, alone, "cascade", started), escalated: false };
      }
      let second: DecisionResult | "timeout";
      try {
        second = await askWithin(fallback, request, signal, secondOpinionMs);
      } catch {
        // The second opinion failed: the primary's answer stands.
        return {
          ...combined(request.questions, alone, "cascade", started),
          escalated: true,
          secondOpinion: "failed",
        };
      }
      if (second === "timeout") {
        return {
          ...combined(request.questions, alone, "cascade", started),
          escalated: true,
          secondOpinion: "timeout",
        };
      }
      return {
        ...combined(
          request.questions,
          [...alone, { result: second, provider: fallback }],
          "cascade",
          started,
        ),
        escalated: true,
        secondOpinion: second.partial ? "partial" : "used",
      };
    },
  };
}

/**
 * The engine for a request's `model` (undefined ⇒ the configured backend, else
 * the default classifier engine when one is allowed).
 */
export function resolveEngine(
  requested: unknown,
  env: NodeJS.ProcessEnv = process.env,
  deps: EngineDeps = {},
): EngineResolution {
  const configured = getDecisionProvider(env);
  const classifiers = classifierEngineModels(env);
  if (!configured && !classifiers) {
    return {
      error: {
        status: 404,
        message:
          "Decisions are disabled on this instance. Set MARINA_DECISIONS or MARINA_DECISION_ENGINES (see config/environment.reference).",
        code: "decisions_disabled",
      },
    };
  }
  if (requested !== undefined && typeof requested !== "string") {
    return {
      error: { status: 400, message: "model must be a string.", code: "unsupported_parameter" },
    };
  }
  const model = requested?.trim();
  if (model === ENSEMBLE_ENGINE) {
    const ensemble = buildEnsemble(env, deps);
    return "error" in ensemble ? ensemble : { provider: ensemble.provider };
  }
  if (model === AUTO_ENGINE) {
    const fallback = autoFallback(env, deps);
    if (!configured || !fallback) return { error: unknownEngine(model) };
    return { provider: autoEngine(configured, fallback, secondOpinionTimeoutMs(env)) };
  }
  const base = resolveBase(model, env, deps);
  return base ? { provider: base } : { error: unknownEngine(model) };
}

function buildEnsemble(env: NodeJS.ProcessEnv, deps: EngineDeps): EngineResolution {
  const ids = ensembleMembers(env);
  if (!ids) return { error: unknownEngine(ENSEMBLE_ENGINE) };
  const members: DecisionProvider[] = [];
  for (const id of ids) {
    const member = resolveBase(id, env, deps);
    if (!member) {
      return {
        error: {
          status: 400,
          message: `MARINA_DECISION_ENSEMBLE member "${id}" is not an engine on this instance.`,
          code: "unsupported_parameter",
        },
      };
    }
    members.push(member);
  }
  return { provider: ensembleEngine(members) };
}

/** `marina/auto`'s second opinion: the ensemble when configured, else the first classifier engine. */
function autoFallback(env: NodeJS.ProcessEnv, deps: EngineDeps): DecisionProvider | undefined {
  const ensemble = ensembleMembers(env) ? buildEnsemble(env, deps) : undefined;
  if (ensemble && "provider" in ensemble) return ensemble.provider;
  const classifiers = classifierEngineModels(env);
  if (!classifiers) return undefined;
  return classifierEngine(classifiers.models[0] ?? DEFAULT_CLASSIFIER_MODEL, env, deps);
}

/** The engines this instance serves (for `GET /v1/decisions/models`). */
export function listEngines(env: NodeJS.ProcessEnv = process.env): EngineInfo[] {
  const out: EngineInfo[] = [];
  const configured = getDecisionProvider(env);
  if (configured) {
    out.push({
      id: configured.model,
      kind: configured.kind,
      calibrated: configured.calibrated !== false,
      description: "The configured decision backend (MARINA_DECISIONS); the default.",
    });
  }
  const classifiers = classifierEngineModels(env);
  if (classifiers) {
    const method = classifierTuning(env).method ?? "auto";
    const models = classifiers.models.length > 0 ? classifiers.models : [DEFAULT_CLASSIFIER_MODEL];
    for (const m of models) {
      out.push({
        id: `${CLASSIFIER_ENGINE}:${m}`,
        kind: "marina-classifier",
        calibrated: false,
        description: `${m} answering through Marina's passthru (method ${method}).`,
      });
    }
    if (classifiers.any) {
      out.push({
        id: `${CLASSIFIER_ENGINE}:<model>`,
        kind: "marina-classifier",
        calibrated: false,
        description: `Any model Marina routes, answering through its passthru (method ${method}).`,
      });
    }
  }
  const members = ensembleMembers(env);
  const ensemble = members ? buildEnsemble(env, {}) : undefined;
  if (ensemble && "provider" in ensemble) {
    out.push({
      id: ENSEMBLE_ENGINE,
      kind: "marina-ensemble",
      calibrated: ensemble.provider.calibrated !== false,
      description: `${members!.join(" + ")}, answers combined.`,
    });
  }
  const fallback = autoFallback(env, {});
  if (configured && fallback) {
    out.push({
      id: AUTO_ENGINE,
      kind: "marina-auto",
      calibrated: configured.calibrated !== false && fallback.calibrated !== false,
      description: `${configured.model}; ${fallback.model} as a second opinion when it is unsure or down.`,
    });
  }
  return out;
}

// ─── Marina's own harness ────────────────────────────────────────────────────

let warnedEngine: string | undefined;

/**
 * The decision provider Marina's OWN harness uses — the tool gate, spawn-time
 * routing, the task verifier and the `decision` commands. By default the
 * configured backend (`MARINA_DECISIONS`), exactly as before.
 * `MARINA_DECISION_ENGINE=<engine id>` opts the harness into an engine, e.g.
 * `marina/auto` (Jev first, a second opinion only when it is unsure or down).
 *
 * Operator note: with `marina/auto` a primary OUTAGE is answered by the
 * fallback instead of failing — for the gate, "outage ⇒ block" becomes
 * "outage ⇒ the fallback judges" (a chat classifier: one cut, holds go to a
 * person). Both failing still blocks. An engine id that does not resolve is
 * logged once and the configured backend is used, never nothing.
 */
export function harnessDecisionProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: EngineDeps = {},
): DecisionProvider | undefined {
  const configured = getDecisionProvider(env);
  const id = env.MARINA_DECISION_ENGINE?.trim();
  if (!id) return configured;
  const r = resolveEngine(id, env, deps);
  if ("provider" in r) return r.provider;
  if (warnedEngine !== id) {
    warnedEngine = id;
    logger.warn(
      "decisions",
      "MARINA_DECISION_ENGINE does not resolve; using the configured backend",
      {
        engine: id,
        error: r.error.message,
      },
    );
  }
  return configured;
}

/** The agent tool gate is on: `MARINA_DECISION_GATE=on` and a harness provider exists. */
export function harnessGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_DECISION_GATE?.trim().toLowerCase() === "on" && !!harnessDecisionProvider(env);
}
