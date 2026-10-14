// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { FACT_LIKE_TIERS } from "../engine/constants";
import type { MarinaDB, NoteRow, ScoredNoteRow } from "../persistence/database";
import type { NoteSourceRow } from "../persistence/db-notes";

/**
 * A source that is not the note author's own say-so: captured by someone
 * else, or citing a note someone else wrote. The author's own `note source`
 * (whatever credibility it claims) is self-attestation.
 */
export function isIndependentSource(
  source: Pick<NoteSourceRow, "captured_by" | "source_entity">,
  author: string,
): boolean {
  const other = (who: string | null) => !!who && who.toLowerCase() !== author.toLowerCase();
  return other(source.captured_by) || other(source.source_entity);
}

/**
 * `[trusted]` is strict and never self-attested: the note was verified by
 * someone else (`note verify` refuses the author; `pool ratify` is another
 * resident), OR it carries confidence ≥ 0.7 AND a credible (≥ 0.6) source the
 * author did not supply themselves. Confidence and a source's credibility are
 * both author-set, so neither alone — nor together — earns the tier.
 */
export function isTrustedNote(db: MarinaDB, note: NoteRow): boolean {
  if (note.verification_status === "verified") return true;
  if ((note.confidence ?? 0.5) < 0.7) return false;
  return db
    .getNoteSources(note.id)
    .some((source) => source.credibility >= 0.6 && isIndependentSource(source, note.entity_name));
}

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
    return !options.trusted || isTrustedNote(db, note);
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
