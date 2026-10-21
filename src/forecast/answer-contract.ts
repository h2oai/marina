// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer contract: an explicit, structured spec of the FORM a question's
 * final answer must take, read from the question's own instructions ("End
 * with \boxed{…}", "a date in YYYY-MM-DD", "rounded to one decimal place",
 * "select up to 3", "in at most five words", "list the top 3"). It refines the
 * typed `AnswerSpec` (`answer-types.ts`, which says WHAT is asked) with HOW it
 * must be written:
 *
 *   single-choice  exactly one option id
 *   multi-select   a set of option ids (pick bounds)
 *   number         one number (unit, integer, decimals)
 *   date           one calendar date in a stated format
 *   ranked-list    an ordered list (size)
 *   free-text      a short string with its format line (word / length limit)
 *
 * plus an optional final wrapper (`\boxed{…}`) and the question's format line
 * verbatim. Carried through the planner, every run, the verifier, the critic,
 * the formations and the judge (`typed.ts`, `formations.ts`), and enforced at
 * the end (`enforceContract`): a lossless normalisation (case, label → id,
 * date reformatting, rounding to the stated decimals, the wrapper) is applied
 * directly; a real violation (not an option, no date, too many words, a short
 * list) is re-asked ONCE, then falls back deterministically (`fallbackFor`).
 *
 * Opt-in: `MARINA_FORECAST_CONTRACT=off|observe|on` (default off — nothing is
 * parsed, no prompt changes, no answer changes); `observe` parses and checks
 * the final answer and records what `on` would do, without carrying the
 * contract or changing anything; `on` carries and enforces it. A request that
 * names its own `contract` is enforced unless the mode is `observe`.
 *
 * Pure functions except `enforceContract`, whose only I/O is the injected
 * re-ask. General capability: nothing here knows a benchmark.
 */

import { escapeRegExp } from "../engine/regexp";
import {
  type AnswerOption,
  type AnswerSpec,
  type AnswerValue,
  matchOption,
  normalizeText,
  parseNumberWithScale,
} from "./answer-types";

export const CONTRACT_FORMS = [
  "single-choice",
  "multi-select",
  "number",
  "date",
  "ranked-list",
  "free-text",
] as const;
export type ContractForm = (typeof CONTRACT_FORMS)[number];

