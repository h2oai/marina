// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Output repair — deliver a model's output to where it needs to go when it
 * misses the required shape (prose where a tool call or JSON was owed, a fenced
 * or chatty answer, malformed arguments), without changing what it says.
 *
 *  1. Deterministic parse: the output as-is, then mechanical candidates (reasoning
 *     blocks stripped, code fences and surrounding prose removed, trailing commas
 *     dropped, an explicit "final answer" line or `\boxed{}` taken).
 *  2. ONE bounded repair shot (the same model, or `MARINA_REPAIR_MODEL` where the
 *     caller can reach it) that only RE-ENCODES: its result is kept only when every
 *     value in it appears verbatim in the original output (`groundedIn`), so a
 *     shot cannot answer, solve, or add a fact, name, id or number.
 *  3. Labelled delivery: `repaired:parse` or `repaired:shot`, carried in the event
 *     or header of each caller; unrepaired output is never relabelled.
 *
 * `MARINA_OUTPUT_REPAIR=on|parse|off` (default `on`): `parse` skips the shot,
 * `off` returns only output that already met the contract (raw-output callers).
 * Works with one local model: the shot uses whatever model the caller has.
 */

export type RepairLabel = "repaired:parse" | "repaired:shot";
export type RepairMode = "on" | "parse" | "off";

export function outputRepairMode(env: NodeJS.ProcessEnv = process.env): RepairMode {
  const raw = (env.MARINA_OUTPUT_REPAIR ?? "").trim().toLowerCase();
  return raw === "off" || raw === "parse" ? raw : "on";
}

/** One model call: `(system, user) → text`. Throws or returns "" on failure. */
export type RepairShot = (system: string, user: string) => Promise<string>;

export interface Repaired<T> {
  value: T;
  /** null = the output met the contract as delivered. */
  label: RepairLabel | null;
}

/** System prompt for the repair shot: re-encode, never answer. */
export const REENCODE_SYSTEM = [
  "You re-encode text into a required format. You are not answering anything.",
  "Copy every value VERBATIM from the text: do not solve, infer, correct, summarize,",
  "add or remove any fact, number, name, id or claim. If the text does not already",
  "contain what the format asks for, output exactly NONE.",
].join(" ");

/** Bound on the original output shown to the repair shot. */
const SHOT_INPUT_MAX_CHARS = 12_000;

// ─── Deterministic candidates ─────────────────────────────────────────────

/** Remove `<think>…</think>` / `<reasoning>…</reasoning>` blocks (and an unclosed leading one). */
export function stripReasoning(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^\s*<(think|thinking|reasoning)>[\s\S]*$/i, "")
    .trim();
}

/** Bodies of fenced code blocks, in order. */
function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```[\w-]*\s*\n?([\s\S]*?)```/g)].map((m) => (m[1] ?? "").trim());
}

