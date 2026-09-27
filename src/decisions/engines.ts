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
 *
 * Optional by construction: with neither configured there are no engines and
 * the endpoint says so; nothing else in Marina depends on an engine existing.
 * An engine is never substituted silently — an unknown `model` is refused, and
 * every reply names the model that actually answered.
 */

import { classifierTuning, getDecisionProvider, metered } from "./config";
import { acceptsRequestedModel } from "./model-ids";
import { chatClassifierProvider } from "./providers";
import type { DecisionProvider } from "./types";

/** Engine id prefix for chat models answering through Marina's passthru. */
export const CLASSIFIER_ENGINE = "marina/classifier";
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

/** A chat model as a decision engine, answering through Marina's own `/v1`. */
function classifierEngine(
  model: string,
  env: NodeJS.ProcessEnv,
  deps: EngineDeps,
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
        method: tuning.method ?? "auto",
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
  // The upstream call is metered by the passthru itself; this adds the cap check.
  return metered(provider);
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
          "Decisions are disabled on this instance. Set MARINA_DECISIONS or MARINA_DECISION_ENGINES (see .env.example).",
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
  if (configured && (!model || acceptsRequestedModel(model, configured.model))) {
    return { provider: configured };
  }
  if (
    classifiers &&
    (!model || model === CLASSIFIER_ENGINE || model.startsWith(`${CLASSIFIER_ENGINE}:`))
  ) {
    const chat =
      !model || model === CLASSIFIER_ENGINE
        ? (classifiers.models[0] ?? DEFAULT_CLASSIFIER_MODEL)
        : model.slice(CLASSIFIER_ENGINE.length + 1).trim();
    if (chat && (classifiers.any || classifiers.models.includes(chat))) {
      return { provider: classifierEngine(chat, env, deps) };
    }
  }
  return {
    error: {
      status: 400,
      message: `No decision engine "${model}" on this instance; GET /v1/decisions/models lists them.`,
      code: "unsupported_parameter",
    },
  };
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
  return out;
}
