// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed answers for forecasting any question (src/forecast/typed.ts):
 *
 *   choice   — exactly one option id               ("B"); with `probabilities: true`
 *              the forecast also carries a probability for every option
 *   multi    — a set of option ids                 (["A", "C"]); with `probabilities: true`
 *              also each option's own probability of being true
 *   number   — a point estimate, optional spread   (1234.5 ± 12)
 *   ranking  — an ordered list of items            (["X", "Y", "Z"])
 *   text     — a short string                      ("Jane Doe")
 *
 * `validateAnswer` turns a model's raw value into the typed value (or a reason
 * it is unusable); `combineAnswers` merges K independent answers by type —
 * weighted plurality for choices and text, per-option frequency for sets,
 * weighted median (trimmed mean from five runs) for numbers, Borda for
 * rankings — and reports agreement (the share of runs, by weight, that agree
 * with the combined answer) as its confidence. Pure functions: no I/O.
 */

export interface AnswerOption {
  id: string;
  label?: string;
}

export type AnswerSpec =
  | {
      type: "choice";
      options: AnswerOption[];
      /** Ask for a probability on every option too (binary and multiple-choice forecasts). */
      probabilities?: boolean;
    }
  | {
      type: "multi";
      options: AnswerOption[];
      minPicks?: number;
      maxPicks?: number;
      /** Ask for each option's own probability of being true too (independent yes/no outcomes). */
      probabilities?: boolean;
    }
  | { type: "number"; unit?: string; integer?: boolean }
  | { type: "ranking"; size?: number; candidates?: string[] }
  | { type: "text"; maxLength?: number };

export type AnswerType = AnswerSpec["type"];

export type AnswerValue = string | string[] | number;

export const ANSWER_TYPES: readonly AnswerType[] = ["choice", "multi", "number", "ranking", "text"];

const MAX_OPTIONS = 64;
const MAX_ID = 64;
const MAX_TEXT = 300;
const MAX_RANK = 50;

/** A spec from untrusted JSON (API body, CLI flags) — or the reason it is invalid. */
export function parseAnswerSpec(raw: unknown): { spec: AnswerSpec } | { error: string } {
  const r = raw as Record<string, unknown> | undefined;
  const type = r?.type;
  if (typeof type !== "string" || !ANSWER_TYPES.includes(type as AnswerType)) {
    return { error: `answer.type must be one of ${ANSWER_TYPES.join(", ")}` };
  }
  if (type === "choice" || type === "multi") {
    const options = parseOptions(r?.options);
    if ("error" in options) return options;
    if (options.options.length < 2) return { error: `a ${type} answer needs at least 2 options` };
    if (type === "choice") {
      return {
        spec: {
          type,
          options: options.options,
          ...(r?.probabilities === true ? { probabilities: true } : {}),
        },
      };
    }
    const minPicks = intOrUndefined(r?.minPicks);
    const maxPicks = intOrUndefined(r?.maxPicks);
    return {
      spec: {
        type,
        options: options.options,
        ...(minPicks !== undefined ? { minPicks } : {}),
        ...(maxPicks !== undefined ? { maxPicks } : {}),
        ...(r?.probabilities === true ? { probabilities: true } : {}),
      },
    };
  }
  if (type === "number") {
    return {
      spec: {
        type,
        ...(typeof r?.unit === "string" && r.unit.trim()
          ? { unit: r.unit.trim().slice(0, 40) }
          : {}),
        ...(r?.integer === true ? { integer: true } : {}),
      },
    };
  }
  if (type === "ranking") {
    const size = intOrUndefined(r?.size);
    if (size !== undefined && (size < 1 || size > MAX_RANK)) {
      return { error: `ranking size must be 1–${MAX_RANK}` };
    }
    const candidates = Array.isArray(r?.candidates)
      ? r.candidates
          .filter((c): c is string => typeof c === "string" && c.trim() !== "")
          .map((c) => c.trim().slice(0, MAX_TEXT))
          .slice(0, MAX_OPTIONS)
      : undefined;
    return {
      spec: {
        type,
        ...(size !== undefined ? { size } : {}),
        ...(candidates?.length ? { candidates } : {}),
      },
    };
  }
  const maxLength = intOrUndefined(r?.maxLength);
  return {
    spec: { type: "text", ...(maxLength !== undefined && maxLength > 0 ? { maxLength } : {}) },
  };
}

function intOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return v === undefined || v === null || !Number.isInteger(n) ? undefined : n;
}

