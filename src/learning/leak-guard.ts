// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The mechanical item-content check a lesson must pass before any judge reads
 * it. A lesson leaks when it carries a benchmark ITEM — its id, its question
 * text or its answer — so that a later run could memorise answers. Aggregate
 * scores, sample sizes, costs, model names and configuration descriptions are
 * not item content and are never flagged.
 *
 * The guard holds fingerprints, never text:
 *   - `itemIds`: the run's ledger item ids (ids are not content);
 *   - `shingles`: sha256 prefixes of normalised word n-grams of the item text
 *     the producer had in hand (the in-world runner's questions and answers);
 *   - `answers`: sha256 prefixes of normalised answers;
 *   - `ledgerAnswer`: a closure testing an answer digest against the ledger's
 *     KEYED answer hashes (`answer_hash`, migration 157) of the run's items.
 *     The key stays inside the closure, so a serialised outcome never carries it.
 * Besides the known items, any id-shaped token (a long hex run, `prefix-<hex>`)
 * is refused: a lesson has no reason to name one.
 */

import { createHash } from "node:crypto";
import { answerDigest } from "../engine/benchmark-ledger";
import type { MarinaDB } from "../persistence/database";
import { ANSWER_HASH_KEY_SETTING, keyedAnswerHash } from "../persistence/db-benchmarks";

export interface CaseGuard {
  itemIds?: string[];
  shingles?: string[];
  answers?: string[];
  /** True when an answer digest matches a keyed ledger answer hash of the run's items. */
  ledgerAnswer?: (digest: string) => boolean;
}

/** Word n-gram lengths fingerprinted; a lesson quoting this much of an item is a leak. */
export const SHINGLE_MIN = 4;
export const SHINGLE_MAX = 6;
/** Bounds on what one guard fingerprints (an outcome stays small). */
const MAX_ITEMS = 2_000;
const MAX_WORDS_PER_TEXT = 400;
const MAX_ANSWER_WORDS = 6;

const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Lower case, letters and digits only, single spaces: what a quotation survives. */
export function normaliseWords(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Fingerprints of the item text a producer holds (questions, expected and
 * model answers). Long texts contribute every `SHINGLE_MAX`-word shingle; a
 * text of `SHINGLE_MIN`..`SHINGLE_MAX - 1` words contributes itself whole.
 */
export function caseGuardFromItems(
  items: ReadonlyArray<{ id?: string; question?: string; expected?: string; actual?: string }>,
): CaseGuard {
  const shingles = new Set<string>();
  const answers = new Set<string>();
  const itemIds: string[] = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (item.id) itemIds.push(item.id);
    for (const text of [item.question, item.expected, item.actual]) {
      if (typeof text !== "string" || !text.trim()) continue;
      const words = normaliseWords(text).slice(0, MAX_WORDS_PER_TEXT);
      if (words.length >= SHINGLE_MAX) {
        for (let i = 0; i + SHINGLE_MAX <= words.length; i++)
          shingles.add(fp(words.slice(i, i + SHINGLE_MAX).join(" ")));
      } else if (words.length >= SHINGLE_MIN) {
        shingles.add(fp(words.join(" ")));
      }
    }
    for (const a of [item.expected, item.actual]) {
      const d = answerDigest(a);
      if (d) answers.add(d.slice(0, 16));
    }
  }
  return {
    ...(itemIds.length ? { itemIds } : {}),
    ...(shingles.size ? { shingles: [...shingles] } : {}),
    ...(answers.size ? { answers: [...answers] } : {}),
  };
}

/**
 * The guard the ledger alone can give for `runIds`: their item ids and a test
 * against their keyed answer hashes. Reads only; never creates the hash key.
 */
export function ledgerCaseGuard(db: MarinaDB, runIds: readonly string[]): CaseGuard {
  const itemIds = new Set<string>();
  const hashed: Array<{ itemId: string; hash: string }> = [];
  for (const runId of runIds) {
    for (const it of db.getBenchmarkItems(runId)) {
      if (itemIds.size < MAX_ITEMS) itemIds.add(it.item_id);
      if (it.answer_hash && hashed.length < MAX_ITEMS)
        hashed.push({ itemId: it.item_id, hash: it.answer_hash });
    }
  }
  const key = hashed.length ? db.getSetting(ANSWER_HASH_KEY_SETTING) : undefined;
  const hashes = new Set(hashed.map((h) => h.hash));
  const ids = [...new Set(hashed.map((h) => h.itemId))];
  return {
    ...(itemIds.size ? { itemIds: [...itemIds] } : {}),
    ...(key && hashes.size
      ? {
          ledgerAnswer: (digest: string) =>
            ids.some((id) => hashes.has(keyedAnswerHash(key, id, digest))),
        }
      : {}),
  };
}

/** One guard from several (any may be undefined). */
export function mergeGuards(...guards: Array<CaseGuard | undefined>): CaseGuard | undefined {
  const present = guards.filter((g): g is CaseGuard => !!g);
  if (!present.length) return undefined;
  const join = (k: "itemIds" | "shingles" | "answers") => {
    const all = [...new Set(present.flatMap((g) => g[k] ?? []))];
    return all.length ? { [k]: all } : {};
  };
  const tests = present.flatMap((g) => (g.ledgerAnswer ? [g.ledgerAnswer] : []));
  return {
    ...join("itemIds"),
    ...join("shingles"),
    ...join("answers"),
    ...(tests.length ? { ledgerAnswer: (d: string) => tests.some((t) => t(d)) } : {}),
  };
}

/** Evidence a lesson may cite, removed before the answer check: `56.9%`, `n=80`, `$0.01/item`, `0.57`, `9/12`. */
const EVIDENCE =
  /\$\s?\d[\d,]*(?:\.\d+)?(?:\/item)?|\b\d+(?:\.\d+)?\s?%|\bn\s?=\s?\d+|\b\d+\/\d+\b|\b\d+\.\d+\b/gi;

/** Long hex runs and `prefix-<hex>` ids: shaped like an item id, never needed in a rule. */
const ID_SHAPED = /\b[0-9a-f]{12,}\b|\b[a-z][a-z0-9]*[-_][0-9a-f]{8,}\b/i;

/** A candidate answer must be this specific to count: common short words are not leaks. */
function answerCandidate(phrase: string, vocabulary: ReadonlySet<string>): boolean {
  const words = phrase.split(" ");
  if (words.every((w) => vocabulary.has(w))) return false;
  if (/^\d+$/.test(phrase)) return phrase.length >= 4;
  if (!/\p{L}/u.test(phrase)) return false;
  return words.length === 1 ? phrase.length >= 6 : phrase.length >= 8;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Why `text` carries item content, or undefined when it does not.
 * `vocabulary` is the text the producer showed the writer (configuration,
 * kind of work): words drawn only from it are never an answer match.
 */
export function itemLeak(
  text: string,
  guard: CaseGuard | undefined,
  vocabulary = "",
): string | undefined {
  const idShaped = text.match(ID_SHAPED);
  if (idShaped) return "names an item-id-shaped token";
  if (!guard) return undefined;
  const lower = text.toLowerCase();
  for (const id of guard.itemIds ?? []) {
    if (id.length < 4 || !lower.includes(id.toLowerCase())) continue;
    if (new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(id)}($|[^A-Za-z0-9_-])`, "i").test(text))
      return "names a benchmark item id";
  }
  const words = normaliseWords(text);
  if (guard.shingles?.length) {
    const set = new Set(guard.shingles);
    for (let n = SHINGLE_MIN; n <= SHINGLE_MAX; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        if (set.has(fp(words.slice(i, i + n).join(" ")))) return "quotes benchmark item text";
      }
    }
  }
  if (guard.answers?.length || guard.ledgerAnswer) {
    const known = new Set(guard.answers ?? []);
    const vocab = new Set([
      ...normaliseWords(vocabulary),
      // Words every lesson about a run may use.
      ...normaliseWords(
        "lesson benchmark success failure rule evidence score scored configuration model models formation run runs items item judge baseline",
      ),
    ]);
    const plain = normaliseWords(text.replace(EVIDENCE, " "));
    const seen = new Set<string>();
    for (let n = 1; n <= MAX_ANSWER_WORDS; n++) {
      for (let i = 0; i + n <= plain.length; i++) {
        const phrase = plain.slice(i, i + n).join(" ");
        if (seen.has(phrase) || !answerCandidate(phrase, vocab)) continue;
        seen.add(phrase);
        const d = answerDigest(phrase);
        if (!d) continue;
        if (known.has(d.slice(0, 16)) || guard.ledgerAnswer?.(d))
          return "states a benchmark item's answer";
      }
    }
  }
  return undefined;
}
