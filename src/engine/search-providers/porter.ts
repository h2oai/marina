// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Porter (1980) stemmer, as SQLite FTS5's `porter` tokenizer applies it
 * to lower-case ASCII tokens, so the corpus rescorer counts the same terms
 * FTS5 indexed. Non-ASCII tokens and tokens of one or two letters pass
 * through unchanged (FTS5 does the same). Reference: M.F. Porter, "An
 * algorithm for suffix stripping", Program 14(3), 1980.
 */

function isCons(w: string, i: number): boolean {
  const c = w[i]!;
  if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return false;
  if (c === "y") return i === 0 ? true : !isCons(w, i - 1);
  return true;
}

/** m() — the number of VC sequences in w[0..end). */
function measure(w: string, end: number): number {
  let n = 0;
  let i = 0;
  while (i < end && isCons(w, i)) i++;
  while (i < end) {
    while (i < end && !isCons(w, i)) i++;
    if (i >= end) break;
    n++;
    while (i < end && isCons(w, i)) i++;
  }
  return n;
}

function hasVowel(w: string, end: number): boolean {
  for (let i = 0; i < end; i++) if (!isCons(w, i)) return true;
  return false;
}

function doubleCons(w: string, end: number): boolean {
  return end >= 2 && w[end - 1] === w[end - 2] && isCons(w, end - 1);
}

/** *o — the stem ends cvc, where the second c is not w, x or y. */
function cvc(w: string, end: number): boolean {
  if (end < 3 || !isCons(w, end - 1) || isCons(w, end - 2) || !isCons(w, end - 3)) return false;
  const c = w[end - 1]!;
  return c !== "w" && c !== "x" && c !== "y";
}

/** Replace `suffix` by `to` when the remaining stem has m() > `min`. */
function swap(w: string, suffix: string, to: string, min: number): string | undefined {
  if (!w.endsWith(suffix)) return undefined;
  const stem = w.length - suffix.length;
  return measure(w, stem) > min ? w.slice(0, stem) + to : w;
}

const STEP2: Array<[string, string]> = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["bli", "ble"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
  ["logi", "log"],
];
const STEP3: Array<[string, string]> = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
];
const STEP4 = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ion",
  "ou",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
];

/** The Porter stem of a lower-case token. */
export function porterStem(word: string): string {
  if (word.length <= 2 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies") && w.length > 3) w = w.slice(0, -2);
  else if (w.endsWith("ss")) {
    // unchanged
  } else if (w.endsWith("s")) w = w.slice(0, -1);
  // Step 1b
  let extra = false;
  if (w.endsWith("eed")) {
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w, w.length - 2)) {
    w = w.slice(0, -2);
    extra = true;
  } else if (w.endsWith("ing") && hasVowel(w, w.length - 3)) {
    w = w.slice(0, -3);
    extra = true;
  }
  if (extra) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (doubleCons(w, w.length) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w, w.length) === 1 && cvc(w, w.length)) w += "e";
  }
  // Step 1c
  if (w.endsWith("y") && hasVowel(w, w.length - 1)) w = `${w.slice(0, -1)}i`;
  // Step 2 (longest matching suffix only)
  for (const [s, t] of STEP2) {
    if (w.endsWith(s)) {
      w = swap(w, s, t, 0) ?? w;
      break;
    }
  }
  // Step 3
  for (const [s, t] of STEP3) {
    if (w.endsWith(s)) {
      w = swap(w, s, t, 0) ?? w;
      break;
    }
  }
  // Step 4
  let longest = "";
  for (const s of STEP4) if (w.endsWith(s) && s.length > longest.length) longest = s;
  if (longest) {
    const stem = w.length - longest.length;
    if (measure(w, stem) > 1) {
      if (longest !== "ion" || /[st]$/.test(w.slice(0, stem))) w = w.slice(0, stem);
    }
  } else if (w.endsWith("sion") || w.endsWith("tion")) {
    // covered by "ion" above
  }
  // Step 5a
  if (w.endsWith("e")) {
    const m = measure(w, w.length - 1);
    if (m > 1 || (m === 1 && !cvc(w, w.length - 1))) w = w.slice(0, -1);
  }
  // Step 5b
  if (measure(w, w.length) > 1 && doubleCons(w, w.length) && w.endsWith("l")) w = w.slice(0, -1);
  return w;
}
