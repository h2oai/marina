// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { MarinaDB } from "../src/persistence/database";

test("weighted recall preserves low-lexical, high-importance hits beyond the first 200 matches and isolates owners and types", () => {
  const db = new MarinaDB(":memory:");
  try {
    let important = 0,
      skill = 0;
    db.transaction(() => {
      for (let i = 0; i < 220; i++)
        db.createNote("Ada", `quartz quartz quartz quartz ${i}`, undefined, {
          importance: 1,
          skipDedup: true,
        });
      const prose = `quartz ${"context ".repeat(80)}`;
      important = db.createNote("Ada", prose, undefined, {
        importance: 10,
        noteType: "observation",
      });
      skill = db.createNote("Ada", `Procedure: ${prose}`, undefined, {
        importance: 9,
        noteType: "skill",
      });
      db.createNote("Bea", "quartz secret belonging to Bea", undefined, { importance: 10 });
    });
    const weights = { weightImportance: 1, weightRecency: 0, weightRelevance: 0 };
    const recalled = db.recallNotes("Ada", "quartz", weights);
    expect(recalled.length).toBe(20);
    expect(recalled[0]!.id).toBe(important);
    expect(recalled[1]!.id).toBe(skill);
    expect(recalled.every((n) => n.entity_name === "Ada")).toBe(true);
    expect(db.recallNotesWithType("Ada", "quartz", "skill", weights).map((n) => n.id)).toEqual([
      skill,
    ]);
    expect(db.recallNotesWithType("Ada", "quartz", "observation", weights)[0]!.id).toBe(important);
    expect(db.recallNotes("Ada", "absentterm", weights)).toEqual([]);
    db.deleteNote(important, "Ada");
    expect(db.recallNotes("Ada", "quartz", weights).some((n) => n.id === important)).toBe(false);
  } finally {
    db.close();
  }
});
