// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { query } from "../modes/passthrough";
import type { BenchmarkConfig, DatasetItem, Message, ResultItem } from "../types";

/** Extract the final numeric / symbolic answer from a free-form response.
 *  Priority order:
 *   1. \boxed{...}   (MATH convention)
 *   2. "#### N"      (GSM8K convention)
 *   3. "answer is X"
 *   4. Last number/fraction in the response
 */
export function extractAnswer(rawResponse: string): string {
  // JSON-escape repair: agent answers arrive inside a JSON envelope, where a
  // literal `\b`/`\f` (as in \boxed{…} or \frac{a}{b}) is a legal escape —
  // JSON.parse turns them into backspace/formfeed control chars and the LaTeX
  // markers below never match ("\x08oxed{25}"). Restore them before matching.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: repair JSON-decoded LaTeX escapes
  const response = rawResponse.replace(/\x08/g, "\\b").replace(/\f/g, "\\f");
  // 1. \boxed{…} — balance braces so nested fractions/radicals stay intact.
  let boxed: string | undefined;
  for (const match of response.matchAll(/\\boxed\{/g)) {
    const group = braced(response, match.index + match[0].length - 1);
    if (group) boxed = group.content.trim();
  }
  if (boxed !== undefined) return boxed;

  // 2. "#### N" — GSM8K
  const gsm = response.match(/####\s*(-?[\d,.]+(?:\/[\d]+)?)/);
  if (gsm) return gsm[1]!.replace(/,/g, "").trim();

  // 3. "The answer is X" / "Final answer: X"
  const explicit = response.match(/(?:the\s+)?(?:final\s+)?answer\s*(?:is|:|=)\s*([^\n]+)/i);
  if (explicit) {
    // Stop at the sentence end, then at trailing prose: "18, since …", "1,250 because …".
    // A comma between digits or inside a tuple ("1,250", "(1, 2)") is part of the answer.
    const sentence = explicit[1]!.split(/\.(?!\d)|!/, 1)[0]!.trim();
    return sentence.split(/,\s+(?=\p{L})|\s+(?=\p{L}{2,})/u, 1)[0]!.replace(/^[$\s]+|[$\s]+$/g, "");
  }

  // 4. Last number in text
  const nums = [...response.matchAll(/(-?\d+(?:\.\d+)?(?:\/\d+)?)/g)];
  if (nums.length > 0) return nums[nums.length - 1]![1]!;

  return "";
}

/** Evaluate a small LaTeX-ish numeric answer to a float, or null. Supports
 *  integers/decimals, a/b, \frac{a}{b} (braced or single-digit arguments),
 *  \sqrt{n}, \pi, unary minus, implicit multiplication, degrees and
 *  sums/differences. Grading-only. */
function evalLatex(s: string): number | null {
  const t = s
    .replace(/\\text[a-z]*\{[^}]*\}/gi, "")
    .replace(/\^\s*\\circ|\\circ|\\degree/g, "")
    .replace(/^[a-z]\s*=\s*/i, "")
    .replace(/\\[ ,;:!]/g, "")
    .replace(/\\pi/g, "π");
  if (!t) return null;
  const r = parseSum(t, 0);
  return r && Number.isFinite(r.value) && skipSpace(t, r.next) === t.length ? r.value : null;
}

function skipSpace(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i]!)) i++;
  return i;
}

/** The single-digit argument of an unbraced \frac (`\frac12`). */
function readDigit(t: string, i: number): { value: number; next: number } | null {
  i = skipSpace(t, i);
  return i < t.length && /\d/.test(t[i]!) ? { value: Number(t[i]!), next: i + 1 } : null;
}

