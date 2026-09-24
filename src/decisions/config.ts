// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Env-only decision configuration. OFF by default: a decision backend receives
 * tool arguments and request text, so sending them to a third party is an
 * explicit operator choice, never an in-world setting.
 *
 *   MARINA_DECISIONS           off (default) | decisions-api (alias jev) |
 *                              chat-classifier (alias classifier, llm)
 *   MARINA_DECISION_MODEL      backend model id. decisions-api default
 *                              `typesafe/jev-1.13` (pin a version; any Jev-family
 *                              or OpenJev id works). chat-classifier: required.
 *   MARINA_DECISION_BASE_URL   decisions-api default https://openrouter.ai/api/alpha
 *                              chat-classifier default https://openrouter.ai/api/v1
 *   MARINA_DECISION_API_KEY    bearer for the backend; falls back to
 *                              OPENROUTER_API_KEY only for openrouter.ai URLs
 *   MARINA_DECISION_TIMEOUT_MS per call; default 2000 (decisions-api) / 8000
 *   MARINA_DECISION_GATE       on | off (default off) — score mutating agent
 *                              tool calls before they run (fail-closed)
 */

import { positiveNumberFromEnv } from "../engine/constants";
import { chatClassifierProvider, decisionsApiProvider } from "./providers";
import type { DecisionProvider } from "./types";

export type DecisionBackendKind = "decisions-api" | "chat-classifier";

export interface DecisionConfig {
  kind: DecisionBackendKind;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

const DEFAULTS: Record<
  DecisionBackendKind,
  { baseUrl: string; model?: string; timeoutMs: number }
> = {
  "decisions-api": {
    baseUrl: "https://openrouter.ai/api/alpha",
    model: "typesafe/jev-1.13",
    timeoutMs: 2_000,
  },
  "chat-classifier": { baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 8_000 },
};

function backendKind(raw: string | undefined): DecisionBackendKind | undefined {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "decisions-api":
    case "jev":
      return "decisions-api";
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
  const kind = backendKind(env.MARINA_DECISIONS);
  if (!kind) return undefined;
  const d = DEFAULTS[kind];
  const model = env.MARINA_DECISION_MODEL?.trim() || d.model;
  if (!model) return undefined;
  const baseUrl = env.MARINA_DECISION_BASE_URL?.trim() || d.baseUrl;
  const openrouter = /^https:\/\/openrouter\.ai\//.test(baseUrl);
  const apiKey =
    env.MARINA_DECISION_API_KEY?.trim() ||
    (openrouter ? env.OPENROUTER_API_KEY?.trim() : undefined);
  return {
    kind,
    model,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: positiveNumberFromEnv("MARINA_DECISION_TIMEOUT_MS", env) ?? d.timeoutMs,
  };
}

export function providerFromConfig(config: DecisionConfig): DecisionProvider {
  const opts = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  };
  return config.kind === "decisions-api"
    ? decisionsApiProvider(opts)
    : chatClassifierProvider(opts);
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

export function decisionGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_DECISION_GATE?.trim().toLowerCase() === "on" && !!decisionConfigFromEnv(env);
}
