// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { FACT_LIKE_TIERS } from "../engine/constants";
import type { MarinaDB, NoteRow, ScoredNoteRow } from "../persistence/database";

/** The same eligibility contract applies to seeds and graph-discovered records. */
export function expandMemoryRecall(
  db: MarinaDB,
  initial: ScoredNoteRow[],
  owner: string,
  options: { noteType?: string; trusted?: boolean } = {},
): ScoredNoteRow[] {
  function eligible(note: NoteRow | undefined): note is NoteRow {
    if (
      !note ||
      note.entity_name !== owner ||
      note.pool_id ||
      note.verification_status === "superseded" ||
      !FACT_LIKE_TIERS.includes(note.tier) ||
      (options.noteType && note.note_type !== options.noteType)
    )
      return false;
    return (
      !options.trusted ||
      note.verification_status === "verified" ||
      ((note.confidence ?? 0.5) >= 0.7 &&
        db.getNoteSources(note.id).some((source) => source.credibility >= 0.6))
    );
  }
  const results = initial.filter(eligible);
  if (results.length >= 20) return results.slice(0, 20);
  const byId = new Map(results.map((note) => [note.id, note]));
  const seeds = results.slice(0, 5).map((seed) => ({
    seed,
    linkedIds: db
      .getNoteLinks(seed.id)
      .map((link) => (link.source_id === seed.id ? link.target_id : link.source_id)),
  }));
  // One batched read for every linked note instead of a getNote per link.
  const linkedNotes = new Map(
    db.getNotes(seeds.flatMap((s) => s.linkedIds)).map((note) => [note.id, note] as const),
  );
  for (const { seed, linkedIds } of seeds) {
    for (const linkedId of linkedIds) {
      const linked = linkedNotes.get(linkedId);
      if (!eligible(linked)) continue;
      const score = seed.score * 0.3;
      const previous = byId.get(linkedId);
      if (!previous || previous.score < score) byId.set(linkedId, { ...linked, score });
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, 20);
}
