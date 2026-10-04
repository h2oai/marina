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
 * with the combined answer) as its confidence. With `selection: "confidence"`
 * the most self-confident run's answer is taken instead, with its own stated
 * confidence (better calibrated than agreement among same-model runs).
 *
 * Numbers are read with their scale and sign ("1.2 million", "(79,000)",
 * "down 0.4", a Unicode minus) and converted to the spec's unit when the unit
 * names a scale ("USD billions"); before combining, a run written at another
 * power-of-ten scale than the runs' median (a thousands/millions confusion)
 * is brought to the median's scale. Pure functions: no I/O.
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

/** Multipliers of the scale words a number may be written with. */
const SCALE_WORDS: ReadonlyArray<[RegExp, number]> = [
  [/^(?:trillions?|tn)$/i, 1e12],
  [/^(?:billions?|bn)$/i, 1e9],
  [/^(?:millions?|mn)$/i, 1e6],
  [/^thousands?$/i, 1e3],
];
/** One-letter suffixes count only attached to the number ("68k", "$3.4B"): "3 m" may be metres. */
const SCALE_SUFFIXES: Readonly<Record<string, number>> = {
  k: 1e3,
  K: 1e3,
  M: 1e6,
  B: 1e9,
  T: 1e12,
};

/** The multiplier a unit or word names (`USD billions` → 1e9), else undefined. */
export function unitScale(text: string | undefined): number | undefined {
  if (!text) return undefined;
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (!word || word.length < 2) continue; // a bare "m" or "b" in a unit is not a scale
    for (const [re, mult] of SCALE_WORDS) if (re.test(word)) return mult;
  }
  return undefined;
}

/** A sign word in the answer itself: "down 0.4", "a decline of 79,000". */
const NEGATIVE_WORDS =
  /^\s*(?:down|minus|negative|lower by|a\s+(?:decline|decrease|drop|fall|contraction|loss)\s+of|declin\w*|decreas\w*|fell|dropped)\b/i;

export interface ParsedNumber {
  /** The value as written, in absolute units when a scale word was given. */
  value: number;
  /** The multiplier of a scale word the number carried ("1.2 million" → 1e6). */
  scale?: number;
}

/**
 * A number from a model's raw value: thousands separators, a Unicode minus or
 * an accounting "(79,000)" negative, a sign word ("down 0.4"), and a scale
 * word or suffix ("1.2 million", "$3.4bn", "68k") — which is applied, so the
 * value is absolute.
 */