export const DATE_FORMATS = [
  "YYYY-MM-DD",
  "YYYY-MM",
  "YYYY",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "Month D, YYYY",
  "D Month YYYY",
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface AnswerContract {
  form: ContractForm;
  /** single-choice / multi-select: the allowed options. */
  options?: AnswerOption[];
  minPicks?: number;
  maxPicks?: number;
  /** number: the unit it is written in (never appended to the rendered value). */
  unit?: string;
  integer?: boolean;
  /** number: decimal places the value is rounded to and written with. */
  decimals?: number;
  /** date: how the date is written. */
  dateFormat?: DateFormat;
  /** ranked-list: exactly this many items. */
  size?: number;
  /** free-text: word and character limits. */
  maxWords?: number;
  maxLength?: number;
  /** The final answer is wrapped: `boxed` ⇒ `\boxed{<answer>}`. */
  wrapper?: "boxed";
  /** The question's own format instruction, verbatim (≤ 300 characters). */
  formatLine?: string;
}

export const CONTRACT_MODES = ["off", "observe", "on"] as const;
export type ContractMode = (typeof CONTRACT_MODES)[number];

/** `MARINA_FORECAST_CONTRACT`: off (default) | observe | on. */
export function contractModeFromEnv(env: NodeJS.ProcessEnv = process.env): ContractMode {
  const v = env.MARINA_FORECAST_CONTRACT?.trim().toLowerCase();
  return (CONTRACT_MODES as readonly string[]).includes(v ?? "") ? (v as ContractMode) : "off";
}

// ─── Parsing the question's instructions ────────────────────────────────────

/** A line that states how the answer must be given. */
const FORMAT_CUE =
  /\b(?:end (?:your (?:answer|response) )?with|(?:answer|respond|reply) (?:with|in|as|using)|(?:give|write|state|provide|report) (?:the|your) (?:final )?(?:answer|value|date|number)|your (?:final )?answer (?:must|should)|format(?:ted)?\s*(?:as|:)|in the format|report the value in|rounded? to|select (?:up to|at most|exactly|all that apply)|(?:in|using) (?:at most|no more than|under) \w+ words?)\b|\\boxed\{/i;
const MAX_FORMAT_LINE = 300;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const num = (w: string | undefined): number | undefined => {
  if (w === undefined) return undefined;
  const n = NUMBER_WORDS[w.toLowerCase()] ?? Number(w);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
};
const COUNT = "(\\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)";

const DATE_FORMAT_CUES: ReadonlyArray<[RegExp, DateFormat]> = [
  [/\bYYYY-MM-DD\b|\bISO[- ]?8601\b/i, "YYYY-MM-DD"],
  [/\bMM\/DD\/YYYY\b/i, "MM/DD/YYYY"],
  [/\bDD\/MM\/YYYY\b/i, "DD/MM/YYYY"],
  [/\bYYYY-MM\b(?!-)/i, "YYYY-MM"],
  [/\bMonth D(?:D)?,? YYYY\b/i, "Month D, YYYY"],
  [/\bD(?:D)? Month YYYY\b/i, "D Month YYYY"],
];
/** The question asks for a date (without naming a format: ISO is used). */
const DATE_ASKED =
  /^\s*(?:on )?(?:what|which) (?:exact )?(?:date|day)\b|\b(?:give|state|report|answer with) (?:the|a) date\b|\bthe date (?:on which|when)\b/i;

/**
 * The contract a question's own instructions state, refined over its typed
 * spec — or undefined when the text states no answer-form instruction at all
 * (then the spec alone governs, as before).
 */
export function parseAnswerContract(input: {
  question: string;
  context?: string;
  answer?: AnswerSpec;
}): AnswerContract | undefined {
  const text = `${input.question}\n${input.context ?? ""}`;
  const formatLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && FORMAT_CUE.test(l));
  const formatLine = formatLines.join(" ").slice(0, MAX_FORMAT_LINE) || undefined;
  const spec = input.answer;
  const c: AnswerContract = baseContract(spec, text);
  // Without a spec, a form read from the text (yes or no) is itself an instruction.
  let cued = !!formatLine || (!spec && c.form !== "free-text");

  if (/\\boxed\{/.test(text)) {
    c.wrapper = "boxed";
    cued = true;
  }
  // Dates: an explicit format anywhere, or a date question answered as text.
  const fmt = DATE_FORMAT_CUES.find(([re]) => re.test(text))?.[1];
  if ((c.form === "free-text" || c.form === "date") && (fmt || DATE_ASKED.test(input.question))) {
    c.form = "date";
    c.dateFormat = fmt ?? c.dateFormat ?? "YYYY-MM-DD";
    delete c.maxWords;
    delete c.maxLength;
    cued = true;
  }
  if (c.form === "number") {
    const dec = text.match(new RegExp(`\\brounded? to ${COUNT} decimal places?\\b`, "i"));
    const d = num(dec?.[1]);
    if (d !== undefined && d <= 10) {
      c.decimals = d;
      if (d === 0) c.integer = true;
      cued = true;
    }
    if (
      /\b(?:as an? (?:integer|whole number)|to the nearest (?:whole number|integer)|rounded to (?:a|the nearest) whole number)\b/i.test(
        text,
      )
    ) {
      c.integer = true;
      cued = true;
    }
    if (!c.unit) {
      const unit =
        text.match(/\bReport the value in ([^.\n]{1,40})\./i)?.[1] ??
        text.match(/\bin units of ([^.,\n]{1,40})/i)?.[1];
      if (unit) {
        c.unit = unit.trim();
        cued = true;
      }
    }
  }
  if (c.form === "multi-select") {
    const exactly = text.match(new RegExp(`\\bselect exactly ${COUNT}\\b`, "i"));
    const upTo = text.match(
      new RegExp(`\\bselect (?:up to|at most|no more than) ${COUNT}\\b`, "i"),
    );
    const n = num(exactly?.[1]);
    const m = num(upTo?.[1]);
    if (n !== undefined && n > 0) {
      c.minPicks = n;
      c.maxPicks = n;
      cued = true;
    } else if (m !== undefined && m > 0) {
      c.maxPicks = Math.min(m, c.maxPicks ?? m);
      cued = true;
    }
  }
  if (c.form === "ranked-list" && c.size === undefined) {
    const n = num(text.match(new RegExp(`\\blist (?:the )?(?:top )?${COUNT}\\b`, "i"))?.[1]);
    if (n !== undefined && n > 0) {
      c.size = n;
      cued = true;
    }
  }
  if (c.form === "free-text") {
    const words = text.match(
      new RegExp(`\\b(?:in |using )?(?:at most|no more than|under|up to) ${COUNT} words?\\b`, "i"),
    );
    const n = num(words?.[1]);
    if (n !== undefined && n > 0) {
      c.maxWords = n;
      cued = true;
    } else if (/\b(?:a single|one) word\b/i.test(text)) {
      c.maxWords = 1;
      cued = true;
    }
  }
  if (!cued) return undefined;
  if (formatLine) c.formatLine = formatLine;
  return c;
}

/** The contract the typed spec implies (or, without one, what the text suggests). */
function baseContract(spec: AnswerSpec | undefined, text: string): AnswerContract {
  if (spec) {
    switch (spec.type) {
      case "choice":
        return { form: "single-choice", options: spec.options };
      case "multi":
        return {
          form: "multi-select",
          options: spec.options,
          ...(spec.minPicks !== undefined ? { minPicks: spec.minPicks } : {}),
          ...(spec.maxPicks !== undefined ? { maxPicks: spec.maxPicks } : {}),
        };
      case "number":
        return {
          form: "number",
          ...(spec.unit ? { unit: spec.unit } : {}),
          ...(spec.integer ? { integer: true } : {}),
        };
      case "ranking":
        return { form: "ranked-list", ...(spec.size ? { size: spec.size } : {}) };
      case "text":
        return { form: "free-text", ...(spec.maxLength ? { maxLength: spec.maxLength } : {}) };
    }
  }
  if (/\b(?:answer|respond|reply) (?:with )?(?:only )?["“]?yes["”]? or ["“]?no["”]?/i.test(text)) {
    return { form: "single-choice", options: [{ id: "Yes" }, { id: "No" }] };
  }
  return { form: "free-text" };
}

// ─── An explicit contract from untrusted JSON (POST /v1/forecast) ────────────

/** Which contract forms each typed answer accepts. */
const FORMS_FOR: Record<AnswerSpec["type"], readonly ContractForm[]> = {
  choice: ["single-choice"],
  multi: ["multi-select"],
  number: ["number"],
  ranking: ["ranked-list"],
  text: ["free-text", "date"],
};

/**
 * A caller's explicit contract (API body, CLI) checked against its typed
 * spec — or the reason it is invalid. Options always come from the spec;
 * the form must fit the spec's type (a date or free text for `text`).
 */
export function parseContractSpec(
  raw: unknown,
  spec: AnswerSpec,
): { contract: AnswerContract } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "contract must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const form = r.form;
  if (typeof form !== "string" || !(CONTRACT_FORMS as readonly string[]).includes(form)) {
    return { error: `contract.form must be one of ${CONTRACT_FORMS.join(", ")}` };
  }
  if (!FORMS_FOR[spec.type].includes(form as ContractForm)) {
    return {
      error: `contract.form ${form} does not fit answer.type ${spec.type} (use ${FORMS_FOR[spec.type].join(" or ")})`,
    };
  }
  const int = (k: string, lo: number, hi: number): number | undefined | { error: string } => {
    const v = r[k];
    if (v === undefined) return undefined;
    return Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
      ? (v as number)
      : { error: `contract.${k} must be an integer ${lo}–${hi}` };
  };
  const str = (k: string, max: number): string | undefined | { error: string } => {
    const v = r[k];
    if (v === undefined) return undefined;
    return typeof v === "string" && v.trim() && v.length <= max
      ? v.trim()
      : { error: `contract.${k} must be a non-empty string of at most ${max} characters` };
  };
  const c: AnswerContract = { form: form as ContractForm };
  if (spec.type === "choice" || spec.type === "multi") c.options = spec.options;
  const fields: Array<[keyof AnswerContract, number | string | undefined | { error: string }]> = [
    ["minPicks", int("minPicks", 0, 64)],
    ["maxPicks", int("maxPicks", 1, 64)],
    ["decimals", int("decimals", 0, 10)],
    ["size", int("size", 1, 50)],
    ["maxWords", int("maxWords", 1, 500)],
    ["maxLength", int("maxLength", 1, 2_000)],
    ["unit", str("unit", 40)],
    ["formatLine", str("formatLine", MAX_FORMAT_LINE)],
  ];
  for (const [k, v] of fields) {
    if (v === undefined) continue;
    if (typeof v === "object") return v;
    (c as unknown as Record<string, unknown>)[k] = v;
  }
  if (r.integer !== undefined) {
    if (typeof r.integer !== "boolean") return { error: "contract.integer must be a boolean" };
    if (r.integer) c.integer = true;
  }
  if (r.dateFormat !== undefined) {
    if (!(DATE_FORMATS as readonly unknown[]).includes(r.dateFormat)) {
      return { error: `contract.dateFormat must be one of ${DATE_FORMATS.join(", ")}` };
    }
    c.dateFormat = r.dateFormat as DateFormat;
  }
  if (r.wrapper !== undefined) {
    if (r.wrapper !== "boxed") return { error: 'contract.wrapper must be "boxed"' };
    c.wrapper = "boxed";
  }
  if (c.form === "date" && !c.dateFormat) c.dateFormat = "YYYY-MM-DD";
  if (c.minPicks !== undefined && c.maxPicks !== undefined && c.minPicks > c.maxPicks) {
    return { error: "contract.minPicks exceeds contract.maxPicks" };
  }
  return { contract: c };
}

// ─── Prompt text ─────────────────────────────────────────────────────────────

/** The contract as one instruction for every model that writes or checks the answer. */
export function contractInstruction(c: AnswerContract): string {
  const ids = (c.options ?? []).map((o) => o.id).join(", ");
  const form = (() => {
    switch (c.form) {
      case "single-choice":
        return `exactly one option id${ids ? ` (one of ${ids})` : ""}`;
      case "multi-select": {
        const bounds =
          c.minPicks !== undefined && c.minPicks === c.maxPicks
            ? `exactly ${c.minPicks}`
            : c.maxPicks !== undefined
              ? `at most ${c.maxPicks}`
              : "one or more";
        return `a set of option ids — ${bounds}${ids ? ` from ${ids}` : ""}`;
      }
      case "number":
        return [
          "one number",
          c.unit ? `in ${c.unit}` : "",
          c.integer ? "an integer" : "",
          c.decimals !== undefined && !c.integer ? `rounded to ${c.decimals} decimal place(s)` : "",
        ]
          .filter(Boolean)
          .join(", ");
      case "date":
        return `one calendar date written ${c.dateFormat ?? "YYYY-MM-DD"}`;
      case "ranked-list":
        return `an ordered list${c.size ? ` of exactly ${c.size} items` : ""}, first = top`;
      case "free-text":
        return [
          "a short text",
          c.maxWords ? `of at most ${c.maxWords} word(s)` : "",
          c.maxLength ? `of at most ${c.maxLength} characters` : "",
        ]
          .filter(Boolean)
          .join(" ");
    }
  })();
  return [
    `Required answer form (from the question's own instructions): ${form}.`,
    c.formatLine ? `The question's format line: "${c.formatLine}"` : "",
    c.wrapper === "boxed"
      ? 'Put the bare value in "answer" — the final \\boxed{…} wrapper is added afterwards.'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Checking and normalising ───────────────────────────────────────────────

export type ContractCheck =
  | { ok: true; value: AnswerValue; rendered: string; normalized: boolean }
  | { ok: false; violation: string };

/** Strip one surrounding `\boxed{…}` (and stray quotes / whitespace). */
export function unwrap(raw: string): string {
  const t = raw.trim();
  const boxed = t.match(/^\\boxed\{([\s\S]*)\}$/) ?? t.match(/\\boxed\{([^{}]*)\}/);
  return (boxed ? boxed[1]! : t).trim().replace(/^["'`]+|["'`]+$/g, "");
}

function asItems(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "number") return [String(raw)];
  if (typeof raw !== "string") return [];
  const t = unwrap(raw);
  // "1. X 2. Y" / "1) X" numbered lists, else comma / semicolon / newline / pipe.
  const numbered = t.split(/(?:^|\s)\d{1,2}[.)]\s+/).filter((s) => s.trim());
  const parts = /(?:^|\s)1[.)]\s+/.test(t) && numbered.length > 1 ? numbered : t.split(/[,;|\n]/);
  return parts.map((s) => s.trim().replace(/[.,;]+$/, "")).filter(Boolean);
}

/** The answer as a single string (lists comma-joined) before any normalisation. */
function asText(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).join(", ");
  if (raw === undefined || raw === null) return "";
  return String(raw);
}

/** Write a contract's value, wrapped as required. */
export function renderContract(c: AnswerContract, value: AnswerValue): string {
  let s: string;
  if (Array.isArray(value)) s = value.join(", ");
  else if (typeof value === "number") {
    s =
      c.decimals !== undefined && !c.integer
        ? value.toFixed(c.decimals)
        : Number.isInteger(value)
          ? String(value)
          : String(Math.round(value * 1e6) / 1e6);
  } else s = value;
  return c.wrapper === "boxed" ? `\\boxed{${s}}` : s;
}

const ok = (c: AnswerContract, value: AnswerValue, normalized: boolean): ContractCheck => ({
  ok: true,
  value,
  rendered: renderContract(c, value),
  normalized,
});

/**
 * Whether a raw answer meets the contract, normalised losslessly when it can
 * be (case, a label for its id, a wrapper, a date in another notation, a
 * number rounded to the stated decimals, a list cut to its size); otherwise
 * the violation.
 */
export function checkContract(c: AnswerContract, raw: unknown): ContractCheck {
  const text = asText(raw);
  const bare = unwrap(text);
  if (!bare && c.form !== "multi-select") return { ok: false, violation: "an empty answer" };
  switch (c.form) {
    case "single-choice": {
      const items = asItems(raw);
      if (items.length !== 1) return { ok: false, violation: "not exactly one option" };
      const o = matchOption(items[0]!, c.options ?? []);
      if (!o) return { ok: false, violation: `"${items[0]!.slice(0, 40)}" is not an option` };
      return ok(c, o.id, o.id !== bare);
    }
    case "multi-select": {
      const ids: string[] = [];
      for (const item of asItems(raw)) {
        const o = matchOption(item, c.options ?? []);
        if (!o) return { ok: false, violation: `"${item.slice(0, 40)}" is not an option` };
        if (!ids.includes(o.id)) ids.push(o.id);
      }
      if (ids.length < (c.minPicks ?? 1)) return { ok: false, violation: "too few options" };
      if (c.maxPicks !== undefined && ids.length > c.maxPicks) {
        return { ok: false, violation: `more than ${c.maxPicks} options` };
      }
      const order = new Map((c.options ?? []).map((o, i) => [o.id, i]));
      const sorted = ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      return ok(c, sorted, sorted.join(", ") !== bare);
    }
    case "number": {
      const found = numbersIn(bare);
      if (found.length === 0) return { ok: false, violation: "no number" };
      if (found.length > 1) return { ok: false, violation: "more than one number" };
      let v = found[0]!;
      if (c.integer) v = Math.round(v);
      else if (c.decimals !== undefined) v = Number(v.toFixed(c.decimals));
      const value = v;
      return ok(c, value, renderContract({ ...c, wrapper: undefined }, value) !== bare);
    }
    case "date": {
      const dates = datesIn(bare, c.dateFormat);
      const distinct = [...new Set(dates.map((d) => formatDate(d, c.dateFormat)))];
      if (distinct.length === 0) return { ok: false, violation: "no date" };
      if (distinct.length > 1) return { ok: false, violation: "more than one date" };
      return ok(c, distinct[0]!, distinct[0] !== bare);
    }
    case "ranked-list": {
      const items: string[] = [];
      for (const item of asItems(raw)) {
        if (!items.some((x) => normalizeText(x) === normalizeText(item))) items.push(item);
      }
      if (items.length === 0) return { ok: false, violation: "an empty list" };
      if (c.size !== undefined && items.length < c.size) {
        return { ok: false, violation: `${items.length} of ${c.size} items` };
      }
      const value = c.size !== undefined ? items.slice(0, c.size) : items;
      return ok(c, value, value.join(", ") !== bare);
    }
    case "free-text": {
      const words = bare.split(/\s+/).filter(Boolean).length;
      if (c.maxWords !== undefined && words > c.maxWords) {
        return { ok: false, violation: `${words} words (at most ${c.maxWords})` };
      }
      if (c.maxLength !== undefined && bare.length > c.maxLength) {
        return { ok: false, violation: `${bare.length} characters (at most ${c.maxLength})` };
      }
      return ok(c, bare, bare !== text.trim());
    }
  }
}

/**
 * The deterministic fallback after a failed re-ask: the closest thing to the
 * contract's form that the answer (or, for choices, its probabilities)
 * supports — the first option named, else the most probable, else the first
 * option; the first number or date; a list cut to its size; text cut to its
 * limit. Undefined when nothing in the answer can be put in the form (no
 * number, no date, an empty list).
 */
export function fallbackFor(
  c: AnswerContract,
  raw: unknown,
  distribution?: Record<string, number>,
): { value: AnswerValue; rendered: string } | undefined {
  const text = unwrap(asText(raw));
  const done = (value: AnswerValue) => ({ value, rendered: renderContract(c, value) });
  const options = c.options ?? [];
  const named = options.filter((o) =>
    new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(o.id)}($|[^A-Za-z0-9])`).test(text),
  );
  const byProbability = [...options].sort(
    (a, b) => (distribution?.[b.id] ?? 0) - (distribution?.[a.id] ?? 0),
  );
  switch (c.form) {
    case "single-choice": {
      const pick = named[0] ?? (distribution ? byProbability[0] : undefined) ?? options[0];
      return pick ? done(pick.id) : undefined;
    }
    case "multi-select": {
      let ids = named.map((o) => o.id);
      if (c.maxPicks !== undefined) ids = ids.slice(0, c.maxPicks);
      for (const o of distribution ? byProbability : options) {
        if (ids.length >= (c.minPicks ?? 1)) break;
        if (!ids.includes(o.id)) ids.push(o.id);
      }
      const order = new Map(options.map((o, i) => [o.id, i]));
      return ids.length
        ? done(ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)))
        : undefined;
    }
    case "number": {
      const n = numbersIn(text)[0];
      if (n === undefined) return undefined;
      return done(
        c.integer ? Math.round(n) : c.decimals !== undefined ? Number(n.toFixed(c.decimals)) : n,
      );
    }
    case "date": {
      const d = datesIn(text, c.dateFormat)[0];
      return d ? done(formatDate(d, c.dateFormat)) : undefined;
    }
    case "ranked-list": {
      const items = asItems(raw);
      if (items.length === 0) return undefined;
      return done(c.size !== undefined ? items.slice(0, c.size) : items);
    }
    case "free-text": {
      let t = text;
      if (c.maxWords !== undefined) t = t.split(/\s+/).slice(0, c.maxWords).join(" ");
      if (c.maxLength !== undefined) t = t.slice(0, c.maxLength).trim();
      return t ? done(t) : undefined;
    }
  }
}

/** Every number written in the text (scale words applied), ignoring list numbering. */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re =
    /[-+−]?\s*[$€£¥]?\s*(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*(?:trillions?|billions?|millions?|thousands?|bn|mn|tn)\b|[kKMBT]\b)?/g;
  for (const m of text.matchAll(re)) {
    const p = parseNumberWithScale(m[0].replace(/^\s+/, ""));
    if (p && !out.includes(p.value)) out.push(p.value);
  }
  return out;
}

// ─── Dates ──────────────────────────────────────────────────────────────────

interface YMD {
  y: number;
  m?: number;
  d?: number;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_RE =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const monthOf = (s: string) =>
  MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))) + 1;

function realDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Every date written in the text, in order; numeric day/month order follows the format. */
export function datesIn(text: string, format?: DateFormat): YMD[] {
  const found: Array<{ at: number; date: YMD }> = [];
  const taken: Array<[number, number]> = [];
  const add = (at: number, len: number, date: YMD) => {
    if (taken.some(([a, b]) => at < b && at + len > a)) return;
    if (date.d !== undefined && !realDate(date.y, date.m!, date.d)) return;
    if (date.m !== undefined && (date.m < 1 || date.m > 12)) return;
    taken.push([at, at + len]);
    found.push({ at, date });
  };
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    add(m.index!, m[0].length, { y: +m[1]!, m: +m[2]!, d: +m[3]! });
  }
  for (const m of text.matchAll(
    new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
  )) {
    add(m.index!, m[0].length, { y: +m[3]!, m: monthOf(m[1]!), d: +m[2]! });
  }
  for (const m of text.matchAll(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`,
      "gi",
    ),
  )) {
    add(m.index!, m[0].length, { y: +m[3]!, m: monthOf(m[2]!), d: +m[1]! });
  }
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) {
    const a = +m[1]!;
    const b = +m[2]!;
    const dayFirst = format === "DD/MM/YYYY" || (a > 12 && b <= 12);
    add(m.index!, m[0].length, dayFirst ? { y: +m[3]!, m: b, d: a } : { y: +m[3]!, m: a, d: b });
  }
  if (format === "YYYY-MM" || format === "YYYY") {
    for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})\b(?!-\d)/g)) {
      add(m.index!, m[0].length, { y: +m[1]!, m: +m[2]! });
    }
    for (const m of text.matchAll(new RegExp(`\\b${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"))) {
      add(m.index!, m[0].length, { y: +m[2]!, m: monthOf(m[1]!) });
    }
  }
  if (format === "YYYY") {
    for (const m of text.matchAll(/\b(1[89]\d\d|2\d\d\d)\b/g)) {
      add(m.index!, m[0].length, { y: +m[1]! });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.date);
}

const pad = (n: number) => String(n).padStart(2, "0");
const monthName = (m: number) => MONTHS[m - 1]!.charAt(0).toUpperCase() + MONTHS[m - 1]!.slice(1);

/** A date in the contract's format; a coarser date is written at its own precision. */
export function formatDate(d: YMD, format: DateFormat = "YYYY-MM-DD"): string {
  if (format === "YYYY") return String(d.y);
  if (d.m === undefined) return String(d.y);
  if (format === "YYYY-MM" || d.d === undefined) return `${d.y}-${pad(d.m)}`;
  switch (format) {
    case "YYYY-MM-DD":
      return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    case "MM/DD/YYYY":
      return `${pad(d.m)}/${pad(d.d)}/${d.y}`;
    case "DD/MM/YYYY":
      return `${pad(d.d)}/${pad(d.m)}/${d.y}`;
    case "Month D, YYYY":
      return `${monthName(d.m)} ${d.d}, ${d.y}`;
    case "D Month YYYY":
      return `${d.d} ${monthName(d.m)} ${d.y}`;
  }
}

// ─── Enforcement ────────────────────────────────────────────────────────────

/** What the final check found and did — kept on the answer (the audit trail). */
export interface ContractRecord {
  contract: AnswerContract;
  /** `observe`: checked and recorded only; `on`: enforced. */
  mode: "observe" | "on";
  /**
   *   ok          the answer met the contract as written
   *   normalized  it met it after a lossless rewrite
   *   reasked     it violated it; the one re-ask fixed it
   *   fallback    the re-ask did not; the deterministic fallback was used
   *   violation   still unmet (observe mode, or nothing could be put in the form)
   */
  status: "ok" | "normalized" | "reasked" | "fallback" | "violation";
  /** The answer as the pipeline produced it. */
  before?: string;
  /** The final answer written in the contract's form (wrapper included). */
  rendered?: string;
  /** The contract's value (what replaced the prediction when it changed). */
  value?: AnswerValue;
  violations: string[];
  reask?: { model?: string; accepted: boolean; error?: string };
}

export interface ReaskReply {
  answer?: unknown;
  model?: string;
  error?: string;
}

/**
 * Check `raw` against the contract. `on`: normalise, else re-ask once
 * (`reask`, given the violation), else fall back deterministically. `observe`:
 * the same check, recorded, with no re-ask and no rewrite (`status` says what
 * `on` would have started from). Never throws.
 */
export async function enforceContract(
  c: AnswerContract,
  raw: unknown,
  opts: {
    mode: "observe" | "on";
    reask?: (violation: string) => Promise<ReaskReply>;
    distribution?: Record<string, number>;
  },
): Promise<ContractRecord> {
  const before = raw === undefined ? undefined : asText(raw);
  const rec: ContractRecord = {
    contract: c,
    mode: opts.mode,
    status: "ok",
    ...(before !== undefined ? { before } : {}),
    violations: [],
  };
  const first = checkContract(c, raw);
  if (first.ok) {
    rec.status = first.normalized ? "normalized" : "ok";
    rec.rendered = first.rendered;
    rec.value = first.value;
    return rec;
  }
  rec.violations.push(first.violation);
  if (opts.mode === "observe") {
    rec.status = "violation";
    return rec;
  }
  if (opts.reask) {
    let reply: ReaskReply;
    try {
      reply = await opts.reask(first.violation);
    } catch (err) {
      reply = { error: err instanceof Error ? err.message : String(err) };
    }
    const second = reply.error === undefined ? checkContract(c, reply.answer) : undefined;
    rec.reask = {
      ...(reply.model ? { model: reply.model } : {}),
      accepted: !!second?.ok,
      ...(reply.error !== undefined ? { error: reply.error.slice(0, 160) } : {}),
    };
    if (second?.ok) {
      rec.status = "reasked";
      rec.rendered = second.rendered;
      rec.value = second.value;
      return rec;
    }
    if (second && !second.ok) rec.violations.push(`re-ask: ${second.violation}`);
  }
  const fb = fallbackFor(c, raw, opts.distribution);
  if (fb) {
    rec.status = "fallback";
    rec.rendered = fb.rendered;
    rec.value = fb.value;
  } else rec.status = "violation";
  return rec;
}

/** The re-ask prompt: restate the SAME forecast in the required form. */
export function reaskPrompt(
  c: AnswerContract,
  question: string,
  answer: string,
  violation: string,
): { system: string; user: string } {
  return {
    system: [
      "You restate a forecast's final answer in the exact form the question requires.",
      "Do not change what is forecast — only how it is written.",
      'Reply with ONE JSON object: {"answer": <the same answer in the required form>}.',
    ].join(" "),
    user: [
      `Question: ${question.slice(0, 1_000)}`,
      contractInstruction(c),
      `The forecast's answer: ${answer.slice(0, 600) || "(none)"}`,
      `Problem: ${violation}`,
    ].join("\n"),
  };
}
