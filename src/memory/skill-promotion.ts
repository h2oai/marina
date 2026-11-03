// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Promoting a skill: `skill verify <id>` by a person, or a won `skill trial
 * <id>`, records a `verified` verification on the note; a DRAFT is first
 * revised to its servable form (`[Skill draft:` → `[Skill:`; a new version,
 * the draft superseded, never deleted). Verified skills are what the skills
 * tier serves and what a dream never touches (the taint rule).
 */

import type { MarinaDB } from "../persistence/database";
import { isSkillDraft, promotedSkillContent } from "./skill-draft";

export interface SkillPromotion {
  /** The servable skill's id: the note itself, or the revision a draft became. */
  id: number;
  wasDraft: boolean;
}

export function promoteSkill(
  db: MarinaDB,
  entityName: string,
  skillId: number,
  verifier: string,
  rationale: string,
): SkillPromotion | undefined {
  const note = db.getNote(skillId);
  if (
    !note ||
    note.entity_name !== entityName ||
    note.note_type !== "skill" ||
    note.verification_status === "superseded"
  )
    return undefined;
  return db.transaction(() => {
    let id = skillId;
    const wasDraft = isSkillDraft(note.content);
    if (wasDraft) {
      const revised = db.reviseNote(entityName, skillId, promotedSkillContent(note.content)!, {
        importance: note.importance,
        noteType: "skill",
      });
      if (!revised) return undefined;
      id = revised;
    }
    db.recordNoteVerification(id, verifier, "verified", 1, rationale);
    return { id, wasDraft };
  });
}
