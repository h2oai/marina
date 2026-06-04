/**
 * The shape→outcome prior store — Phase 5's learning loop.
 *
 * When a Score finishes and its outcome is known, we record the Score's *shape*
 * (topology, step count, workers) alongside the outcome score into a shared
 * `conductor` pool. Successor conductors `recall` these to learn which team
 * shape works for which task class — the non-gradient analogue of the paper's
 * reward-driven topology selection. Good organizations crystallize into priors.
 *
 * See docs/conductor-design.md, Phase 5.
 */

import type { MarinaDB } from "../persistence/database";
import type { Score } from "./score";
import { characterizeScore, type ScoreShape, shapeSummary } from "./score-shape";

export const CONDUCTOR_POOL = "conductor";

export interface ScoreOutcomeInput {
  scoreName: string;
  /** Outcome quality in [0,1] — correctness, pass-rate, 1−Brier, etc. */
  score: number;
  /** Task class for recall filtering (defaults to "general"). */
  category?: string;
  /** Free-text detail, e.g. "passed 8/10 tests". */
  label?: string;
  recordedBy: string;
}

export interface ScoreOutcomeRecord {
  category: string;
  score: number;
  /** The full recall-friendly note line. */
  content: string;
  shape: ScoreShape;
}

function ensurePool(db: MarinaDB): { id: string } | undefined {
  let pool = db.getMemoryPool(CONDUCTOR_POOL);
  if (!pool) {
    db.createMemoryPool(`pool-${CONDUCTOR_POOL}`, CONDUCTOR_POOL, "conductor");
    pool = db.getMemoryPool(CONDUCTOR_POOL);
  }
  return pool ? { id: pool.id } : undefined;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Record a Score's outcome as a recallable prior. Returns the note id, or
 * undefined if the pool couldn't be provisioned. Decisive outcomes (very high
 * or very low) get a slight importance bump — both wins and losses teach.
 */
export function recordScoreOutcome(
  db: MarinaDB,
  score: Score,
  input: ScoreOutcomeInput,
): number | undefined {
  const shape = characterizeScore(score);
  const category = input.category?.trim() || "general";
  const s = clamp01(input.score);
  const label = input.label?.trim() ? ` — ${input.label.trim()}` : "";
  const content =
    `[score-outcome:${category}] ${shapeSummary(shape)} score=${s.toFixed(2)}${label} ` +
    `workers=[${shape.workers.join(",")}] score:${input.scoreName}`;
  const importance = s >= 0.8 || s <= 0.2 ? 7 : 6;
  const pool = ensurePool(db);
  if (!pool) return undefined;
  return db.addPoolNote(pool.id, input.recordedBy, content, importance);
}

const OUTCOME_RE = /^\[score-outcome:([^\]]+)\]/;
const SCORE_RE = /score=([0-9.]+)/;
const TOPOLOGY_RE = /\]\s+(\S+?)\//;

/**
 * Read recorded shape→outcome priors, newest first, optionally filtered by
 * category. Parsing is best-effort; malformed notes are skipped.
 */
export function loadScoreOutcomes(
  db: MarinaDB,
  opts: { category?: string; limit?: number } = {},
): { category: string; score: number; topology: string; content: string }[] {
  const pool = db.getMemoryPool(CONDUCTOR_POOL);
  if (!pool) return [];
  const out: { category: string; score: number; topology: string; content: string }[] = [];
  for (const note of db.getPoolNotes(pool.id, opts.limit ?? 200)) {
    const cat = note.content.match(OUTCOME_RE);
    if (!cat) continue;
    const category = cat[1]!;
    if (opts.category && category !== opts.category) continue;
    const score = Number(note.content.match(SCORE_RE)?.[1] ?? "0");
    const topology = note.content.match(TOPOLOGY_RE)?.[1] ?? "?";
    out.push({ category, score, topology, content: note.content });
  }
  return out;
}
