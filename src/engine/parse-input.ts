// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Shared Command Input Parsing Helpers ─────────────────────────────────────
//
// Centralizes the common parsing patterns used across command handlers.
// Commands can import individual helpers as needed.

import type { CommandInput } from "../types";
import { DURATION_UNITS_HINT, parseDuration } from "./commands/format-duration";

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

// ─── One modifier grammar ─────────────────────────────────────────────────────
//
// Every command that takes named options accepts the SAME four spellings for
// a declared key: `key:value` (canonical — what usage strings show),
// `key=value`, `--key value`, `--key=value`. Undeclared keys are never
// consumed, so positional text such as `project:marina` or a URL survives
// unless the command declared that key. A literal `--` token ends modifier
// parsing; everything after it is positional.

export type ModifierType = "string" | "int" | "number" | "duration" | "bool";

export interface ModifierSpec {
  [key: string]: { type: ModifierType; aliases?: string[] };
}

export type ModifierValue = string | number | boolean;

export interface ParsedModifiers {
  /** Typed values keyed by canonical key — `int`/`number` → number, `duration` → ms, `bool` → boolean. */
  values: Record<string, ModifierValue | undefined>;
  /** The value exactly as typed, for echoing back ("last 30m"). */
  raw: Record<string, string | undefined>;
  /** Positional tokens with modifiers removed (tokens after `--` kept verbatim). */
  rest: string[];
  /** Tokens after a literal `--`, when one was present. */
  after?: string[];
  /** Human-readable problems: a bad int, an unparseable duration, a missing value. */
  errors: string[];
}

export interface ParseModifiersOptions {
  /**
   * Stop at the first positional token: only LEADING modifiers are parsed and
   * the remainder is free text (`tell <who> ttl:30s <message>` must not eat a
   * `ttl:` inside the message).
   */
  leading?: boolean;
}

const BOOL_TRUE = new Set(["true", "yes", "on", "1"]);
const BOOL_FALSE = new Set(["false", "no", "off", "0"]);

/**
 * Parse named modifiers out of a token list. See the module comment above for
 * the accepted spellings. Keys and aliases match case-insensitively.
 *
 *   parseModifiers(["--kind", "x", "since:2h", "foo"], { kind: {type:"string"}, since: {type:"duration"} })
 *     → { values: { kind: "x", since: 7_200_000 }, raw: { kind: "x", since: "2h" }, rest: ["foo"], errors: [] }
 */
export function parseModifiers(
  tokens: readonly string[],
  spec: ModifierSpec,
  opts: ParseModifiersOptions = {},
): ParsedModifiers {
  const keyByName = new Map<string, string>();
  for (const [key, def] of Object.entries(spec)) {
    keyByName.set(key.toLowerCase(), key);
    for (const alias of def.aliases ?? []) keyByName.set(alias.toLowerCase(), key);
  }

  const values: Record<string, ModifierValue | undefined> = {};
  const raw: Record<string, string | undefined> = {};
  const rest: string[] = [];
  const errors: string[] = [];
  let after: string[] | undefined;

  const assign = (key: string, value: string | undefined, flagOnly: boolean): void => {
    const def = spec[key]!;
    if (def.type === "bool") {
      if (value === undefined || flagOnly) {
        values[key] = true;
        raw[key] = value ?? "true";
        return;
      }
      const lower = value.toLowerCase();
      if (BOOL_TRUE.has(lower)) values[key] = true;
      else if (BOOL_FALSE.has(lower)) values[key] = false;
      else {
        errors.push(`${key}: expected true|false, got "${value}"`);
        return;
      }
      raw[key] = value;
      return;
    }
    if (value === undefined || value === "") {
      errors.push(`${key}: missing value`);
      return;
    }
    raw[key] = value;
    switch (def.type) {
      case "int": {
        if (!/^[+-]?\d+$/.test(value)) {
          errors.push(`${key}: expected a whole number, got "${value}"`);
          return;
        }
        values[key] = Number.parseInt(value, 10);
        return;
      }
      case "number": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          errors.push(`${key}: expected a number, got "${value}"`);
          return;
        }
        values[key] = n;
        return;
      }
      case "duration": {
        const ms = parseDuration(value);
        if (ms === undefined) {
          errors.push(`${key}: expected a duration (${DURATION_UNITS_HINT}), got "${value}"`);
          return;
        }
        values[key] = ms;
        return;
      }
      default:
        values[key] = value;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--") {
      after = tokens.slice(i + 1);
      rest.push(...after);
      break;
    }
    // --key=value | --key value | --flag
    if (tok.startsWith("--") && tok.length > 2) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const name = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase();
      const key = keyByName.get(name);
      if (key) {
        if (eq >= 0) {
          assign(key, body.slice(eq + 1), false);
        } else if (spec[key]!.type === "bool") {
          const next = tokens[i + 1]?.toLowerCase();
          if (next && (BOOL_TRUE.has(next) || BOOL_FALSE.has(next))) {
            assign(key, tokens[i + 1], false);
            i++;
          } else {
            assign(key, undefined, true);
          }
        } else {
          const next = tokens[i + 1];
          if (next !== undefined && next !== "--" && !next.startsWith("--")) {
            assign(key, next, false);
            i++;
          } else {
            assign(key, undefined, false);
          }
        }
        continue;
      }
    } else {
      // key:value | key=value — the separator is the FIRST ':' or '=' so URL
      // values (`source:https://…`) keep their own colons.
      const sep = tok.search(/[:=]/);
      if (sep > 0) {
        const key = keyByName.get(tok.slice(0, sep).toLowerCase());
        if (key) {
          assign(key, tok.slice(sep + 1), false);
          continue;
        }
      }
    }
    if (opts.leading) {
      rest.push(...tokens.slice(i));
      break;
    }
    rest.push(tok);
  }

  return { values, raw, rest, after, errors };
}

