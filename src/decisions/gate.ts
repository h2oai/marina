// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import { redactLogData } from "../engine/logger";
import {
  DEFAULT_GATE_POLICY,
  decideGate,
  GATE_QUESTIONS,
  GATE_QUESTIONS_WITH_AUTHORIZATION,
  type GatePolicy,
  type GateVerdict,
  UNCALIBRATED_GATE_POLICY,
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
/**
 * What the agent is FOR, sent with a gate call so the judge can tell a call
 * that serves the agent's own purpose from one provoked by untrusted content.
 * Operator-authored fields only (goal, role, focus, active task) plus the trust
 * LABELS of what fed this cycle's prompt — never the content itself.
 */
export interface GateIntent {
  goal?: string;
  role?: string;
  focus?: string;
  task?: string;
  /** Trust labels from the adapter: world_event, memory, external_tool, untrusted_relay. */
  sources: string[];
}

/** Plain-language meaning of each trust label, sent alongside the labels. */
export const TRUST_SOURCE_MEANING: Record<string, string> = {
  world_event: "first-party world perceptions (room events, messages addressed to the agent)",
  memory: "recalled notes, which can include other agents' shared notes",
  external_tool: "results of web, fetch, search or probe tools (untrusted outside content)",
  untrusted_relay: "content relayed from a federated peer instance (untrusted, non-authoritative)",
};

const MAX_INTENT_CHARS = 400;

/** Mask emails and key-shaped strings and cap the length — for any text sent to a judge. */
export function maskSensitiveText(value: string, maxChars: number): string {
  const masked = value.replace(EMAIL, "<email>").replace(SECRET, "<secret>");
  return masked.length > maxChars ? `${masked.slice(0, maxChars)}…` : masked;
}

export function redactToolCall(
  toolName: string,
  args: Record<string, unknown>,
  description?: string,
  intent?: GateIntent,
): Record<string, unknown> {
  const mask = (value: unknown): unknown => {
    if (typeof value === "string") return maskSensitiveText(value, MAX_ARG_CHARS);
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
    }
    return value;
  };
  const state: Record<string, unknown> = { tool: toolName, arguments: mask(redactLogData(args)) };
  // What the tool does, so the judge need not guess from the name alone.
  if (description?.trim()) state.tool_description = mask(description.trim());
  if (intent) {
    const agent: Record<string, unknown> = {};
    for (const key of ["goal", "role", "focus", "task"] as const) {
      const value = intent[key]?.trim();
      if (value) agent[key] = mask(value.slice(0, MAX_INTENT_CHARS));
    }
    state.agent = agent;
    state.context_sources = [...new Set(intent.sources)].map((label) => ({
      label,
      meaning: TRUST_SOURCE_MEANING[label] ?? "other",
    }));
  }
  return state;
}

export interface GateDecision extends GateVerdict {
  /** False when the verdict came from an uncalibrated backend (one-threshold policy). */
  calibrated?: boolean;
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
  policy?: GatePolicy,
  description?: string,
  intent?: GateIntent,
): Promise<GateDecision> {
  const questions = intent ? GATE_QUESTIONS_WITH_AUTHORIZATION : GATE_QUESTIONS;
  const calibrated = provider.calibrated !== false;
  const effective = policy ?? (calibrated ? DEFAULT_GATE_POLICY : UNCALIBRATED_GATE_POLICY);
  try {
    const result = await provider.ask({
      state: redactToolCall(toolName, args, description, intent),
      questions,
    });
    const verdict = decideGate(result.answers, effective, questions);
    return {
      ...verdict,
      ...(calibrated
        ? {}
        : { calibrated: false, reason: `${verdict.reason} (uncalibrated backend: one threshold)` }),
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    return {
      ...decideGate(undefined, effective, questions),
      provider: provider.kind,
      model: provider.model,
      error: getErrorMessage(err),
    };
  }
}
