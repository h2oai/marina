// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision configuration, read from `process.env` on every call. OFF by
 * default: a decision backend receives tool arguments and request text, so
 * sending them to a third party is an explicit operator choice. Besides the
 * environment, an OPERATOR can change most of these at runtime through
 * `settings.ts` (`admin decisions set …` / Admin → Ops → Decisions: rank 5 +
 * `admin.destructive`, refused for any agent-driven entity, audited), which
 * writes the variable into `process.env`. A variable set in the boot
 * environment locks that setting; base URLs, paths and API keys
 * (`MARINA_DECISION_BASE_URL`, `_PATH`, `_API_KEY`) are env-only.
 *
 *   MARINA_DECISIONS           off (default) | decisions-api (alias jev) |
 *                              typesafe (TypeSafe's direct API) |
 *                              chat-classifier (alias classifier, llm)
 *   MARINA_DECISION_MODEL      backend model id. decisions-api default
 *                              `typesafe/jev-1.13` (pin a version; any Jev-family
 *                              or OpenJev id works). chat-classifier: default
 *                              openai/gpt-6-luna on OpenRouter,
 *                              zai-org/GLM-5.3-Flash on the Hugging Face router,
 *                              the runtime's default model on a configured local
 *                              runtime; required for any other base URL.
 *   MARINA_DECISION_BASE_URL   decisions-api default https://openrouter.ai/api/alpha
 *                              chat-classifier default: OpenRouter with its key,
 *                              else the Hugging Face router with its key, else a
 *                              configured local runtime (LLAMA_/OLLAMA_BASE_URL)
 *   MARINA_DECISION_API_KEY    bearer for the backend; falls back to
 *                              OPENROUTER_API_KEY only for openrouter.ai URLs
 *   MARINA_DECISION_PATH       Decisions API path; default /decisions (typesafe: /v1/systemone)
 *   MARINA_DECISION_TIMEOUT_MS per call; default 2000 (decisions-api) / 8000
 *   MARINA_DECISION_GATE       on | off (default off) — score mutating agent
 *                              tool calls before they run (fail-closed)
 *   MARINA_DECISION_METHOD     chat classifiers: auto | logprobs | sampled |
 *                              verbalized (see classifier-methods.ts). Unset:
 *                              the configured chat-classifier backend keeps its
 *                              original verbalized answers; `marina/classifier`
 *                              engines use auto.
 *   MARINA_DECISION_SAMPLES    calls per decision for `sampled` (default 5)
 *   MARINA_DECISION_ENGINES    chat models `/v1/systemone` may answer with as
 *                              `marina/classifier:<model>` through Marina's own
 *                              passthru (comma list, or `*` for any model Marina
 *                              routes). Unset: none (see engines.ts).
 */

import { availableModels } from "../agent/available-models";
import { positiveNumberFromEnv } from "../engine/constants";
import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";
import { LOCAL_PROVIDERS, localProviderBaseUrl } from "../net/model-discovery";
import { type ClassifierMethod, parseClassifierMethod } from "./classifier-methods";
import { chatClassifierProvider, decisionsApiProvider } from "./providers";
import { DecisionError, type DecisionProvider } from "./types";

export type DecisionBackendKind = "decisions-api" | "chat-classifier";

export interface DecisionConfig {
  kind: DecisionBackendKind;
  model: string;
  baseUrl: string;
  /** Decisions API path (decisions-api only). */
  path?: string;
  apiKey?: string;
  timeoutMs: number;
  /** USD per million input tokens when the backend reports tokens but no cost. */
  inputUsdPerMTok?: number;
  /** chat-classifier: how probabilities are obtained; set ⇒ structured output too. */
  method?: ClassifierMethod;
  samples?: number;
}

/**
 * Jev's list price (USD per million input tokens, output free). Applied only
 * to TypeSafe's own host, which reports tokens but not cost; OpenRouter reports
 * `usage.cost` itself, and a self-hosted OpenJev costs nothing upstream.
 */
export const TYPESAFE_INPUT_USD_PER_MTOK = 0.042;

type Preset = "openrouter" | "typesafe" | "chat-classifier";

const PRESETS: Record<
  Preset,
  { kind: DecisionBackendKind; baseUrl: string; path?: string; model?: string; timeoutMs: number }
> = {
  // Jev family through OpenRouter's Decisions API (pin a version).
  openrouter: {
    kind: "decisions-api",
    baseUrl: "https://openrouter.ai/api/alpha",
    path: "/decisions",
    model: "typesafe/jev-1.13",
    timeoutMs: 2_000,
  },
  // TypeSafe's own API (same wire format; what `langchain-typesafe` calls).
  typesafe: {
    kind: "decisions-api",
    baseUrl: "https://api.typesafe.ai",
    path: "/v1/systemone",
    model: "jev-latest",
    timeoutMs: 2_000,
  },
  "chat-classifier": {
    kind: "chat-classifier",
    baseUrl: "https://openrouter.ai/api/v1",
    timeoutMs: 8_000,
  },
};

function preset(raw: string | undefined): Preset | undefined {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "decisions-api":
    case "jev":
      return "openrouter";
    case "typesafe":
      return "typesafe";
    case "chat-classifier":
    case "classifier":
    case "llm":
      return "chat-classifier";
    default:
      return undefined;
  }
}

