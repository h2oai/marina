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
import { UNSURE } from "./combine";
import {
  activeGateQuestions,
  type GateQuestionSet,
  questionSetHash,
  questionsFor,
} from "./gate-questions";
import {
  DEFAULT_GATE_POLICY,
  decideGate,
  type GateAction,
  type GatePolicy,
  type GateVerdict,
  UNCALIBRATED_GATE_POLICY,
} from "./policy";
import type { DecisionAnswer, DecisionProvider, DecisionQuestions, SecondOpinion } from "./types";

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
  /** `marina/auto`: whether the primary's answers asked for a second opinion. */
  escalated?: boolean;
  /** `marina/auto`: what happened to that second opinion. */
  secondOpinion?: SecondOpinion;
}

/**
 * How far a risk probability may move before a second opinion is worth asking:
 * the same distance `marina/auto` treats as unsure around 0.5 (`UNSURE`), but
 * measured from the gate's own cut points.
 */
export const GATE_ESCALATION_BAND = UNSURE.noulBand;

/**
 * Whether a second opinion could change the gate's verdict: an asked question
 * left unanswered, or the verdict differing when every risk probability moves
 * `band` up or down. `decideGate` is monotone in every signal (higher never
 * relaxes a verdict), so the two extremes bound every combination in between —
 * a call whose answers sit far from every threshold that matters (block, hold,
 * the stricter context bar) never waits on a slower judge.
 */
export function gateNeedsSecondOpinion(
  answers: Record<string, DecisionAnswer>,
  questions: DecisionQuestions,
  actionOf: (answers: Record<string, DecisionAnswer>) => GateAction,
  band: number = GATE_ESCALATION_BAND,
): boolean {
  for (const id of Object.keys(questions)) {
    const a = answers[id];
    if (a?.type !== "noul" || !Number.isFinite(a.noul)) return true;
  }
  const shift = (delta: number): Record<string, DecisionAnswer> =>
    Object.fromEntries(
      Object.entries(answers).map(([id, a]) => [
        id,
        a.type === "noul" ? { ...a, noul: Math.min(1, Math.max(0, a.noul + delta)) } : a,
      ]),
    );
  const action = actionOf(answers);
  return actionOf(shift(band)) !== action || actionOf(shift(-band)) !== action;
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
  // The verdict for a set of raw answers — the one rule used for the reply and
  // for the escalation boundary below.
  const verdictOf = (raw: Record<string, DecisionAnswer>, native: boolean) => {
    const effective = policyFor(native);
    const answers = fit ? calibrateAnswers(raw, fit) : raw;
    // With an earned fit (and no explicit policy): allow vs hold on the fitted
    // P(hold); a hold is a block only when a native decision model's own raw
    // number says so (see `gateActionWithFit`).
    const rule =
      fit && !policy
        ? fittedGatePolicy(decideGate(raw, effective, questions, decide), native)
        : effective;
    return decideGate(answers, rule, questions, decide);
  };
  try {
    const result = await provider.ask({
      state: redactToolCall(toolName, args, description, intent),
      questions,
      // A composite engine asks for a second opinion only when it could change
      // the verdict (see `gateNeedsSecondOpinion`).
      escalate: (raw, native) =>
        gateNeedsSecondOpinion(raw, questions, (a) => verdictOf(a, native).action),
    });
    // What ANSWERED decides the policy: a composite engine (`marina/auto`) is
    // calibrated when Jev answered alone, not when a chat classifier joined in.
    // A native decision model is calibrated; any backend may EARN it (never lose it).
    const native = (result.calibrated ?? provider.calibrated) !== false;
    const calibrated = native || !!fit;
    const verdict = verdictOf(result.answers, native);
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
      ...(result.escalated === undefined ? {} : { escalated: result.escalated }),
      ...(result.secondOpinion ? { secondOpinion: result.secondOpinion } : {}),
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
