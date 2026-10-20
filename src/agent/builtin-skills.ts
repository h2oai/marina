/// <reference path="../text-assets.d.ts" />
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in skills: procedural knowledge shipped with the server and readable
 * by every agent with no import and no seeding (`skill builtin [name]`, and
 * matched by `skill search`). They are read-only text — never notes — so
 * they cost nothing until asked for and never enter memory recall. Seeding
 * skills as notes stays opt-in (`MARINA_SEED_SKILLS`); the same files can
 * still be imported as notes with `skill import seeds/skills/<name>.md`.
 */

import intakeTriage from "../../seeds/skills/intake-triage.md" with { type: "text" };
import quantitativeEstimates from "../../seeds/skills/quantitative-estimates.md" with {
  type: "text",
};
import { parseSkillMarkdown, type SkillImport } from "./skill-import";

export const BUILTIN_SKILLS: readonly SkillImport[] = [
  parseSkillMarkdown(quantitativeEstimates),
  parseSkillMarkdown(intakeTriage),
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
