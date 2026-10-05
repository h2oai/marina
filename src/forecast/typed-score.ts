// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoring a saved typed answer (choice / multi / ranking / text) when the
 * resolver Sample it was linked to (`forecast … resolves:<venue>/<ticker>`)
 * resolves. A typed number is a number: it is scored like one (CRPS when the
 * answer carried an uncertainty, else settled unscored).
 *
 * The outcome is read from the Sample's value in general shapes, matched to
 * the answer's own options:
 *
 *   choice / multi   `option` | `options` | `value` (an id or label, or a list)
 *                    | a yes/no `outcome` matched to options named Yes / No
 *   ranking          `ranking` | `list` | `options` | `value` (a list)
 *   text             `text` | `answer` | `value` (a string)
 *
 * An outcome that does not match the answer's options is not scored — the row
 * stays open rather than being scored against a guess.
 *
 * Every score is a LOSS (lower is better, like Brier and CRPS on the same
 * table) plus a 0–1 quality for the lesson loop:
 *
 *   choice   multiclass Brier Σ (p_o − y_o)² over the options, from the answer's
 *            distribution when it has one, else its pick as certainty (0 or 2)
 *   multi    mean per-option Brier over the options (distribution, else picks)
 *   ranking  1 − |predicted top-k ∩ truth| / k, with k = the truth's length
 *   text     0 when the normalised strings match, else 1
 */

import { type AnswerSpec, matchOption, normalizeText } from "./answer-types";
import type { TypedForecastAnswer } from "./typed";

export interface TypedResolution {
  metric: "brier" | "set-brier" | "overlap" | "exact";
  /** The loss stored as the answer's score (lower is better). */
  loss: number;
  /** 0–1, higher is better (for lessons). */
  quality: number;
  succeeded: boolean;
  /** What the outcome resolved to, in the answer's own terms (option ids, a list, a string). */
  outcome: string[] | string;
}

const asStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.map((x) => String(x))
    : typeof v === "string"
      ? v
          .split(/[,;|\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

function field(value: unknown, ...keys: string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  for (const k of keys) if (v[k] !== undefined) return v[k];
  return undefined;
}

/** The option ids an outcome names, or undefined when any does not match. */
function optionTruth(
  spec: Extract<AnswerSpec, { type: "choice" | "multi" }>,
  value: unknown,
): string[] | undefined {
  const raw =
    asStrings(field(value, "option", "options", "value")) ??
    (typeof value === "string" ? [value] : undefined);
  const outcome = field(value, "outcome");
  const named = raw ?? (outcome === "yes" || outcome === "no" ? [outcome] : undefined);
  if (!named?.length) return undefined;
  const ids = named.map((n) => matchOption(n, spec.options)?.id);
  if (ids.some((id) => id === undefined)) return undefined;
  return [...new Set(ids as string[])];
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** The resolution of a typed answer against a Sample's value, or undefined (unscorable). */
export function scoreTypedAnswer(
  answer: Pick<TypedForecastAnswer, "answer" | "prediction" | "distribution">,
  value: unknown,
): TypedResolution | undefined {
  const spec = answer.answer;
  const pred = answer.prediction;
  if (spec.type === "choice") {
    const truth = optionTruth(spec, value);
    if (!truth || truth.length !== 1) return undefined;
    const t = truth[0]!;
    const pick = typeof pred === "string" ? pred : undefined;
    const p = (id: string) => answer.distribution?.[id] ?? (id === pick ? 1 : 0);
    const loss = spec.options.reduce((s, o) => s + (p(o.id) - (o.id === t ? 1 : 0)) ** 2, 0);
    return {
      metric: "brier",
      loss: r4(loss),
      quality: r4(1 - loss / 2),
      succeeded: pick === t,
      outcome: truth,
    };
  }
  if (spec.type === "multi") {
    const truth = optionTruth(spec, value);
    if (!truth) return undefined;
    const picked = new Set(Array.isArray(pred) ? pred : typeof pred === "string" ? [pred] : []);
    const p = (id: string) => answer.distribution?.[id] ?? (picked.has(id) ? 1 : 0);
    const loss =
      spec.options.reduce((s, o) => s + (p(o.id) - (truth.includes(o.id) ? 1 : 0)) ** 2, 0) /
      Math.max(1, spec.options.length);
    const exact = picked.size === truth.length && truth.every((id) => picked.has(id));
    return {
      metric: "set-brier",
      loss: r4(loss),
      quality: r4(1 - loss),
      succeeded: exact,
      outcome: truth,
    };
  }
  if (spec.type === "ranking") {
    const truth = asStrings(field(value, "ranking", "list", "options", "value") ?? value);
    if (!truth?.length || !Array.isArray(pred)) return undefined;
    const k = truth.length;
    const want = new Set(truth.map(normalizeText));
    const hits = pred.slice(0, k).filter((x) => want.has(normalizeText(String(x)))).length;
    const quality = hits / k;
    return {
      metric: "overlap",
      loss: r4(1 - quality),
      quality: r4(quality),
      succeeded: quality >= 0.5,
      outcome: truth,
    };
  }
  if (spec.type === "text") {
    const raw = field(value, "text", "answer", "value") ?? value;
    if (typeof raw !== "string" || !raw.trim() || typeof pred !== "string") return undefined;
    const hit = normalizeText(raw) === normalizeText(pred);
    return {
      metric: "exact",
      loss: hit ? 0 : 1,
      quality: hit ? 1 : 0,
      succeeded: hit,
      outcome: raw,
    };
  }
  return undefined;
}
