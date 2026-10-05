// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Task families and subjects for lessons — keys that let a lesson learned on
 * one board reach work of the same kind on another. The vocabulary and the
 * board → family map are DATA (`families.json`): no benchmark name appears in
 * code, and adding a board means adding tags (or `config.families` in its
 * harness result), never a branch here.
 */

import vocabulary from "./families.json";
import { MAX_FAMILIES, MAX_SUBJECTS } from "./outcomes";

const FAMILIES = new Set(Object.keys(vocabulary.families));
const BY_BENCHMARK = vocabulary.benchmarks as Record<string, string[]>;
const BY_SOURCE = vocabulary.sources as Record<string, string[]>;

/** Tags that are in the declared vocabulary, deduplicated, at most `MAX_FAMILIES`. */
export function knownFamilies(tags: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string" || !FAMILIES.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_FAMILIES) break;
  }
  return out;
}

const DESCRIPTIONS = vocabulary.families as Record<string, string>;

/** The plain-words description of a family tag (the vocabulary's own), else the tag. */
export function familyDescription(tag: string): string {
  return DESCRIPTIONS[tag] ?? tag;
}

/** Every family in the vocabulary (for docs and validation). */
export function familyVocabulary(): string[] {
  return [...FAMILIES];
}

/**
 * A ledger run's families: the harness result's own `config.families` when it
 * declared them, else the vocabulary's map for the benchmark name.
 */
export function familiesForRun(run: { benchmark: string; config_json?: string | null }): string[] {
  try {
    const config = run.config_json ? (JSON.parse(run.config_json) as { families?: unknown }) : {};
    if (Array.isArray(config.families)) {
      const declared = knownFamilies(config.families);
      if (declared.length) return declared;
    }
  } catch {
    // allow-empty-catch: an unreadable config falls back to the vocabulary map
  }
  return knownFamilies(BY_BENCHMARK[run.benchmark] ?? []);
}

/** Families for a benchmark name alone (an eval header, a harness flag). */
export function familiesForBenchmark(benchmark: string): string[] {
  return knownFamilies(BY_BENCHMARK[benchmark] ?? []);
}

/** An outcome source's families: the exact source, else its producer prefix. */
export function familiesForSource(source: string): string[] {
  const exact = BY_SOURCE[source];
  if (exact) return knownFamilies(exact);
  const prefix = source.split(":")[0] ?? "";
  if (prefix === "benchmark") return familiesForBenchmark(source.slice("benchmark:".length));
  return knownFamilies(BY_SOURCE[prefix] ?? []);
}

/**
 * The subjects of a ledger target (formation and short model names), the keys
 * a routing or formation choice can match a `config` lesson by.
 */
export function targetSubjects(run: { target_json?: string | null }): string[] {
  let target: unknown;
  try {
    target = run.target_json ? JSON.parse(run.target_json) : undefined;
  } catch {
    target = run.target_json;
  }
  const out: string[] = [];
  const add = (s: unknown) => {
    if (typeof s !== "string" || !s.trim()) return;
    const short = s.trim().split("/").pop() ?? s.trim();
    if (!out.includes(short) && out.length < MAX_SUBJECTS) out.push(short);
  };
  if (typeof target === "string") add(target);
  else if (target && typeof target === "object") {
    const t = target as Record<string, unknown>;
    if (typeof t.formation === "string") out.push(`formation:${t.formation}`);
    add(t.model);
    if (t.models && typeof t.models === "object")
      for (const m of Object.values(t.models as Record<string, unknown>)) add(m);
  }
  return out.slice(0, MAX_SUBJECTS);
}
