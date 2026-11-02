// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Usefulness raters: the evidence that a served memory was USED, written
 * through the one chokepoint (`applyUsefulness`). Four raters, all mechanical,
 * none a model call:
 *
 * - `citation` (+1 α): the entity names a note it was recently served
 *   (`note:N` or `#N`) in something it writes — a saved note, a task
 *   submission. Only a note served to THAT entity inside `CITATION_WINDOW_MS`
 *   counts: a citation of memory the retrieval never surfaced says nothing
 *   about retrieval. Idempotent per (item, entity, citing ref).
 * - `outcome` (+1 α on success, +¼ β on failure): a resolved outcome for work
 *   during which the record was served to the owner — the `usefulness`
 *   outcome consumer (`src/outcomes/deliver.ts`). A task's window is its
 *   claim; anything else, the day before resolution.
 * - `explicit` (+½ α / +½ β): `memory useful|useless <id>`, only on an item
 *   served to the caller in the last week, once per item per entity per day.
 * - `unused` (+¼ β): a serve followed by no citation from that entity within
 *   `UNUSED_GRACE_MS`, settled by the hourly `memory-usefulness-settle` job,
 *   at most `UNUSED_DAILY_CAP` per item per day so a popular item is not
 *   buried by one busy afternoon.
 *
 * Negative evidence is real evidence: it may demote. Self-evidence never moves
 * how others rank a note (`usefulnessPosterior({ excludeSelf })`).
 *
 * The shared-ranking factor (`MARINA_MEMORY_USEFULNESS_RANKING`,
 * `usefulnessRankingMode`) is bounded like writer standing: at most
 * ±`USEFULNESS_WEIGHT` of one rank-1 hit, applied only to SHARED retrieval,
 * `observe` reports it without reordering.
 */