function parseOptions(raw: unknown): { options: AnswerOption[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "options must be an array" };
  if (raw.length > MAX_OPTIONS) return { error: `at most ${MAX_OPTIONS} options` };
  const options: AnswerOption[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    const id = typeof o === "string" ? o : (o as { id?: unknown })?.id;
    const label = typeof o === "object" && o ? (o as { label?: unknown }).label : undefined;
    if (typeof id !== "string" || !id.trim() || id.trim().length > MAX_ID) {
      return { error: "each option needs an id of 1–64 characters" };
    }
    const key = normalizeId(id);
    if (seen.has(key)) return { error: `duplicate option id ${id.trim()}` };
    seen.add(key);
    options.push({
      id: id.trim(),
      ...(typeof label === "string" && label.trim()
        ? { label: label.trim().slice(0, MAX_TEXT) }
        : {}),
    });
  }
  return { options };
}

const normalizeId = (s: string) => s.trim().toUpperCase();

/** Lower-case, collapse whitespace and drop surrounding punctuation — for comparing strings. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`.,;:!?()[\]]+|[\s"'`.,;:!?()[\]]+$/g, "");
}

export function matchOption(raw: string, options: AnswerOption[]): AnswerOption | undefined {
  const t = raw.trim();
  const byId = options.find((o) => normalizeId(o.id) === normalizeId(t));
  if (byId) return byId;
  const n = normalizeText(t);
  return options.find((o) => o.label !== undefined && normalizeText(o.label) === n);
}

/** Split "A, C" / "A;C" / "A|C" / ["A","C"] into items. */
function asList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string") return raw.split(/[,;|\n]/);
  return [];
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[,\s_]/g, "").replace(/[^\d.eE+-]/g, "");
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** A model's raw value as the typed answer, or why it cannot be used. */
export function validateAnswer(
  spec: AnswerSpec,
  raw: unknown,
): { value: AnswerValue } | { error: string } {
  switch (spec.type) {
    case "choice": {
      const items = asList(raw).filter((s) => s.trim());
      if (items.length !== 1) return { error: "a choice answer is exactly one option id" };
      const o = matchOption(items[0]!, spec.options);
      return o ? { value: o.id } : { error: `"${items[0]!.slice(0, 40)}" is not an option` };
    }
    case "multi": {
      const ids: string[] = [];
      for (const item of asList(raw)) {
        if (!item.trim()) continue;
        const o = matchOption(item, spec.options);
        if (!o) return { error: `"${item.slice(0, 40)}" is not an option` };
        if (!ids.includes(o.id)) ids.push(o.id);
      }
      if (ids.length < (spec.minPicks ?? 1)) return { error: "too few options picked" };
      if (spec.maxPicks !== undefined && ids.length > spec.maxPicks) {
        return { error: "too many options picked" };
      }
      return { value: sortByOptionOrder(ids, spec.options) };
    }
    case "number": {
      const n = parseNumber(raw);
      if (n === undefined) return { error: "not a number" };
      return { value: spec.integer ? Math.round(n) : n };
    }
    case "ranking": {
      const items: string[] = [];
      for (const item of asList(raw)) {
        const t = item.trim().slice(0, MAX_TEXT);
        if (!t) continue;
        const canon = spec.candidates?.find((c) => normalizeText(c) === normalizeText(t)) ?? t;
        if (!items.some((x) => normalizeText(x) === normalizeText(canon))) items.push(canon);
      }
      if (items.length === 0) return { error: "an empty ranking" };
      if (spec.size !== undefined && items.length < spec.size) {
        return { error: `a ranking of ${spec.size} needs ${spec.size} items` };
      }
      return {
        value: spec.size !== undefined ? items.slice(0, spec.size) : items.slice(0, MAX_RANK),
      };
    }
    case "text": {
      const t = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(", ") : "")
        .trim()
        .slice(0, spec.maxLength ?? MAX_TEXT);
      return t ? { value: t } : { error: "an empty answer" };
    }
  }
}

function sortByOptionOrder(ids: string[], options: AnswerOption[]): string[] {
  const order = new Map(options.map((o, i) => [o.id, i]));
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** The typed value as a single string (comma-separated lists, plain digits for numbers). */
export function formatAnswer(value: AnswerValue): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return String(Math.round(value * 1e6) / 1e6);
  }
  return value;
}

export interface WeightedAnswer {
  value: AnswerValue;
  weight: number;
  /** The run's own stated confidence (0–1), when it gave one. */
  confidence?: number;
}

export interface CombinedAnswer {
  value: AnswerValue;
  /** Weight share (0–1) of the runs that agree with the combined answer. */
  agreement: number;
  /** Per-option weight share for choice / multi answers. */
  support?: Record<string, number>;
  /** For numbers: weighted spread of the runs around the combined value. */
  spread?: number;
  method: string;
}

