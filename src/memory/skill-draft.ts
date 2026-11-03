// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill drafts: a skill nobody has checked yet. `skill store` and `skill
 * import` are an agent's deliberate record of what worked and are served as
 * written; a skill a pass DERIVED — `skill compose`, or a dream's
 * `propose-skill` over a procedure repeated across successful tasks — is a
 * draft until it is validated: a person's `skill verify <id>`, or a `skill
 * trial <id>` (the candidate arm with the skill against the incumbent without
 * it, in a child world). A draft is a `skill` note like any other, marked in
 * its content, and the skills tier, `skill top` and the `[Skill]` prompt line
 * never serve it. Promotion revises the note (`[Skill draft:` → `[Skill:`) and
 * records the verification.
 */

export const SKILL_DRAFT_PREFIX = "[Skill draft:";
export const SKILL_PREFIX = "[Skill:";

export const SKILL_NAME_MAX = 40;
export const SKILL_DESCRIPTION_MAX = 200;

export function isSkillDraft(content: string): boolean {
  return content.trimStart().startsWith(SKILL_DRAFT_PREFIX);
}

/** A skill name as the library spells it: lower-case words joined by `-`. */
export function skillSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX);
}

/** The library's content shape for a skill, as a draft or as servable. */
export function skillContent(
  name: string,
  description: string,
  steps: readonly string[],
  opts: { draft: boolean },
): string {
  const head = opts.draft ? SKILL_DRAFT_PREFIX : SKILL_PREFIX;
  return `${head} ${name}] ${description.trim()} || Actions: ${steps.join(" ; ")}`;
}

/** The same skill, no longer a draft; undefined when `content` is not a draft. */
export function promotedSkillContent(content: string): string | undefined {
  if (!isSkillDraft(content)) return undefined;
  return `${SKILL_PREFIX}${content.trimStart().slice(SKILL_DRAFT_PREFIX.length)}`;
}

/** The skill's name from its content (`[Skill: <name>]` or `[Skill draft: <name>]`). */
export function skillNameOf(content: string): string | undefined {
  return /^\[Skill(?: draft)?:\s*([^\]]+)\]/.exec(content.trimStart())?.[1]?.trim();
}

/** The `Actions:` part of a skill's content, split on `;`. */
export function skillSteps(content: string): string[] {
  const m = /Actions:\s*(.+)$/s.exec(content);
  if (!m?.[1]) return [];
  return m[1]
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether a skill or macro text already covers a procedure: every step
 * appears in it, in order (a looser phrasing around the same commands is
 * still that procedure). Case-insensitive.
 */
export function coversProcedure(text: string, steps: readonly string[]): boolean {
  if (!steps.length) return false;
  const hay = text.toLowerCase();
  let from = 0;
  for (const step of steps) {
    const at = hay.indexOf(step.toLowerCase(), from);
    if (at < 0) return false;
    from = at + step.length;
  }
  return true;
}