import { parseEvidenceRefs } from "../decisions/evidence";
import { tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import {
  citedAfter,
  countUsefulnessRatings,
  hasUsefulnessRating,
  itemsServedTo,
  servedToEntity,
  unsettledServes,
} from "../persistence/db-memory-usefulness";
import type { OutcomeRow } from "../persistence/db-outcomes";
import type { EngineEvent } from "../types";
import { findDurableTwin } from "./legacy-projection";

const logger = new Logger();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A citation counts only for a note served to the citer this recently. */
export const CITATION_WINDOW_MS = DAY_MS;
/** Work with no claim window: the day before the outcome resolved. */
export const OUTCOME_WINDOW_MS = DAY_MS;
/** Items rated per outcome, most recently served first. */
export const OUTCOME_MAX_ITEMS = 50;
/** An explicit vote needs a serve to the voter this recently. */
export const EXPLICIT_WINDOW_MS = 7 * DAY_MS;
/** A serve this old with no citation is `unused`. */
export const UNUSED_GRACE_MS = 6 * HOUR_MS;
/** `unused` ratings per item per day, at most. */
export const UNUSED_DAILY_CAP = 4;
/** Serves settled per job run. */
export const UNUSED_SETTLE_BATCH = 2000;
/** Durable cursor for the settle job (`core_memory` owner / key). */
export const USEFULNESS_STATE_OWNER = "memory:usefulness";
export const UNUSED_CURSOR_KEY = "settled_serve_id";

export const OUTCOME_SUCCESS_ALPHA = 1;
export const OUTCOME_FAILURE_BETA = 0.25;
export const EXPLICIT_WEIGHT = 0.5;
export const UNUSED_BETA = 0.25;

// ─── Ranking mode ────────────────────────────────────────────────────────────

export {
  USEFULNESS_WEIGHT,
  type UsefulnessRankingMode,
  usefulnessRankingMode,
  usefulnessTerm,
} from "../persistence/db-memory-usefulness";

// ─── Citations ───────────────────────────────────────────────────────────────

const HASH_REF = /(?:^|[\s(,;])#(\d{1,12})\b/g;

/** Note ids `text` cites: `note:N` evidence refs and bare `#N` handles, distinct, capped. */
export function citedNoteIds(text: string, cap = 16): number[] {
  const out = new Set<number>();
  for (const ref of parseEvidenceRefs(text)) if (ref.kind === "note") out.add(ref.id);
  for (const m of text.matchAll(HASH_REF)) {
    out.add(Number(m[1]));
    if (out.size >= cap) break;
  }
  return [...out].slice(0, cap);
}

/**
 * Rate the notes `text` cites that were served to `entityName` within the
 * citation window: `citation` +1 α each, once per (note, entity, `ref`).
 * Returns the note ids rated.
 */
export function rateCitations(
  db: MarinaDB,
  input: { entityName: string; text: string; ref: string; at?: number },
): number[] {
  const at = input.at ?? Date.now();
  const rated: number[] = [];
  for (const noteId of citedNoteIds(input.text)) {
    const itemId = String(noteId);
    const twin = findDurableTwin(db, noteId)?.recordId ?? null;
    const raw = db.memoryRepository().raw;
    if (!servedToEntity(raw, input.entityName, itemId, at - CITATION_WINDOW_MS, at, twin)) continue;
    if (hasUsefulnessRating(raw, itemId, "citation", input.entityName, input.ref)) continue;
    db.applyUsefulness({
      itemId,
      recordId: twin,
      rater: "citation",
      raterEntity: input.entityName,
      alpha: 1,
      ref: input.ref,
      createdAt: at,
    });
    rated.push(noteId);
  }
  return rated;
}

/**
 * Engine events that are citations: a saved note naming other notes, and a
 * task submission (its text read back from the claim). Wired beside the
 * outcome observer in `Engine`; never throws.
 */
export function observeUsefulnessEvent(db: MarinaDB | undefined, event: EngineEvent): void {
  if (!db) return;
  tryLog(logger, "memory", "usefulness citation not recorded", () => {
    if (event.type === "note_created") {
      if (!event.content || !event.authorName) return;
      rateCitations(db, {
        entityName: event.authorName,
        text: event.content,
        ref: `note:${event.noteId}`,
        at: event.timestamp,
      });
      return;
    }
    if (event.type === "task_submitted") {
      const claim = db
        .getTaskClaims(event.taskId)
        .find((row) => row.entity_id === event.entity && row.submission_text);
      if (!claim?.submission_text) return;
      rateCitations(db, {
        entityName: claim.entity_name,
        text: claim.submission_text,
        ref: `task:${event.taskId}:submission:${claim.submitted_at ?? event.timestamp}`,
        at: event.timestamp,
      });
    }
  });
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

/** The work window of an outcome for its owner: a task's claim, else the day before. */
export function outcomeWorkWindow(db: MarinaDB, o: OutcomeRow): { since: number; until: number } {
  const until = o.resolved_at;
  const refs = (() => {
    try {
      return (JSON.parse(o.refs_json ?? "[]") as unknown[]).filter(
        (r): r is string => typeof r === "string",
      );
    } catch {
      return [];
    }
  })();
  const taskRef = refs.find((r) => /^task:\d+$/.test(r));
  if (taskRef && o.owner) {
    const taskId = Number(taskRef.slice(5));
    const claim = db
      .getTaskClaims(taskId)
      .filter((row) => row.entity_name === o.owner && row.claimed_at <= until)
      .sort((a, b) => b.claimed_at - a.claimed_at)[0];
    if (claim) return { since: claim.claimed_at, until };
  }
  return { since: until - OUTCOME_WINDOW_MS, until };
}

/**
 * The `usefulness` outcome consumer: every item served to the outcome's owner
 * during the work gets +1 α (success) or +¼ β (failure), ref `outcome:<id>`,
 * idempotent per outcome. Returns how many items were rated.
 */
export function rateOutcomeUsefulness(db: MarinaDB, o: OutcomeRow): number {
  if (!o.owner) return 0;
  const raw = db.memoryRepository().raw;
  const ref = `outcome:${o.id}`;
  const { since, until } = outcomeWorkWindow(db, o);
  const items = itemsServedTo(raw, o.owner, since, until, OUTCOME_MAX_ITEMS);
  let rated = 0;
  for (const item of items) {
    if (hasUsefulnessRating(raw, item.itemId, "outcome", o.owner, ref)) continue;
    db.applyUsefulness({
      itemId: item.itemId,
      recordId: item.recordId,
      rater: "outcome",
      raterEntity: o.owner,
      ...(o.succeeded ? { alpha: OUTCOME_SUCCESS_ALPHA } : { beta: OUTCOME_FAILURE_BETA }),
      ref,
      createdAt: o.resolved_at,
    });
    rated++;
  }
  return rated;
}

// ─── Explicit ────────────────────────────────────────────────────────────────

export type ExplicitVote = "useful" | "useless";

/**
 * `memory useful|useless <id>`: a half-weight vote on an item served to the
 * voter in the last week, once per item per voter per day. Returns why it was
 * refused, or undefined when recorded.
 */
export function rateExplicit(
  db: MarinaDB,
  input: { entityName: string; itemId: string; vote: ExplicitVote; at?: number },
): string | undefined {
  const at = input.at ?? Date.now();
  const raw = db.memoryRepository().raw;
  const numeric = /^\d+$/.test(input.itemId) ? Number(input.itemId) : undefined;
  const twin = numeric !== undefined ? (findDurableTwin(db, numeric)?.recordId ?? null) : null;
  if (!servedToEntity(raw, input.entityName, input.itemId, at - EXPLICIT_WINDOW_MS, at, twin))
    return "that item was not served to you in the last 7 days, so your vote says nothing about retrieval";
  if (countUsefulnessRatings(raw, input.itemId, "explicit", at - DAY_MS, input.entityName) > 0)
    return "you already voted on that item today";
  db.applyUsefulness({
    itemId: input.itemId,
    recordId: twin,
    rater: "explicit",
    raterEntity: input.entityName,
    ...(input.vote === "useful" ? { alpha: EXPLICIT_WEIGHT } : { beta: EXPLICIT_WEIGHT }),
    ref: `explicit:${input.vote}`,
    createdAt: at,
  });
  return undefined;
}

// ─── Surfaced but unused ─────────────────────────────────────────────────────

/**
 * Settle serves older than the grace period: one `unused` +¼ β per serve with
 * no later `citation` from the same entity, capped per item per day. The
 * cursor (last settled serve id) is durable, so a restart never re-rates.
 * Returns what it did; `cursor` is the new high-water mark.
 */
export function settleUnusedServes(
  db: MarinaDB,
  opts: { now?: number; batch?: number } = {},
): { scanned: number; unused: number; cited: number; capped: number; cursor: number } {
  const now = opts.now ?? Date.now();
  const raw = db.memoryRepository().raw;
  const cursorRow = db.getCoreMemory(USEFULNESS_STATE_OWNER, UNUSED_CURSOR_KEY);
  let cursor = Number(cursorRow?.value ?? 0) || 0;
  const serves = unsettledServes(
    raw,
    cursor,
    now - UNUSED_GRACE_MS,
    opts.batch ?? UNUSED_SETTLE_BATCH,
  );
  let unused = 0;
  let cited = 0;
  let capped = 0;
  for (const serve of serves) {
    cursor = Math.max(cursor, serve.id);
    if (citedAfter(raw, serve.entityName, serve.itemId, serve.servedAt)) {
      cited++;
      continue;
    }
    if (
      countUsefulnessRatings(raw, serve.itemId, "unused", serve.servedAt - DAY_MS) >=
      UNUSED_DAILY_CAP
    ) {
      capped++;
      continue;
    }
    db.applyUsefulness({
      itemId: serve.itemId,
      rater: "unused",
      raterEntity: serve.entityName,
      beta: UNUSED_BETA,
      ref: `serve:${serve.id}`,
      createdAt: serve.servedAt,
    });
    unused++;
  }
  if (serves.length) db.setCoreMemory(USEFULNESS_STATE_OWNER, UNUSED_CURSOR_KEY, String(cursor));
  return { scanned: serves.length, unused, cited, capped, cursor };
}