/** Content of the braced group at t[i] === "{" and the index after its close. */
function braced(t: string, i: number): { content: string; next: number } | null {
  if (t[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < t.length; j++) {
    if (t[j] === "{") depth++;
    else if (t[j] === "}") {
      depth--;
      if (depth === 0) return { content: t.slice(i + 1, j), next: j + 1 };
    }
  }
  return null;
}

function parseSum(t: string, i: number): { value: number; next: number } | null {
  i = skipSpace(t, i);
  const first = parseProduct(t, i);
  if (!first) return null;
  let value = first.value;
  let next = skipSpace(t, first.next);
  while (next < t.length && (t[next] === "+" || t[next] === "-")) {
    const sign = t[next] === "-" ? -1 : 1;
    const term = parseProduct(t, next + 1);
    if (!term) return null;
    value += sign * term.value;
    next = skipSpace(t, term.next);
  }
  return { value, next };
}

function parseProduct(t: string, i: number): { value: number; next: number } | null {
  i = skipSpace(t, i);
  const first = parseFactor(t, i);
  if (!first) return null;
  let value = first.value;
  let next = skipSpace(t, first.next);
  while (next < t.length && t[next] !== "+" && t[next] !== "-" && t[next] !== ")") {
    const divide = t[next] === "/";
    // Juxtaposed groups/radicals mean multiplication; two bare numbers do not.
    if (!divide && !/[\\(π]/.test(t[next]!)) return null;
    const f = parseFactor(t, divide ? next + 1 : next);
    if (!f) return null;
    if (divide) {
      if (f.value === 0) return null;
      value /= f.value;
    } else value *= f.value;
    next = skipSpace(t, f.next);
  }
  return { value, next };
}

function parseFactor(t: string, i: number): { value: number; next: number } | null {
  i = skipSpace(t, i);
  if (i >= t.length) return null;
  const num = t.slice(i).match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
  if (num) return { value: Number.parseFloat(num[0]), next: i + num[0].length };
  if (t[i] === "-") {
    const f = parseFactor(t, i + 1);
    return f ? { value: -f.value, next: f.next } : null;
  }
  if (t[i] === "π") return { value: Math.PI, next: i + 1 };
  if (t[i] === "(") {
    const r = parseSum(t, i + 1);
    if (!r) return null;
    const close = skipSpace(t, r.next);
    return t[close] === ")" ? { value: r.value, next: close + 1 } : null;
  }
  if (t.startsWith("\\sqrt", i)) {
    const g = braced(t, i + 5);
    if (!g) return null;
    const inner = evalLatex(g.content);
    return inner === null || inner < 0 ? null : { value: Math.sqrt(inner), next: g.next };
  }
  if (t.startsWith("\\frac", i)) {
    let next = i + 5;
    const g1 = braced(t, skipSpace(t, next));
    let num: number;
    if (g1) {
      const v = evalLatex(g1.content);
      if (v === null) return null;
      num = v;
      next = g1.next;
    } else {
      const f = readDigit(t, next);
      if (!f) return null;
      num = f.value;
      next = f.next;
    }
    next = skipSpace(t, next);
    const g2 = braced(t, next);
    let den: number;
    if (g2) {
      const v = evalLatex(g2.content);
      if (v === null) return null;
      den = v;
      next = g2.next;
    } else {
      const f = readDigit(t, next);
      if (!f) return null;
      den = f.value;
      next = f.next;
    }
    return den === 0 ? null : { value: num / den, next };
  }
  return null;
}

/** The elements of a bracketed tuple/interval/vector, or null if `s` is not one. */
function tupleParts(s: string): string[] | null {
  const t = s
    .replace(/\\left|\\right/g, "")
    .replace(/\s+/g, "")
    .replace(/^\$|\$$/g, "");
  const m = t.match(/^[([](.*)[)\]]$/);
  if (!m || !m[1]!.includes(",")) return null;
  return m[1]!.split(",");
}

/** Whitespace-insensitive tuple/vector comparison, with numeric tolerance. */
function tuplesMatch(a: string, b: string): boolean {
  const brackets = (s: string) => s.replace(/\\left|\\right|\s|\$/g, "");
  const aa = brackets(a);
  const bb = brackets(b);
  if (aa[0] !== bb[0] || aa.at(-1) !== bb.at(-1)) return false;
  const pa = tupleParts(a);
  const pb = tupleParts(b);
  if (!pa || !pb || pa.length !== pb.length) return false;
  return pa.every((x, i) => {
    const na = evalLatex(x);
    const nb = evalLatex(pb[i]!);
    if (na !== null && nb !== null) return numsClose(na, nb);
    return x === pb[i];
  });
}

/** Two integers must be equal; otherwise a decimal approximation within
 *  2·10⁻⁴ relative (√3 ≈ 1.7321) counts. */
const numsClose = (a: number, b: number): boolean => {
  if (a === b) return true;
  if (Number.isInteger(a) && Number.isInteger(b)) return false;
  return Math.abs(a - b) <= Math.max(1e-6, 2e-4 * Math.max(Math.abs(a), Math.abs(b)));
};

/** Drop dollar signs (plain or escaped) and thousands separators (`1,250` → `1250`). */
function clean(s: string): string {
  return s
    .trim()
    .replace(/\\?\$/g, "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
}

export function answersMatch(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  // Tuples first, on the raw text: "(1,250)" is a pair, not one thousand two hundred fifty.
  if (tupleParts(a) || tupleParts(b)) return tuplesMatch(a, b);
  const ca = clean(a);
  const cb = clean(b);
  if (/^-?\d+$/.test(ca) && /^-?\d+$/.test(cb)) return BigInt(ca) === BigInt(cb);
  const va = evalLatex(ca);
  const vb = evalLatex(cb);
  if (va !== null && vb !== null) return numsClose(va, vb);
  if (va !== null || vb !== null) return false;
  // Fall back to normalized string equality (LaTeX spacing, case, whitespace).
  const rough = (x: string) =>
    clean(x)
      .toLowerCase()
      .replace(/\\[ ,;:!]/g, "")
      .replace(/\\/g, "")
      .replace(/\s+/g, "");
  return rough(a) === rough(b);
}

export async function runNumeric(
  items: DatasetItem[],
  config: BenchmarkConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ResultItem[]> {
  const results: ResultItem[] = [];
  const queue = [...items];
  let completed = 0;

  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) return;
      const messages: Message[] = [
        {
          role: "system",
          content:
            "Solve the problem step by step. At the end, write your final numeric answer inside \\boxed{...}. If a number, give it as a decimal or integer (not a fraction). No extra text after the boxed answer.",
        },
        { role: "user", content: item.question },
      ];
      const start = performance.now();
      let actual = "";
      let extracted = "";
      let correct = false;
      try {
        const response = await query(config.endpoint, config.model, messages, config.apiKey);
        actual = response;
        extracted = extractAnswer(response);
        correct = answersMatch(extracted, item.answer);
      } catch (e) {
        actual = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      const latencyMs = performance.now() - start;
      results.push({
        id: item.id,
        question: item.question.slice(0, 300),
        expected: item.answer,
        actual: extracted || actual.slice(0, 100),
        correct,
        latencyMs,
        category: item.category,
      });
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, config.concurrency);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