export function parseNumberWithScale(raw: unknown): ParsedNumber | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : undefined;
  if (typeof raw !== "string") return undefined;
  let s = raw
    .normalize("NFKC")
    .trim()
    .replace(/[−‒–—]/g, "-");
  let negative = false;
  if (/^\(\s*[$€£¥]?\s*[\d.,]+[^)]*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  } else if (NEGATIVE_WORDS.test(s)) {
    negative = true;
    s = s.replace(NEGATIVE_WORDS, "");
  }
  const m = s.match(
    /([-+]?)\s*[$€£¥]?\s*((?:(?:\d{1,3}(?:[,_ ]\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?)(\s*)([A-Za-z]+)?/,
  );
  if (!m) return undefined;
  const n = Number(`${m[1]}${m[2]!.replace(/[,_ ]/g, "")}`);
  if (!Number.isFinite(n)) return undefined;
  const word = m[4];
  let scale: number | undefined;
  if (word) {
    for (const [re, mult] of SCALE_WORDS) if (re.test(word)) scale = mult;
    if (!scale && !m[3] && word.length === 1) scale = SCALE_SUFFIXES[word];
  }
  const value = (negative && n > 0 ? -n : n) * (scale ?? 1);
  return { value, ...(scale ? { scale } : {}) };
}

/**
 * A number in the spec's unit. When the unit names a scale ("USD billions",
 * "thousands of persons") and the answer carries a scale word, the answer is
 * converted to the unit's scale ("1,234 million" in billions → 1.234); a bare
 * number is taken as already in the unit.
 */
function numberInUnit(raw: unknown, unit: string | undefined): number | undefined {
  const parsed = parseNumberWithScale(raw);
  if (!parsed) return undefined;
  const unitMult = unitScale(unit);
  if (unitMult && parsed.scale) return parsed.value / unitMult;
  return parsed.value;
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
      const n = numberInUnit(raw, spec.unit);
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
  /** Set when the order-of-magnitude check rescaled this number (the factor applied). */
  rescaled?: number;
}

export interface CombinedAnswer {
  value: AnswerValue;
  /** Weight share (0–1) of the runs that agree with the combined answer. */
  agreement: number;
  /** `confidence` selection: the chosen run's own stated confidence. */
  selfConfidence?: number;
  /** Numbers: how many runs the order-of-magnitude check rescaled. */
  rescaled?: number;
  /** Per-option weight share for choice / multi answers. */
  support?: Record<string, number>;
  /** For numbers: weighted spread of the runs around the combined value. */
  spread?: number;
  method: string;
}

/**
 * How the K runs become one answer:
 *   agreement  — combine by type (plurality, frequency, median, Borda); the
 *                agreement share is the confidence (the default);
 *   confidence — the single run with the highest self-reported confidence
 *                (ties: more weight, then the agreement answer); its own
 *                confidence is the confidence. Same-model runs agreeing
 *                measures consistency, not correctness; a run's own stated
 *                confidence is much better calibrated.
 */
export type SelectionMode = "agreement" | "confidence";
export const SELECTION_MODES: readonly SelectionMode[] = ["agreement", "confidence"];

export interface CombineOptions {
  selection?: SelectionMode;
}

/** Merge K independent answers by type (see the file header). Undefined when none is usable. */
export function combineAnswers(
  spec: AnswerSpec,
  answers: WeightedAnswer[],
  opts: CombineOptions = {},
): CombinedAnswer | undefined {
  const agreed = combineByAgreement(spec, alignScale(spec, answers));
  if (!agreed || opts.selection !== "confidence") return agreed;
  return selectByConfidence(spec, alignScale(spec, answers), agreed);
}

/**
 * The most self-confident run's answer, with its own confidence. A run that
 * stated none counts as 0.5; ties go to more weight, then to the run that
 * agrees with the combined answer, then to the earlier run.
 */
function selectByConfidence(
  spec: AnswerSpec,
  answers: WeightedAnswer[],
  agreed: CombinedAnswer,
): CombinedAnswer {
  const usable = answers.filter((a) => a.weight > 0);
  const key = (v: AnswerValue) =>
    spec.type === "text" ? normalizeText(v as string) : formatAnswer(v).toLowerCase();
  const agreedKey = key(agreed.value);
  const conf = (a: WeightedAnswer) => a.confidence ?? 0.5;
  const best = usable
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) =>
        conf(y.a) - conf(x.a) ||
        y.a.weight - x.a.weight ||
        Number(key(y.a.value) === agreedKey) - Number(key(x.a.value) === agreedKey) ||
        x.i - y.i,
    )[0]!.a;
  const total = usable.reduce((s, a) => s + a.weight, 0);
  const agree = usable
    .filter((a) => key(a.value) === key(best.value))
    .reduce((s, a) => s + a.weight, 0);
  return {
    ...agreed,
    value: best.value,
    agreement: round(agree / total),
    selfConfidence: round(conf(best)),
    method: "most self-confident run",
  };
}

/** Within 3 % of a power-of-ten factor: the same figure written at another scale. */
const SCALE_FACTORS = [1e3, 1e6, 1e9];
function scaleFactorBetween(x: number, ref: number): number | undefined {
  if (x === 0 || ref === 0 || Math.sign(x) !== Math.sign(ref)) return undefined;
  const ratio = Math.abs(x / ref);
  for (const f of SCALE_FACTORS) {
    if (Math.abs(ratio / f - 1) <= 0.03) return 1 / f;
    if (Math.abs(ratio * f - 1) <= 0.03) return f;
  }
  return undefined;
}

/**
 * Order-of-magnitude check for numbers: a run whose value is the weighted
 * median's written at another scale (×1 000, ×1 000 000 …, a thousands /
 * millions confusion) is brought to the median's scale before combining.
 * Needs three or more runs, so a majority sets the scale.
 */
function alignScale(spec: AnswerSpec, answers: WeightedAnswer[]): WeightedAnswer[] {
  if (spec.type !== "number") return answers;
  const usable = answers.filter((a) => a.weight > 0);
  if (usable.length < 3) return answers;
  const sorted = usable
    .map((a) => ({ x: a.value as number, w: a.weight }))
    .sort((p, q) => p.x - q.x);
  const total = sorted.reduce((s, v) => s + v.w, 0);
  const ref = weightedMedian(sorted, total);
  return answers.map((a) => {
    const f = scaleFactorBetween(a.value as number, ref);
    return f ? { ...a, value: (a.value as number) * f, rescaled: f } : a;
  });
}

function combineByAgreement(
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
      const rescaled = usable.filter((a) => a.rescaled).length;
      return {
        value: round(value, 6),
        agreement: round(agree / total),
        spread: round(spread, 6),
        method: `${values.length >= 5 ? "20% trimmed mean" : "weighted median"}${rescaled ? " (scale-aligned)" : ""}`,
        ...(rescaled ? { rescaled } : {}),
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
