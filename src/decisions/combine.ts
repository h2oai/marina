// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Combining answers from several decision backends (pure) — used by the
 * `marina/ensemble` and `marina/auto` engines.
 *
 *   noul    mean in log-odds (each clamped to 0.01..0.99, so one saturated
 *           "0" or "1" cannot veto the others)
 *   choice  mean of the full option distributions; the pick is the argmax
 *   score   mean of the full level distributions; the score is the
 *           probability-weighted level, like Jev's
 *
 * Distributions are completed first (`toWireAnswer`), so a backend that only
 * reported a pick and a confidence still contributes a full distribution.
 */

import { toWireAnswer } from "./answers";
import type { BoxAnswer, DecisionAnswer, DecisionQuestions } from "./types";

const clamp = (p: number) => Math.min(0.99, Math.max(0.01, p));
const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function distribution(q: DecisionQuestions[string], a: DecisionAnswer): Record<string, number> {
  const wire = toWireAnswer(q, a) as { probabilities?: Record<string, number> };
  return wire.probabilities ?? {};
}

/** One answer per question from several backends' answers (each set answers every question). */
export function combineAnswers(
  questions: DecisionQuestions,
  sets: ReadonlyArray<Record<string, DecisionAnswer>>,
): Record<string, DecisionAnswer> {
  if (sets.length === 0) throw new Error("combineAnswers: nothing to combine");
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const answers = sets.map((s) => s[id]).filter((a): a is DecisionAnswer => !!a);
    if (q.type === "noul") {
      const z =
        answers.reduce((s, a) => s + logit(a.type === "noul" ? a.noul : 0.5), 0) / answers.length;
      out[id] = { type: "noul", noul: sigmoid(z) };
      continue;
    }
    if (q.type === "box") {
      // Confidence-weighted mean of each edge (an unreported confidence weighs 0.5).
      const boxes = answers.flatMap((a) => (a.type === "box" ? [a] : []));
      if (boxes.length === 0) throw new Error(`combineAnswers: no box for ${id}`);
      const w = boxes.map((a) => Math.max(0.01, a.confidence ?? 0.5));
      const total = w.reduce((s, x) => s + x, 0);
      const edge = (k: keyof BoxAnswer["box"]) =>
        boxes.reduce((s, a, i) => s + a.box[k] * w[i]!, 0) / total;
      out[id] = {
        type: "box",
        box: { top: edge("top"), bottom: edge("bottom"), left: edge("left"), right: edge("right") },
        confidence: boxes.reduce((s, a) => s + (a.confidence ?? 0.5), 0) / boxes.length,
      };
      continue;
    }
    const keys =
      q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const mean: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const a of answers) {
      const d = distribution(q, a);
      for (const k of keys) mean[k]! += (d[k] ?? 0) / answers.length;
    }
    const confidence = Math.max(...Object.values(mean));
    if (q.type === "choice") {
      const choice = keys.reduce((best, k) => (mean[k]! > mean[best]! ? k : best), keys[0]!);
      out[id] = { type: "choice", choice, confidence, probabilities: mean };
    } else {
      const score = keys.reduce((s, k) => s + Number(k) * mean[k]!, 0);
      out[id] = { type: "score", score, confidence, probabilities: mean };
    }
  }
  return out;
}

/** Below this, a backend is unsure enough that `marina/auto` asks for a second opinion. */
export const UNSURE = {
  /** A noul within this distance of 0.5. */
  noulBand: 0.15,
  /** A choice or score whose top probability is below this. */
  minConfidence: 0.6,
} as const;

/** The questions (ids) whose answers are too uncertain to stand alone. */
export function unsureAnswers(
  questions: DecisionQuestions,
  answers: Record<string, DecisionAnswer>,
): string[] {
  return Object.entries(questions).flatMap(([id, q]) => {
    const a = answers[id];
    if (!a) return [id];
    if (a.type === "noul") return Math.abs(a.noul - 0.5) < UNSURE.noulBand ? [id] : [];
    if (a.type === "box") return (a.confidence ?? 0) < UNSURE.minConfidence ? [id] : [];
    const top = Math.max(...Object.values(distribution(q, a)));
    return top < UNSURE.minConfidence ? [id] : [];
  });
}
