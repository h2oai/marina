// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import { redactLogData } from "../engine/logger";
import {
  applyPlatt,
  type CalibrationEntry,
  earnedGateCalibration,
  FITTED_HOLD_AT,
  gateActionWithFit,
} from "./calibrate";
import {
  activeGateQuestions,
  type GateQuestionSet,
  questionSetHash,
  questionsFor,
} from "./gate-questions";
import {
  DEFAULT_GATE_POLICY,
  decideGate,
  type GatePolicy,
  type GateVerdict,
  UNCALIBRATED_GATE_POLICY,
} from "./policy";
import type { DecisionAnswer, DecisionProvider } from "./types";

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
  /** `fitted` when an earned calibration mapped the risk probabilities (see calibrate.ts). */
  calibration?: "fitted";
  model?: string;
  provider?: string;
  latencyMs?: number;
  costUsd?: number;
  /** Set when the backend failed and the gate failed closed. */
  error?: string;
}

/** Every risk probability through the fitted map (monotone: the worst risk stays the worst). */
function calibrateAnswers(
  answers: Record<string, DecisionAnswer>,
  fit: CalibrationEntry,
): Record<string, DecisionAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]) => [
      id,
      a.type === "noul" ? { ...a, noul: applyPlatt(a.noul, fit) } : a,
    ]),
  );
}

/** The policy `gateActionWithFit` describes, for `decideGate` on fitted answers. */
function fittedGatePolicy(raw: GateVerdict, native: boolean): GatePolicy {
  const nativeBlock = native && gateActionWithFit(raw.worst ?? 0, 1, true) === "block";
  return {
    askAt: FITTED_HOLD_AT,
    blockAt: nativeBlock ? FITTED_HOLD_AT : Number.POSITIVE_INFINITY,
  };
}

export interface GateCallOptions {
  /**
   * The earned fit for this backend (default: looked up from
   * `MARINA_DECISION_CALIBRATION` for this question set); `null` scores the
   * backend's raw probabilities.
   */
  calibration?: CalibrationEntry | null;
  /** The question wording (default: the adopted set, else the baseline). */
  questions?: GateQuestionSet;
  /**
   * The call's risk class (`classifyToolRisk`). On a `mutate` call the
   * `unauthorized` context question alone holds only at the stricter context
   * bar (see `decideGate`); on `egress` `outsideScope` is not counted either;
   * default `consequential` counts every question.
   */
  risk?: "egress" | "mutate" | "consequential";
}

/** Score one tool call. Never throws: a backend failure is a fail-closed `block`. */
export async function gateToolCall(
  provider: DecisionProvider,
  toolName: string,
  args: Record<string, unknown>,
  policy?: GatePolicy,
  description?: string,
  intent?: GateIntent,
  opts: GateCallOptions = {},
): Promise<GateDecision> {
  const set = opts.questions ?? activeGateQuestions();
  const questions = questionsFor(set, !!intent);
  const decide = opts.risk ? { risk: opts.risk } : {};
  const fit =
    opts.calibration === undefined
      ? earnedGateCalibration(provider.model, process.env, questionSetHash(set))
      : (opts.calibration ?? undefined);
  const policyFor = (native: boolean) =>
    policy ?? (native || fit ? DEFAULT_GATE_POLICY : UNCALIBRATED_GATE_POLICY);
  try {
    const result = await provider.ask({
      state: redactToolCall(toolName, args, description, intent),
      questions,
    });
    // What ANSWERED decides the policy: a composite engine (`marina/auto`) is
    // calibrated when Jev answered alone, not when a chat classifier joined in.
    // A native decision model is calibrated; any backend may EARN it (never lose it).
    const native = (result.calibrated ?? provider.calibrated) !== false;
    const calibrated = native || !!fit;
    const effective = policyFor(native);
    const answers = fit ? calibrateAnswers(result.answers, fit) : result.answers;
    // With an earned fit (and no explicit policy): allow vs hold on the fitted
    // P(hold); a hold is a block only when a native decision model's own raw
    // number says so (see `gateActionWithFit`).
    const rule =
      fit && !policy
        ? fittedGatePolicy(decideGate(result.answers, effective, questions, decide), native)
        : effective;
    const verdict = decideGate(answers, rule, questions, decide);
    return {
      ...verdict,
      ...(calibrated
        ? {}
        : { calibrated: false, reason: `${verdict.reason} (uncalibrated backend: one threshold)` }),
      ...(fit
        ? { calibration: "fitted" as const, reason: `${verdict.reason} (fitted calibration)` }
        : {}),
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    return {
      ...decideGate(undefined, policyFor(provider.calibrated !== false), questions),
      provider: provider.kind,
      model: provider.model,
      error: getErrorMessage(err),
    };
  }
}