/** The first balanced `{…}` or `[…]` span (string-aware), if any. */
export function balancedJsonSpan(text: string): string | undefined {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") {
        if (stack.pop() !== ch) break;
        if (stack.length === 0) return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/** Mechanical JSON fixes: smart quotes, trailing commas. */
function looseJson(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

/** Parse JSON from model output: as-is, then fenced, then the first balanced span, loosened. */
export function extractJsonValue(text: string): unknown | undefined {
  const base = stripReasoning(text);
  const tries = [base, ...fencedBlocks(base)];
  const span = balancedJsonSpan(base);
  if (span) tries.push(span);
  for (const t of tries) {
    for (const candidate of [t, looseJson(t)]) {
      try {
        return JSON.parse(candidate);
      } catch {
        // allow-empty-catch: try the next mechanical candidate
      }
    }
  }
  return undefined;
}

/**
 * An explicitly marked final answer: `\boxed{…}`, or the last line starting
 * "final answer:" / "answer:" (markdown emphasis tolerated). Undefined when the
 * output marks none — a deterministic parse never guesses.
 */
export function extractMarkedAnswer(text: string): string | undefined {
  const body = stripReasoning(text);
  const boxed = [...body.matchAll(/\\boxed\{((?:[^{}]|\{[^{}]*\})*)\}/g)].at(-1)?.[1]?.trim();
  if (boxed) return boxed;
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]?.match(
      /^\s*(?:[-*>#]+\s*)?(?:\*\*|__)?\s*(?:final\s+answer|answer)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.+?)\s*(?:\*\*|__)?\s*$/i,
    );
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

// ─── Meaning preservation ────────────────────────────────────────────────

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * True when every scalar inside `value` appears verbatim (up to whitespace and
 * case) in `source`: strings, numbers and booleans-as-written. Object KEYS are
 * format, not content, and are not checked. Empty strings and null pass.
 */
export function groundedIn(value: unknown, source: string): boolean {
  const hay = squash(source);
  const exact = source.replace(/\s+/g, " ");
  // Short tokens and numbers must stand alone, with their case ("A" is not
  // grounded by "a tough call", 7 not by 17); longer strings match as
  // substrings up to whitespace and case.
  const present = (needle: string): boolean => {
    const trimmed = needle.replace(/\s+/g, " ").trim();
    if (trimmed.length > 3 && !/^-?[\d.,]+$/.test(trimmed)) return hay.includes(squash(trimmed));
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(exact);
  };
  const check = (v: unknown): boolean => {
    if (v === null || v === undefined || v === "") return true;
    if (typeof v === "string") return present(v);
    if (typeof v === "number") return present(String(v));
    if (typeof v === "boolean") return true;
    if (Array.isArray(v)) return v.every(check);
    if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(check);
    return false;
  };
  return check(value);
}

// ─── The repair pipeline ─────────────────────────────────────────────────

export interface RepairRequest<T> {
  /** The model's output. */
  raw: string;
  /** Contract check: the value when `text` meets the contract, else undefined. */
  parse: (text: string) => T | undefined;
  /** The required format, in one or two sentences, for the repair shot. */
  contract: string;
  /** Optional mechanical candidates tried after `raw` (before the shot). */
  candidates?: (raw: string) => string[];
  /** The bounded repair call; absent = no shot. */
  shot?: RepairShot;
  /** Extra meaning-preservation check for a shot result (default: `groundedIn`). */
  preserves?: (value: T, raw: string) => boolean;
  mode?: RepairMode;
}

/** Default mechanical candidates: reasoning stripped, fenced bodies, JSON span, marked answer. */
export function defaultCandidates(raw: string): string[] {
  const body = stripReasoning(raw);
  const out = [body, ...fencedBlocks(body)];
  const span = balancedJsonSpan(body);
  if (span) out.push(span, looseJson(span));
  const marked = extractMarkedAnswer(raw);
  if (marked) out.push(marked);
  return out.filter((c, i) => c && out.indexOf(c) === i && c !== raw);
}

/**
 * Bring `raw` to the contract. Returns the value with its label, or undefined
 * when neither a mechanical candidate nor the one shot produced a value that
 * meets the contract without adding content. Never throws.
 */
export async function repairOutput<T>(req: RepairRequest<T>): Promise<Repaired<T> | undefined> {
  const mode = req.mode ?? outputRepairMode();
  const asIs = safeParse(req.parse, req.raw);
  if (asIs !== undefined) return { value: asIs, label: null };
  if (mode === "off") return undefined;
  for (const candidate of (req.candidates ?? defaultCandidates)(req.raw)) {
    const value = safeParse(req.parse, candidate);
    if (value !== undefined) return { value, label: "repaired:parse" };
  }
  if (mode !== "on" || !req.shot || !req.raw.trim()) return undefined;
  let reply: string;
  try {
    reply = await req.shot(
      REENCODE_SYSTEM,
      `Required format: ${req.contract}\n\nText to re-encode:\n<<<\n${req.raw.slice(-SHOT_INPUT_MAX_CHARS)}\n>>>`,
    );
  } catch {
    return undefined;
  }
  const trimmed = stripReasoning(reply ?? "").trim();
  if (!trimmed || /^NONE\.?$/i.test(trimmed)) return undefined;
  const preserves = req.preserves ?? ((value: T, raw: string) => groundedIn(value, raw));
  for (const candidate of [trimmed, ...defaultCandidates(trimmed)]) {
    const value = safeParse(req.parse, candidate);
    if (value !== undefined && preserves(value, req.raw)) {
      return { value, label: "repaired:shot" };
    }
  }
  return undefined;
}

function safeParse<T>(parse: (text: string) => T | undefined, text: string): T | undefined {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

// ─── Common contracts ────────────────────────────────────────────────────

/** Contract for "a final answer": `{"answer": "<verbatim>"}` (or a marked answer line). */
export const FINAL_ANSWER_CONTRACT =
  'one line of JSON {"answer": "<the final answer the text gives, copied verbatim>"}';

/** Parse a final-answer re-encoding: `{"answer": "…"}`, a marked line, or `\boxed{}`. */
export function parseFinalAnswer(text: string): string | undefined {
  const json = extractJsonValue(text);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const answer = (json as Record<string, unknown>).answer;
    if (typeof answer === "string" && answer.trim()) return answer.trim();
    if (typeof answer === "number") return String(answer);
  }
  return undefined;
}

/**
 * The final answer in a model's prose: a marked answer deterministically, else
 * one re-encoding shot whose answer must appear verbatim in the prose.
 */
export function repairFinalAnswer(
  raw: string,
  opts: { shot?: RepairShot; mode?: RepairMode } = {},
): Promise<Repaired<string> | undefined> {
  return repairOutput<string>({
    raw,
    parse: parseFinalAnswer,
    contract: FINAL_ANSWER_CONTRACT,
    candidates: (text) => {
      const marked = extractMarkedAnswer(text);
      return marked ? [JSON.stringify({ answer: marked })] : [];
    },
    ...(opts.shot ? { shot: opts.shot } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
}