/** Merge K independent answers by type (see the file header). Undefined when none is usable. */
export function combineAnswers(
  spec: AnswerSpec,
  answers: WeightedAnswer[],
): CombinedAnswer | undefined {
  const usable = answers.filter((a) => a.weight > 0);
  const total = usable.reduce((s, a) => s + a.weight, 0);
  if (usable.length === 0 || total <= 0) return undefined;
  switch (spec.type) {
    case "choice":
      return plurality(usable, total, (v) => v as string, "weighted plurality");
    case "text":
      return plurality(usable, total, (v) => normalizeText(v as string), "weighted plurality");
    case "multi": {
      const support: Record<string, number> = {};
      for (const o of spec.options) support[o.id] = 0;
      for (const a of usable)
        for (const id of a.value as string[]) support[id] = (support[id] ?? 0) + a.weight;
      for (const id of Object.keys(support)) support[id] = support[id]! / total;
      let picked = spec.options.map((o) => o.id).filter((id) => (support[id] ?? 0) >= 0.5);
      const ranked = spec.options
        .map((o) => o.id)
        .sort((a, b) => (support[b] ?? 0) - (support[a] ?? 0));
      const min = spec.minPicks ?? 1;
      if (picked.length < min) picked = ranked.slice(0, min);
      if (spec.maxPicks !== undefined && picked.length > spec.maxPicks) {
        picked = ranked.filter((id) => picked.includes(id)).slice(0, spec.maxPicks);
      }
      const value = sortByOptionOrder(picked, spec.options);
      const key = value.join("|");
      const agree = usable
        .filter((a) => (a.value as string[]).join("|") === key)
        .reduce((s, a) => s + a.weight, 0);
      return {
        value,
        agreement: round(agree / total),
        support: roundAll(support),
        method: "per-option frequency ≥ ½",
      };
    }
    case "number": {
      const values = usable
        .map((a) => ({ x: a.value as number, w: a.weight }))
        .sort((a, b) => a.x - b.x);
      const point = values.length >= 5 ? trimmedMean(values, 0.2) : weightedMedian(values, total);
      const value = spec.integer ? Math.round(point) : point;
      const spread = Math.sqrt(values.reduce((s, v) => s + v.w * (v.x - value) ** 2, 0) / total);
      // Agreement: runs within 2.5% of the combined value (a tight numeric tolerance).
      const tol = Math.max(Math.abs(value) * 0.025, 1e-9);
      const agree = values.filter((v) => Math.abs(v.x - value) <= tol).reduce((s, v) => s + v.w, 0);
      return {
        value: round(value, 6),
        agreement: round(agree / total),
        spread: round(spread, 6),
        method: values.length >= 5 ? "20% trimmed mean" : "weighted median",
      };
    }
    case "ranking": {
      const size = spec.size ?? Math.max(...usable.map((a) => (a.value as string[]).length));
      const score = new Map<string, { label: string; points: number }>();
      for (const a of usable) {
        const list = a.value as string[];
        list.forEach((item, i) => {
          const k = normalizeText(item);
          const had = score.get(k) ?? { label: item, points: 0 };
          had.points += a.weight * (list.length - i);
          score.set(k, had);
        });
      }
      const value = [...score.values()]
        .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label))
        .slice(0, size)
        .map((s) => s.label);
      const key = value.map(normalizeText).join("|");
      const agree = usable
        .filter((a) => (a.value as string[]).slice(0, size).map(normalizeText).join("|") === key)
        .reduce((s, a) => s + a.weight, 0);
      return { value, agreement: round(agree / total), method: "Borda count" };
    }
  }
}

function plurality(
  usable: WeightedAnswer[],
  total: number,
  key: (v: AnswerValue) => string,
  method: string,
): CombinedAnswer {
  const tally = new Map<string, { value: AnswerValue; weight: number; confidence: number }>();
  for (const a of usable) {
    const k = key(a.value);
    const had = tally.get(k) ?? { value: a.value, weight: 0, confidence: 0 };
    had.weight += a.weight;
    had.confidence += a.weight * (a.confidence ?? 0.5);
    tally.set(k, had);
  }
  // Ties break on the runs' stated confidence, then lexically (deterministic).
  const best = [...tally.entries()].sort(
    (a, b) =>
      b[1].weight - a[1].weight || b[1].confidence - a[1].confidence || a[0].localeCompare(b[0]),
  )[0]![1];
  const support: Record<string, number> = {};
  for (const t of tally.values()) support[String(t.value)] = round(t.weight / total);
  return { value: best.value, agreement: round(best.weight / total), support, method };
}

function weightedMedian(values: Array<{ x: number; w: number }>, total: number): number {
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i]!.w;
    if (acc > total / 2) return values[i]!.x;
    if (acc === total / 2 && i + 1 < values.length) return (values[i]!.x + values[i + 1]!.x) / 2;
  }
  return values[values.length - 1]!.x;
}

function trimmedMean(values: Array<{ x: number; w: number }>, cut: number): number {
  const k = Math.floor(values.length * cut);
  const kept = values.slice(k, values.length - k);
  const w = kept.reduce((s, v) => s + v.w, 0);
  return kept.reduce((s, v) => s + v.w * v.x, 0) / w;
}

const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

function roundAll(r: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) out[k] = round(v);
  return out;
}
