/// <reference path="../text-assets.d.ts" />
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in skills: procedural knowledge shipped with the server and readable
 * by every agent with no import and no seeding (`skill builtin [name]`, and
 * matched by `skill search`; the best match for a resident's focus is offered
 * in its continuation prompt — `rankBuiltinSkills`). They are read-only text — never notes — so
 * they cost nothing until asked for and never enter memory recall. Seeding
 * skills as notes stays opt-in (`MARINA_SEED_SKILLS`); the same files can
 * still be imported as notes with `skill import seeds/skills/<name>.md`.
 */

import answerRequest from "../../seeds/skills/answer-request.md" with { type: "text" };
import canvasIntents from "../../seeds/skills/canvas-intents.md" with { type: "text" };
import chronicling from "../../seeds/skills/chronicling.md" with { type: "text" };
import consolidateMemory from "../../seeds/skills/consolidate-memory.md" with { type: "text" };
import decomposeMultihop from "../../seeds/skills/decompose-multihop.md" with { type: "text" };
import intakeTriage from "../../seeds/skills/intake-triage.md" with { type: "text" };
import quantitativeEstimates from "../../seeds/skills/quantitative-estimates.md" with {
  type: "text",
};
import solveMath from "../../seeds/skills/solve-math.md" with { type: "text" };
import { parseSkillMarkdown, type SkillImport } from "./skill-import";

export const BUILTIN_SKILLS: readonly SkillImport[] = [
  parseSkillMarkdown(quantitativeEstimates),
  parseSkillMarkdown(intakeTriage),
  parseSkillMarkdown(decomposeMultihop),
  parseSkillMarkdown(solveMath),
  parseSkillMarkdown(answerRequest),
  // Progressive disclosure (2026-10-20): the long procedures of seeded traits.
  // The trait keeps one line per rule and points here.
  parseSkillMarkdown(chronicling),
  parseSkillMarkdown(canvasIntents),
  parseSkillMarkdown(consolidateMemory),
];

export function builtinSkill(name: string): SkillImport | undefined {
  const n = name.trim().toLowerCase();
  return BUILTIN_SKILLS.find((s) => s.name === n);
}

/** Built-in skills whose name, description or tags contain a word of `query` (3+ letters). */
export function searchBuiltinSkills(query: string): SkillImport[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9%-]+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return [];
  return BUILTIN_SKILLS.filter((s) => {
    const hay = `${s.name} ${s.description} ${s.tags.join(" ")}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });
}

/** Words too common to count as evidence that a skill fits. */
const STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "any",
  "are",
  "but",
  "can",
  "for",
  "from",
  "have",
  "how",
  "into",
  "its",
  "not",
  "one",
  "the",
  "that",
  "their",
  "then",
  "this",
  "what",
  "when",
  "with",
  "your",
]);

/**
 * Built-in skills ranked by how well they fit `query`, for injection: a query
 * word naming the skill or one of its tags counts 2, a word in its
 * description 1; only skills scoring at least `min` (default 2 — one strong
 * hit or two weak ones) are returned, best first, ties in shipping order.
 */
export function rankBuiltinSkills(
  query: string,
  min = 2,
): Array<{ skill: SkillImport; score: number }> {
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9%-]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ];
  if (words.length === 0) return [];
  return BUILTIN_SKILLS.map((skill) => {
    const strong = new Set(
      `${skill.name} ${skill.name.replace(/-/g, " ")} ${skill.tags.join(" ")}`
        .toLowerCase()
        .split(/[^a-z0-9%-]+/)
        .filter(Boolean),
    );
    const description = skill.description.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (strong.has(w)) score += 2;
      else if (description.includes(w)) score += 1;
    }
    return { skill, score };
  })
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score);
}
