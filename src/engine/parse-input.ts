// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

// ─── Shared Command Input Parsing Helpers ─────────────────────────────────────
//
// Centralizes the common parsing patterns used across command handlers.
// Commands can import individual helpers as needed.

import type { CommandInput } from "../types";

/**
 * Get remaining text after skipping N tokens, joined by spaces.
 * Returns empty string if fewer tokens exist.
 */
export function rest(input: CommandInput, skip: number): string {
  return input.tokens.slice(skip).join(" ");
}

/**
 * Split text on a keyword delimiter (case-insensitive).
 * Returns [before, after] or null if delimiter not found.
 *
 * Example: splitOn("sword to Alice", " to ") → ["sword", "Alice"]
 */
export function splitOn(text: string, delimiter: string): [string, string] | null {
  const idx = text.toLowerCase().indexOf(delimiter.toLowerCase());
  if (idx < 0) return null;
  return [text.slice(0, idx).trim(), text.slice(idx + delimiter.length).trim()];
}

/**
 * Extract trailing key-value modifiers from text.
 * Scans for known modifier names at the end of the string.
 *
 * Example: extractModifiers("some text importance 7 type fact", ["importance", "type"])
 *   → { text: "some text", modifiers: { importance: "7", type: "fact" } }
 */
export function extractModifiers(
  text: string,
  known: string[],
): { text: string; modifiers: Record<string, string> } {
  const modifiers: Record<string, string> = {};
  let remaining = text;

  // Process from end so earlier text isn't mistakenly consumed
  for (let pass = 0; pass < known.length; pass++) {
    let matched = false;
    for (const key of known) {
      if (key in modifiers) continue;
      // Match "key value" or "--key value" at end of string
      const pattern = new RegExp(`(?:--|\\b)${key}\\s+(\\S+)\\s*$`, "i");
      const m = remaining.match(pattern);
      if (m) {
        modifiers[key] = m[1]!;
        remaining = remaining.slice(0, remaining.length - m[0].length).trim();
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }

  return { text: remaining, modifiers };
}

/**
 * Extract trailing boolean flags from text.
 * Returns the flag names found and the cleaned text.
 *
 * Example: extractFlags("query text recent", ["recent", "important"])
 *   → { text: "query text", flags: new Set(["recent"]) }
 */
export function extractFlags(text: string, known: string[]): { text: string; flags: Set<string> } {
  const flags = new Set<string>();
  let remaining = text;

  for (const flag of known) {
    const pattern = new RegExp(`(?:--|\\b)${flag}\\s*$`, "i");
    if (pattern.test(remaining)) {
      flags.add(flag);
      remaining = remaining.replace(pattern, "").trim();
    }
  }

  return { text: remaining, flags };
}

/**
 * Parse a token as an integer with optional range validation.
 * Returns null if the token is undefined, empty, NaN, or out of range.
 */
export function int(
  token: string | undefined,
  opts?: { min?: number; max?: number },
): number | null {
  if (!token) return null;
  const n = Number.parseInt(token, 10);
  if (Number.isNaN(n)) return null;
  if (opts?.min !== undefined && n < opts.min) return null;
  if (opts?.max !== undefined && n > opts.max) return null;
  return n;
}

/**
 * Get a specific token by index, optionally lowercased.
 * Returns undefined if the index is out of bounds.
 */
export function token(input: CommandInput, index: number, lower = false): string | undefined {
  const t = input.tokens[index];
  return t && lower ? t.toLowerCase() : t;
}

/**
 * Collapse whitespace / underscores / hyphens in a single token to a single
 * hyphen. "MMLU Pro" → "mmlu-pro", "simple_qa" → "simple-qa". Used as the
 * key-side normalizer for registry lookups.
 */
export function normalizeIdToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Resolve a possibly-multi-word identifier against a registry of canonical
 * names. Users naturally dictate "mmlu pro" or "simple qa" or "aime 2025" —
 * the registry stores "mmlu-pro", "simple-qa", "aime-2025". This resolver
 * lets the parser accept either form without forcing quoting rules that are
 * hostile to voice input.
 *
 * Given tokens starting at `start`, greedily tries the longest run of
 * non-flag tokens (up to `maxWords`), joining with a hyphen, then falls
 * back to shorter runs until it finds a registered name. Returns the
 * canonical name and how many tokens were consumed.
 *
 * Returns null if nothing matches. A single-token name that matches the
 * registry exactly consumes 1 token — backward compatible.
 *
 * Examples:
 *   ["mmlu", "pro", "--limit", "10"] + registry{"mmlu-pro"} → {name:"mmlu-pro", consumed:2}
 *   ["gsm8k", "--limit", "10"] + registry{"gsm8k"}           → {name:"gsm8k",    consumed:1}
 *   ["simple_qa", "--limit", "10"] + registry{"simple-qa"}  → {name:"simple-qa", consumed:1}
 *   ["nope", "foo"] + registry{...}                           → null
 */
export function resolveMultiWordName(
  tokens: readonly string[],
  start: number,
  registry: ReadonlySet<string> | readonly string[],
  maxWords = 4,
): { name: string; consumed: number } | null {
  const keys = registry instanceof Set ? registry : new Set(registry);
  const available = Math.min(tokens.length - start, maxWords);
  // Stop at the first flag-shaped token (--foo or -f).
  let greedyEnd = available;
  for (let i = 0; i < available; i++) {
    const t = tokens[start + i];
    if (!t || t.startsWith("-")) {
      greedyEnd = i;
      break;
    }
  }
  if (greedyEnd === 0) return null;
  // Try longest run first so "simple qa" beats a hypothetical "simple".
  for (let take = greedyEnd; take >= 1; take--) {
    const slice = tokens.slice(start, start + take).map(normalizeIdToken);
    // Variant 1: hyphen-joined ("simple-qa", "aime-2025", "gsm8k")
    const hyphenated = slice.join("-");
    if (keys.has(hyphenated)) return { name: hyphenated, consumed: take };
    // Variant 2: squashed ("gsm 8k" → "gsm8k") for benchmarks whose canonical
    // key lacks a separator between parts (common for dataset names).
    if (take > 1) {
      const squashed = slice.join("");
      if (keys.has(squashed)) return { name: squashed, consumed: take };
    }
  }
  return null;
}
