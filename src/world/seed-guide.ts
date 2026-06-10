import type { MarinaDB } from "../persistence/database";
import type { GuideNote } from "./world-definition";

const POOL_NAME = "guide";
const AUTHOR = "Guide";

/**
 * Platform-wide guide notes seeded into EVERY world's guide pool, regardless of
 * what the world declares. These teach the self-improvement ("evolver") loop —
 * benchmarks + skills + reflection — which previously had no in-world home
 * outside the evolve world. Agents reach them via `pool guide recall <topic>`,
 * `ask <topic>`, or the `evolve` command. Keep them terse and recall-friendly
 * (lead with the keywords an agent would search: evolve, improve, skill,
 * benchmark, recall).
 */
export const PLATFORM_GUIDE_NOTES: GuideNote[] = [
  {
    type: "skill",
    importance: 9,
    content:
      "evolve / self-improvement loop: get better, not just busy. Run `evolve` to see " +
      "where you stand and your single next step; `evolve loop` explains the full cycle. " +
      "The loop: (1) Baseline — measure where you are. (2) Change one approach — a sharper " +
      "note, a mind-room, a better recall strategy. (3) Re-measure and compare. (4) Bank what " +
      "worked as a reusable skill. (5) Reflect to consolidate. Keep only changes that help.",
  },
  {
    type: "skill",
    importance: 8,
    content:
      "skills — bank what works: when a sequence of actions reliably gets a result, store it " +
      "with `skill store <name> | <what it does> | <step ; step ; step>`. Find prior skills " +
      "with `skill search <query>`, review yours with `skill list`, combine them with " +
      "`skill compose <id1> <id2>`, and share to a pool with `skill share <id> <pool>`. " +
      "Skills outlive you — they're the starting point for whoever comes next.",
  },
  {
    type: "fact",
    importance: 7,
    content:
      "pool recall — searching shared knowledge: `pool <name> recall <topic>` does a keyword " +
      "search over a shared pool (e.g. `pool guide recall evolve`). `recall <topic>` searches " +
      "your own notes. If a search returns nothing, try different keywords — it matches words, " +
      "not exact phrases. Benchmark mistakes land in `benchmark:<name>` pools; review them with " +
      "`pool benchmark:<name> recall <topic>`.",
  },
  {
    type: "fact",
    importance: 7,
    content:
      "Two benchmark systems — don't confuse them. (1) Evolve-world quests are in-world " +
      "capability gyms (navigation, retrieval, memory, self-modification, …): `quest start " +
      "<name>`, finish with `quest complete`, review with `score`. Rank 0 — practice here. " +
      "(2) The `benchmark` command runs academic evals (mmlu-pro, aime, …) against a model: " +
      "`benchmark run <name>`. Rank 4 — it burns real tokens. `evolve loop` summarizes both.",
  },
];

/**
 * Seed the `guide` memory pool with knowledge about Marina systems.
 * Idempotent — skips if the pool already has notes.
 */
export function seedGuidePool(db: MarinaDB, notes: GuideNote[]): void {
  // Platform notes are always merged in front of the world's own notes, so the
  // self-improvement loop is discoverable in every world — even one that
  // declares no guide notes of its own.
  const all = [...PLATFORM_GUIDE_NOTES, ...notes];
  if (all.length === 0) return;

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

  for (const note of all) {
    db.addPoolNote(pool.id, AUTHOR, note.content, note.importance, note.type);
  }
}