/**
 * A current, cheap chat model for a chat-classifier backend with no
 * MARINA_DECISION_MODEL, on the hosts whose model ids Marina knows; any other
 * base URL still needs the model named (undefined = decisions stay off).
 */
export function defaultClassifierModel(baseUrl: string): string | undefined {
  if (/^https:\/\/openrouter\.ai\//.test(baseUrl)) return "openai/gpt-6-luna";
  if (/^https:\/\/router\.huggingface\.co(\/|$)/.test(baseUrl)) return "zai-org/GLM-5.3-Flash";
  return undefined;
}

/**
 * Where a chat-classifier backend with no MARINA_DECISION_BASE_URL runs:
 * OpenRouter with its key, else the Hugging Face router with its key, else a
 * self-hosted runtime the operator configured (its default model) — so a
 * Marina with one local model still gets classifier decisions. Undefined
 * keeps the OpenRouter preset (and decisions stay off without a key).
 */
function classifierHost(
  env: NodeJS.ProcessEnv,
): { baseUrl: string; model?: string; apiKey?: string } | undefined {
  if (env.OPENROUTER_API_KEY?.trim()) return undefined;
  if (env.HUGGINGFACE_API_KEY?.trim() || env.HF_TOKEN?.trim()) {
    return { baseUrl: "https://router.huggingface.co/v1" };
  }
  const local = availableModels(env).find((m) => m.local);
  if (!local) return undefined;
  const base = localProviderBaseUrl(local.provider);
  const key = env[LOCAL_PROVIDERS[local.provider]?.keyEnv ?? ""]?.trim();
  return base
    ? {
        baseUrl: base,
        model: local.spec.slice(local.provider.length + 1),
        ...(key ? { apiKey: key } : {}),
      }
    : undefined;
}

/** Parse the decision config, or undefined when decisions are off / incomplete. */
export function decisionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DecisionConfig | undefined {
  const name = preset(env.MARINA_DECISIONS);
  if (!name) return undefined;
  const d = PRESETS[name];
  const kind = d.kind;
  const sized = kind === "chat-classifier" ? classifierHost(env) : undefined;
  const baseUrl = env.MARINA_DECISION_BASE_URL?.trim() || sized?.baseUrl || d.baseUrl;
  const model =
    env.MARINA_DECISION_MODEL?.trim() ||
    d.model ||
    (kind === "chat-classifier"
      ? defaultClassifierModel(baseUrl) ||
        (sized && sized.baseUrl === baseUrl ? sized.model : undefined)
      : undefined);
  if (!model) return undefined;
  const path = kind === "decisions-api" ? env.MARINA_DECISION_PATH?.trim() || d.path : undefined;
  // A vendor key only ever goes to that vendor's host.
  const vendorKey = /^https:\/\/openrouter\.ai\//.test(baseUrl)
    ? env.OPENROUTER_API_KEY
    : /^https:\/\/api\.typesafe\.ai(\/|$)/.test(baseUrl)
      ? env.TYPESAFE_API_KEY
      : /^https:\/\/router\.huggingface\.co(\/|$)/.test(baseUrl)
        ? env.HUGGINGFACE_API_KEY || env.HF_TOKEN
        : undefined;
  const localKey = sized && sized.baseUrl === baseUrl ? sized.apiKey : undefined;
  const apiKey = env.MARINA_DECISION_API_KEY?.trim() || vendorKey?.trim() || localKey || undefined;
  const typesafeHost = /^https:\/\/api\.typesafe\.ai(\/|$)/.test(baseUrl);
  return {
    kind,
    model,
    baseUrl,
    ...(path ? { path } : {}),
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: positiveNumberFromEnv("MARINA_DECISION_TIMEOUT_MS", env) ?? d.timeoutMs,
    ...(kind === "decisions-api" && typesafeHost
      ? { inputUsdPerMTok: TYPESAFE_INPUT_USD_PER_MTOK }
      : {}),
    ...(kind === "chat-classifier" ? classifierTuning(env) : {}),
  };
}

/** `MARINA_DECISION_METHOD` / `MARINA_DECISION_SAMPLES`, when set. */
export function classifierTuning(env: NodeJS.ProcessEnv = process.env): {
  method?: ClassifierMethod;
  samples?: number;
} {
  const method = parseClassifierMethod(env.MARINA_DECISION_METHOD);
  const samples = positiveNumberFromEnv("MARINA_DECISION_SAMPLES", env);
  return {
    ...(method ? { method } : {}),
    ...(samples === undefined ? {} : { samples }),
  };
}

export function providerFromConfig(config: DecisionConfig): DecisionProvider {
  const opts = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    ...(config.path ? { path: config.path } : {}),
    ...(config.inputUsdPerMTok === undefined ? {} : { inputUsdPerMTok: config.inputUsdPerMTok }),
    ...(config.method ? { method: config.method, structured: true } : {}),
    ...(config.samples === undefined ? {} : { samples: config.samples }),
  };
  return metered(
    config.kind === "decisions-api" ? decisionsApiProvider(opts) : chatClassifierProvider(opts),
  );
}