/**
 * Split a raw args string on the first STANDALONE `--` token (not `--kind`).
 * Returns [head, tail] with tail undefined when no terminator is present.
 * Preserves the tail's internal whitespace.
 */
export function splitOnTerminator(args: string): [string, string | undefined] {
  const m = /(?:^|\s)--(?:\s|$)/.exec(args);
  if (!m) return [args.trim(), undefined];
  return [args.slice(0, m.index).trim(), args.slice(m.index + m[0].length).trim()];
}

// ─── Canonical subcommand verbs ───────────────────────────────────────────────
//
// `list`, `show`, `delete` are the canonical verbs. The alternates below are
// accepted everywhere the canonical verb exists. `canonicalSub` only rewrites
// the token — handlers keep their own case labels — so a command that
// genuinely distinguishes `info` from `show` is left alone (both are allowed
// spellings there and match themselves first).

export const SUB_ALIASES: Readonly<Record<string, string>> = {
  ls: "list",
  view: "show",
  info: "show",
  remove: "delete",
  rm: "delete",
};

/** Verb families: the first member a command supports wins for any other member. */
const SUB_FAMILIES: readonly (readonly string[])[] = [
  ["list", "ls"],
  ["show", "info", "view"],
  ["delete", "remove", "rm"],
];

/**
 * Normalize a subcommand token against the verbs a command actually handles.
 * Returns the lower-cased token itself when it is already allowed, the
 * command's member of the same verb family when it is an alternate spelling
 * (`view` → `show`, or → `info` for a command that only has `info`), and the
 * lower-cased original when nothing matches (so the `default:` branch reports
 * exactly what the caller typed).
 */
export function canonicalSub(
  sub: string | undefined,
  allowed: Iterable<string>,
  opts: {
    /** Raw tokens that must NOT be family-aliased — for commands whose bare form
     *  takes free text (e.g. `note remove the old config …` is a note, not a delete). */
    noAlias?: readonly string[];
  } = {},
): string | undefined {
  if (sub === undefined) return undefined;
  const lower = sub.toLowerCase();
  const set = allowed instanceof Set ? (allowed as Set<string>) : new Set(allowed);
  if (set.has(lower)) return lower;
  if (opts.noAlias?.includes(lower)) return lower;
  for (const family of SUB_FAMILIES) {
    if (!family.includes(lower)) continue;
    for (const member of family) if (set.has(member)) return member;
  }
  return lower;
}

/** Consistent "unknown subcommand" reply: `Unknown <name> subcommand "<sub>". <usage>`. */
export function unknownSubcommand(name: string, sub: string | undefined, usage: string): string {
  return `Unknown ${name} subcommand "${sub ?? ""}". ${usage}`;
}
