// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomInt } from "node:crypto";
import { sanitizeEntityName } from "../engine/entity-name";

/**
 * Pronounceable names for supervised residents that did not ask for one. Short,
 * distinct, and none of them names a model vendor or an adapter.
 */
export const RESIDENT_NAME_WORDS: readonly string[] = [
  "Wren",
  "Ash",
  "Briar",
  "Cedar",
  "Dove",
  "Ember",
  "Fern",
  "Finch",
  "Hazel",
  "Heron",
  "Iris",
  "Juniper",
  "Kestrel",
  "Lark",
  "Linden",
  "Maple",
  "Merlin",
  "Moss",
  "Nettle",
  "Oriole",
  "Osprey",
  "Pike",
  "Plover",
  "Quill",
  "Reed",
  "Robin",
  "Rowan",
  "Sage",
  "Sorrel",
  "Sparrow",
  "Swift",
  "Tansy",
  "Teal",
  "Thistle",
  "Vale",
  "Willow",
  "Yarrow",
  "Zephyr",
];

/** Why a requested resident name cannot be used as given. */
export function residentNameProblem(name: string): string | undefined {
  if (name.length < 2 || name.length > 20)
    return "Resident names must be 2-20 characters using only letters, numbers, and underscores";
  if (sanitizeEntityName(name) !== name)
    return "Resident names must be 2-20 characters using only letters, numbers, and underscores";
  // `system` ends every spawn lineage; no account may take that name.
  if (name.toLowerCase() === "system") return "That name is reserved";
  return undefined;
}

/** True when `name` mentions the adapter that runs it (`claude`, `codex`, `pi`, …). */
export function nameMentionsVendor(name: string, vendor: string): boolean {
  const v = vendor.trim().toLowerCase();
  return v.length > 0 && name.toLowerCase().includes(v);
}

/**
 * A fresh word-list name that `isTaken` does not reject and that never
 * contains the vendor. Tries the words in a random order, then the words with
 * a two-digit suffix; every candidate is a fixed point of `sanitizeEntityName`.
 * Returns undefined only when every candidate is taken.
 */
export function generateResidentName(
  vendor: string,
  isTaken: (name: string) => boolean,
  pick: (max: number) => number = randomInt,
): string | undefined {
  const words = RESIDENT_NAME_WORDS.filter((word) => !nameMentionsVendor(word, vendor));
  const start = words.length ? pick(words.length) : 0;
  const ordered = words.map((_, i) => words[(start + i) % words.length]!);
  for (const word of ordered) if (!isTaken(word)) return word;
  for (let attempt = 0; attempt < 200; attempt++) {
    const word = ordered[attempt % ordered.length]!;
    const candidate = `${word}${10 + pick(90)}`;
    if (!nameMentionsVendor(candidate, vendor) && !isTaken(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Model, vendor and product words a resident's own proposal may not contain:
 * a resident is named as a member of the world, not after what runs it.
 */
const MODEL_WORDS = [
  "claude",
  "codex",
  "anthropic",
  "openai",
  "chatgpt",
  "gpt",
  "gemini",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "llama",
  "mistral",
  "grok",
  "deepseek",
  "qwen",
  "marina",
];

/** The first name-shaped word of an agent's reply ("**Wren**." → "Wren"), if any. */
export function nameFromReply(reply: string): string | undefined {
  const line = reply.trim().split("\n")[0] ?? "";
  const word = /[A-Za-z][A-Za-z0-9_]*/.exec(line.replace(/[*_`"'“”‘’]/g, " "))?.[0];
  return word && word.length >= 2 && word.length <= 20 ? word : undefined;
}

/**
 * A free name from an agent's own proposal: a sanitized fixed point, never the vendor or a
 * model word, deduped with a numeric suffix when taken. Undefined when the
 * proposal is unusable or every variant is taken (the caller falls back).
 */
export function residentNameFromProposal(
  proposal: string,
  vendor: string,
  isTaken: (name: string) => boolean,
): string | undefined {
  // Only a sanitized fixed point: a proposal sanitizing would rewrite is not the agent's choice.
  const base = proposal.trim();
  if (base.length > 18 || residentNameProblem(base)) return undefined;
  const lower = base.toLowerCase();
  if (nameMentionsVendor(base, vendor) || MODEL_WORDS.some((word) => lower.includes(word)))
    return undefined;
  if (!isTaken(base)) return base;
  for (let suffix = 2; suffix <= 99; suffix++) {
    const candidate = `${base}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  return undefined;
}
