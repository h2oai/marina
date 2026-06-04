import type { MarinaDB } from "../persistence/database";
import type { GuideNote } from "./world-definition";

const POOL_NAME = "guide";
const AUTHOR = "Guide";

/**
 * Seed the `guide` memory pool with knowledge about Marina systems.
 * Idempotent — skips if the pool already has notes.
 */
export function seedGuidePool(db: MarinaDB, notes: GuideNote[]): void {
  if (notes.length === 0) return;

  let pool = db.getMemoryPool(POOL_NAME);
  if (!pool) {
    const id = `pool_${POOL_NAME}_${Date.now()}`;
    db.createMemoryPool(id, POOL_NAME, AUTHOR);
    pool = db.getMemoryPool(POOL_NAME);
  }
  if (!pool) return;

  // Skip when the pool already has any notes. The previous check used an
  // FTS5 search for "bootstrap getting started" which returned zero hits
  // unless that exact phrase appeared in the seed text — so every reboot
  // re-seeded and duplicates piled up. Existence is what we actually want.
  if (db.getPoolNotes(pool.id, 1).length > 0) return;

  for (const note of notes) {
    db.addPoolNote(pool.id, AUTHOR, note.content, note.importance, note.type);
  }
}
