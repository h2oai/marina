// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type DecisionAnswer,
  DecisionError,
  type DecisionQuestion,
  type DecisionQuestions,
} from "./types";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Keep a reported distribution only over known keys, clamped; drop it if empty. */
function distribution(raw: unknown, keys: readonly string[]): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const p = num((raw as Record<string, unknown>)[key]);
    if (p !== undefined) out[key] = clamp01(p);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Coerce one backend answer into the typed shape for its question, or throw
 * `invalid_response`. Every backend funnels through here, so a chat model used
 * as a classifier is held to exactly the same contract as a Jev-family model:
 * probabilities clamp to 0..1, choices must be a listed option, scores clamp to
 * the level range.
 */
export function normalizeAnswer(
  id: string,
  question: DecisionQuestion,
  raw: unknown,
): DecisionAnswer {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const confidence = num(a.confidence);
  const withConfidence = confidence === undefined ? {} : { confidence: clamp01(confidence) };
  if (question.type === "noul") {
    const p = num(a.noul ?? a.probability ?? a.p);
    if (p === undefined) throw new DecisionError(`answer ${id}: missing noul`, "invalid_response");
    return { type: "noul", noul: clamp01(p) };
  }
  if (question.type === "choice") {
    const pick = typeof a.choice === "string" ? a.choice.trim() : "";
    if (!Object.hasOwn(question.criteria, pick)) {
      throw new DecisionError(`answer ${id}: "${pick}" is not an option`, "invalid_response");
    }
    const probabilities = distribution(a.probabilities, Object.keys(question.criteria));
    return {
      type: "choice",
      choice: pick,
      ...withConfidence,
      ...(probabilities ? { probabilities } : {}),
    };
  }
  const s = num(a.score ?? a.level);
  if (s === undefined) throw new DecisionError(`answer ${id}: missing score`, "invalid_response");
  const levels = question.criteria.map((_, i) => String(i));
  const probabilities = distribution(a.probabilities, levels);
  return {
    type: "score",
    score: Math.min(question.criteria.length - 1, Math.max(0, s)),
    ...withConfidence,
    ...(probabilities ? { probabilities } : {}),
  };
}

/** Normalize a whole answer map; every asked question must be answered. */
export function normalizeAnswers(
  questions: DecisionQuestions,
  raw: unknown,
): Record<string, DecisionAnswer> {
  const answers = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    out[id] = normalizeAnswer(id, question, answers[id]);
  }
  return out;
}

/**
 * The complete wire answer for HTTP callers (`/v1/decisions`, `/v1/systemone`).
 * TypeSafe's clients (e.g. `langchain-typesafe`) require `probabilities` and
 * `confidence` on choice and score answers, and a `legend` on score answers.
 * A decision-model backend usually reports them; for one that does not (a chat
 * model used as a classifier) they are derived from what it did report, so
 * every backend answers in the same, parseable shape:
 *   choice — the pick gets `confidence` (or 1), the rest share the remainder;
 *   score  — mass split linearly between the two nearest levels;
 *   confidence defaults to the largest probability.
 */
export function toWireAnswer(
  question: DecisionQuestion,
  answer: DecisionAnswer,
): Record<string, unknown> {
  if (answer.type === "noul" || question.type === "noul") return { ...answer };
  if (answer.type === "choice" && question.type === "choice") {
    const options = Object.keys(question.criteria);
    let probabilities = answer.probabilities;
    if (!probabilities) {
      const top = answer.confidence ?? 1;
      const rest = options.length > 1 ? (1 - top) / (options.length - 1) : 0;
      probabilities = Object.fromEntries(options.map((o) => [o, o === answer.choice ? top : rest]));
    }
    const confidence = answer.confidence ?? Math.max(...Object.values(probabilities));
    return { type: "choice", choice: answer.choice, probabilities, confidence };
  }
  if (answer.type === "score" && question.type === "score") {
    const legend = Object.fromEntries(question.criteria.map((text, i) => [String(i), text]));
    let probabilities = answer.probabilities;
    if (!probabilities) {
      const lo = Math.floor(answer.score);
      const hi = Math.min(question.criteria.length - 1, lo + 1);
      const frac = answer.score - lo;
      probabilities = Object.fromEntries(question.criteria.map((_, i) => [String(i), 0]));
      probabilities[String(lo)] = (probabilities[String(lo)] ?? 0) + (1 - frac);
      if (hi !== lo) probabilities[String(hi)] = (probabilities[String(hi)] ?? 0) + frac;
    }
    const confidence = answer.confidence ?? Math.max(...Object.values(probabilities));
    return { type: "score", score: answer.score, legend, probabilities, confidence };
  }
  return { ...answer };
}

export function toWireAnswers(
  questions: DecisionQuestions,
  answers: Record<string, DecisionAnswer>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (answer) out[id] = toWireAnswer(question, answer);
  }
  return out;
}
