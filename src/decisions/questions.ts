// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type ChoiceQuestion,
  DecisionError,
  type DecisionQuestion,
  type DecisionQuestions,
  type NoulQuestion,
  type ScoreQuestion,
} from "./types";

export function noul(
  instructions: string,
  criteria?: { true: string; false: string },
): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function choice(
  instructions: string,
  criteria: Record<string, string | null>,
): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: string, criteria: string[]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}

const MAX_QUESTIONS = 16;
const MAX_TEXT = 2_000;
/** TypeSafe's limits: a Choice has at most 255 options, a Score at most 10 levels. */
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DecisionError(`${field} must be a non-empty string`, "invalid_request", 400);
  }
  if (value.length > MAX_TEXT) {
    throw new DecisionError(`${field} exceeds ${MAX_TEXT} characters`, "invalid_request", 400);
  }
  return value;
}

/**
 * TypeSafe accepts `instructions` as a string, object or array. A structured
 * value is serialized to JSON text, so every backend (a chat classifier
 * included) sees the same instructions.
 */
function instructionsText(value: unknown, field: string): string {
  if (value && typeof value === "object") return text(JSON.stringify(value), field);
  return text(value, field);
}

/** Validate untrusted question definitions (HTTP body, tool args) into typed questions. */
export function parseQuestions(raw: unknown): DecisionQuestions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DecisionError("questions must be an object keyed by id", "invalid_request", 400);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) {
    throw new DecisionError(
      `questions must have 1-${MAX_QUESTIONS} entries`,
      "invalid_request",
      400,
    );
  }
  const out: DecisionQuestions = {};
  for (const [id, value] of entries) {
    if (!QUESTION_ID.test(id)) {
      throw new DecisionError(`invalid question id "${id}"`, "invalid_request", 400);
    }
    out[id] = parseQuestion(id, value);
  }
  return out;
}

function parseQuestion(id: string, value: unknown): DecisionQuestion {
  if (!value || typeof value !== "object") {
    throw new DecisionError(`question ${id} must be an object`, "invalid_request", 400);
  }
  const q = value as Record<string, unknown>;
  const instructions = instructionsText(q.instructions, `${id}.instructions`);
  if (q.type === "noul") {
    if (q.criteria === undefined) return noul(instructions);
    const c = q.criteria as Record<string, unknown> | null;
    if (!c || typeof c !== "object") {
      throw new DecisionError(`${id}.criteria must be { true, false }`, "invalid_request", 400);
    }
    return noul(instructions, {
      true: text(c.true, `${id}.criteria.true`),
      false: text(c.false, `${id}.criteria.false`),
    });
  }
  if (q.type === "choice") {
    const c = q.criteria;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length < 2) {
      throw new DecisionError(`${id}.criteria needs at least two options`, "invalid_request", 400);
    }
    if (Object.keys(c).length > MAX_CHOICE_OPTIONS) {
      throw new DecisionError(
        `${id}.criteria has more than ${MAX_CHOICE_OPTIONS} options`,
        "invalid_request",
        400,
      );
    }
    const criteria: Record<string, string | null> = {};
    for (const [key, desc] of Object.entries(c as Record<string, unknown>)) {
      if (!key.trim()) {
        throw new DecisionError(`${id}.criteria has an empty option key`, "invalid_request", 400);
      }
      // `null`: the option key speaks for itself (TypeSafe's contract).
      criteria[key] = desc === null ? null : text(desc, `${id}.criteria.${key}`);
    }
    return choice(instructions, criteria);
  }
  if (q.type === "score") {
    const c = q.criteria;
    if (!Array.isArray(c) || c.length < 2) {
      throw new DecisionError(`${id}.criteria needs at least two levels`, "invalid_request", 400);
    }
    if (c.length > MAX_SCORE_LEVELS) {
      throw new DecisionError(
        `${id}.criteria has more than ${MAX_SCORE_LEVELS} levels`,
        "invalid_request",
        400,
      );
    }
    return score(
      instructions,
      c.map((level, i) => text(level, `${id}.criteria[${i}]`)),
    );
  }
  throw new DecisionError(`${id}.type must be noul, choice or score`, "invalid_request", 400);
}