/** Refuse at the world's daily cap; record what each answered call cost. */
function metered(provider: DecisionProvider): DecisionProvider {
  return {
    kind: provider.kind,
    model: provider.model,
    ...(provider.calibrated === undefined ? {} : { calibrated: provider.calibrated }),
    async ask(request, signal) {
      const capped = dailyCapRefusal();
      if (capped) throw new DecisionError(capped, "spend_cap", 429);
      const result = await provider.ask(request, signal);
      recordSpend("decision", result.costUsd);
      return result;
    },
  };
}

let cached: { key: string; provider: DecisionProvider | undefined } | undefined;

/** The process decision provider (rebuilt when the env config changes), or undefined when off. */
export function getDecisionProvider(
  env: NodeJS.ProcessEnv = process.env,
): DecisionProvider | undefined {
  const config = decisionConfigFromEnv(env);
  const key = JSON.stringify(config ?? null);
  if (cached?.key !== key) cached = { key, provider: config && providerFromConfig(config) };
  return cached.provider;
}

/** Send the agent's intent + trust labels with gate calls (default on; `off` sends the call only). */
export function decisionGateContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_DECISION_GATE_CONTEXT?.trim().toLowerCase() !== "off";
}

export function decisionGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_DECISION_GATE?.trim().toLowerCase() === "on" && !!decisionConfigFromEnv(env);
}

/** The judge the research pipelines (forecast, arena) use unless told otherwise. */
export const DEFAULT_JUDGE_MODEL = "typesafe/jev-1.13";

/**
 * The judge for a research pipeline (`MARINA_FORECAST_JUDGE`,
 * `MARINA_ARENA_RESEARCH_JUDGE`):
 *   jev        jev-1.13 through OpenRouter's Decisions API; without `openRouterKey`
 *              the world's configured backend judges instead (none ⇒ no judge)
 *   decisions  the world's configured backend (`MARINA_DECISIONS`) — OpenJev,
 *              TypeSafe, a chat classifier, Marina's own `/v1`. Opt-in, and it
 *              never removes the judge: with no backend configured it falls
 *              back to `jev`.
 *   none       no judge (equal weights)
 * Judging a whole research brief takes longer than a gate call, so the
 * timeout is at least `minTimeoutMs`.
 */
export function researchJudge(
  spec: string,
  env: NodeJS.ProcessEnv,
  openRouterKey: string | undefined,
  minTimeoutMs = 10_000,
): DecisionProvider | undefined {
  const name = spec.trim().toLowerCase();
  if (name === "decisions") {
    const config = decisionConfigFromEnv(env);
    if (config) {
      return providerFromConfig({ ...config, timeoutMs: Math.max(config.timeoutMs, minTimeoutMs) });
    }
  } else if (name !== "jev") {
    return undefined;
  }
  if (!openRouterKey) {
    // Jev is unreachable without OpenRouter. Size to what exists: the world's
    // own backend (e.g. a chat classifier on its single local model) judges
    // instead; with none, there is no judge (analysts weighted equally).
    const config = decisionConfigFromEnv(env);
    return config
      ? providerFromConfig({ ...config, timeoutMs: Math.max(config.timeoutMs, minTimeoutMs) })
      : undefined;
  }
  return providerFromConfig({
    kind: "decisions-api",
    baseUrl: "https://openrouter.ai/api/alpha",
    path: "/decisions",
    model: DEFAULT_JUDGE_MODEL,
    apiKey: openRouterKey,
    timeoutMs: minTimeoutMs,
  });
}
