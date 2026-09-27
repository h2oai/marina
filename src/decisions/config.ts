// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Env-only decision configuration. OFF by default: a decision backend receives
 * tool arguments and request text, so sending them to a third party is an
 * explicit operator choice, never an in-world setting.
 *
 *   MARINA_DECISIONS           off (default) | decisions-api (alias jev) |
 *                              typesafe (TypeSafe's direct API) |
 *                              chat-classifier (alias classifier, llm)
 *   MARINA_DECISION_MODEL      backend model id. decisions-api default
 *                              `typesafe/jev-1.13` (pin a version; any Jev-family
 *                              or OpenJev id works). chat-classifier: required.
 *   MARINA_DECISION_BASE_URL   decisions-api default https://openrouter.ai/api/alpha
 *                              chat-classifier default https://openrouter.ai/api/v1
 *   MARINA_DECISION_API_KEY    bearer for the backend; falls back to
 *                              OPENROUTER_API_KEY only for openrouter.ai URLs
 *   MARINA_DECISION_PATH       Decisions API path; default /decisions (typesafe: /v1/systemone)
 *   MARINA_DECISION_TIMEOUT_MS per call; default 2000 (decisions-api) / 8000
 *   MARINA_DECISION_GATE       on | off (default off) — score mutating agent
 *                              tool calls before they run (fail-closed)
 */

import { positiveNumberFromEnv } from "../engine/constants";
import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";
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

/** Parse the decision config, or undefined when decisions are off / incomplete. */
export function decisionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DecisionConfig | undefined {
  const name = preset(env.MARINA_DECISIONS);
  if (!name) return undefined;
  const d = PRESETS[name];
  const kind = d.kind;
  const model = env.MARINA_DECISION_MODEL?.trim() || d.model;
  if (!model) return undefined;
  const baseUrl = env.MARINA_DECISION_BASE_URL?.trim() || d.baseUrl;
  const path = kind === "decisions-api" ? env.MARINA_DECISION_PATH?.trim() || d.path : undefined;
  // A vendor key only ever goes to that vendor's host.
  const vendorKey = /^https:\/\/openrouter\.ai\//.test(baseUrl)
    ? env.OPENROUTER_API_KEY
    : /^https:\/\/api\.typesafe\.ai(\/|$)/.test(baseUrl)
      ? env.TYPESAFE_API_KEY
      : /^https:\/\/router\.huggingface\.co(\/|$)/.test(baseUrl)
        ? env.HUGGINGFACE_API_KEY || env.HF_TOKEN
        : undefined;
  const apiKey = env.MARINA_DECISION_API_KEY?.trim() || vendorKey?.trim() || undefined;
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
 *   jev        jev-1.13 through OpenRouter's Decisions API (needs `openRouterKey`)
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
  if (!openRouterKey) return undefined;
  return providerFromConfig({
    kind: "decisions-api",
    baseUrl: "https://openrouter.ai/api/alpha",
    path: "/decisions",
    model: DEFAULT_JUDGE_MODEL,
    apiKey: openRouterKey,
    timeoutMs: minTimeoutMs,
  });
}
