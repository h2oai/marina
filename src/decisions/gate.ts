// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import { redactLogData } from "../engine/logger";
import {
  DEFAULT_GATE_POLICY,
  decideGate,
  GATE_QUESTIONS,
  type GatePolicy,
  type GateVerdict,
} from "./policy";
import type { DecisionProvider } from "./types";

const MAX_ARG_CHARS = 500;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET =
  /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/g;

/**
 * What leaves the process for a gate decision: the tool name and its
 * arguments ONLY — never the transcript — with sensitive keys redacted, emails
 * and key-shaped strings masked, and long values truncated. Seeing only the
 * call is also what makes the gate robust to prompt injection: text hidden in a
 * document never reaches the gate, but the harmful call it provokes does.
 */
export function redactToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const mask = (value: unknown): unknown => {
    if (typeof value === "string") {
      const masked = value.replace(EMAIL, "<email>").replace(SECRET, "<secret>");
      return masked.length > MAX_ARG_CHARS ? `${masked.slice(0, MAX_ARG_CHARS)}…` : masked;
    }
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
    }
    return value;
  };
  return { tool: toolName, arguments: mask(redactLogData(args)) };
}

export interface GateDecision extends GateVerdict {
  model?: string;
  provider?: string;
  latencyMs?: number;
  costUsd?: number;
  /** Set when the backend failed and the gate failed closed. */
  error?: string;
}

/** Score one tool call. Never throws: a backend failure is a fail-closed `block`. */
export async function gateToolCall(
  provider: DecisionProvider,
  toolName: string,
  args: Record<string, unknown>,
  policy: GatePolicy = DEFAULT_GATE_POLICY,
): Promise<GateDecision> {
  try {
    const result = await provider.ask({
      state: redactToolCall(toolName, args),
      questions: GATE_QUESTIONS,
    });
    return {
      ...decideGate(result.answers, policy),
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    return {
      ...decideGate(undefined, policy),
      provider: provider.kind,
      model: provider.model,
      error: getErrorMessage(err),
    };
  }
}
