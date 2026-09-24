// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision primitives: small, structured judgement calls a harness asks at a
 * fixed point in the agent loop (route a request, gate a tool call, verify an
 * answer). A decision model answers every question with a NUMBER, never text;
 * Marina's policy code turns the numbers into a verdict.
 *
 * The wire shape is the Decisions API used by TypeSafe's Jev family on
 * OpenRouter (`POST /api/alpha/decisions`): a `state` plus named `questions`,
 * each `{ type, instructions, criteria }`. Any backend — a Jev-family model, an
 * OpenJev deployment, or an ordinary chat model used as a classifier —
 * implements {@link DecisionProvider} with the same request/answer types, so
 * policies never know which model answered.
 */

/** Yes/no: the probability that the answer is yes. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  /** What counts as yes / no. Optional, but it is the prompt — spell it out. */
  criteria?: { true: string; false: string };
}

/** Pick one option. `criteria` maps each option key to its description. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** Place on an ordered scale. `criteria[i]` describes level `i` (low → high). */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface NoulAnswer {
  type: "noul";
  /** Probability of yes, 0..1. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** 0..1 when the backend reports it. */
  confidence?: number;
  /** Probability per option key, when the backend reports a distribution. */
  probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level index, 0..(criteria.length - 1). */
  score: number;
  confidence?: number;
  /** Probability per level index ("0", "1", …), when the backend reports it. */
  probabilities?: Record<string, number>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionRequest {
  /** The situation to judge: a string, object or array. */
  state: unknown;
  questions: DecisionQuestions;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  /** The backend model that answered, e.g. `typesafe/jev-1.13`. */
  model: string;
  /** Which provider kind answered (`decisions-api`, `chat-classifier`, …). */
  provider: string;
  latencyMs: number;
  /** USD, when the backend reports it. */
  costUsd?: number;
  /** Token usage, when the backend reports it. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** A backend that answers decision questions. Implementations never throw for
 *  a malformed individual answer — they throw only when the call as a whole
 *  failed (network, timeout, HTTP error, unparseable reply), so each policy can
 *  apply its own fail-open / fail-closed rule. */
export interface DecisionProvider {
  readonly kind: string;
  readonly model: string;
  ask(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult>;
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "decisions_disabled"
      | "timeout"
      | "upstream_error"
      | "invalid_response"
      | "invalid_request",
    readonly status = 502,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}
