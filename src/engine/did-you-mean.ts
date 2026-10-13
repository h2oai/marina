// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * "Did you mean" for typed names (commands, providers). Optimal-string-
 * alignment distance: insert, delete, substitute, or swap two adjacent
 * characters each cost 1, so `lok` → `look` and `hepl` → `help` are one edit.
 */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The closest candidate within a small budget (1 edit for short words, about
 * one per three characters for longer ones), or undefined. Ties keep the
 * candidates' order; an exact (case-insensitive) match is not a suggestion.
 */
export function closestName(input: string, candidates: Iterable<string>): string | undefined {
  const word = input.toLowerCase();
  if (!word) return undefined;
  const budget = Math.max(1, Math.floor(word.length / 3));
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const lower = name.toLowerCase();
    if (lower === word) return undefined;
    if (Math.abs(lower.length - word.length) > budget) continue;
    const distance = editDistance(word, lower);
    if (distance <= budget && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}
