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
    return { type: "choice", choice: pick, ...withConfidence };
  }
  const s = num(a.score ?? a.level);
  if (s === undefined) throw new DecisionError(`answer ${id}: missing score`, "invalid_response");
  return {
    type: "score",
    score: Math.min(question.criteria.length - 1, Math.max(0, s)),
    ...withConfidence,
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
