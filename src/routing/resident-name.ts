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
