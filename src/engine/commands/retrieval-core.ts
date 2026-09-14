// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { creditRecalledReflections } from "../../agent/standing";
import type { MarinaDB, NoteRow } from "../../persistence/database";
import type { GlobalSearchResult } from "../../persistence/db-channels";
import type { ChronicleEntry } from "../../persistence/db-chronicle";
import type { EntityId } from "../../types";

/**
 * Shared retrieval core for the named retrieval verbs (`ask`, `recap`, `dig`).
 *
 * The three verbs differ on one axis each — ask synthesizes via the LLM,
 * recap is retrieve-only, dig adds web evidence — but they read the same
 * internal sources. Before this module each command carried its own copy of
 * the source-gathering loops, which meant every cross-cutting rule (the
 * group-pool membership guard, the chronicle/world-search dedup) had to be
 * patched in multiple places or silently diverge. Gathering lives here once;
 * rendering (labels, colors, context-line tags) stays with each command.
 */

export interface RetrievalLimits {
  /** Personal notes for the asking entity. 0 disables. Default 5. */
  personal?: number;
  /** Notes from the platform `guide` pool. 0 disables. Default 5. */
  guide?: number;
  /** Total hits across all other shared pools (2 per pool). 0 disables. Default 6. */
  pools?: number;
  /** Chronicle entries matching the query. 0 disables. Default 5. */
  chronicle?: number;
  /** Global world-search hits (chronicle hits excluded — they have their own source). 0 disables. Default 5. */
  world?: number;
}

export interface RetrievalContext {
  personal: NoteRow[];
  guide: NoteRow[];
  pools: { pool: string; note: NoteRow }[];
  chronicle: ChronicleEntry[];
  world: GlobalSearchResult[];
  /** True when every source came back empty. */
  isEmpty: boolean;
}

const PER_POOL_LIMIT = 2;

export function gatherRetrievalContext(
  db: MarinaDB,
  entity: { id: EntityId; name: string },
  query: string,
  limits: RetrievalLimits = {},
): RetrievalContext {
  const want = {
    personal: limits.personal ?? 5,
    guide: limits.guide ?? 5,
    pools: limits.pools ?? 6,
    chronicle: limits.chronicle ?? 5,
    world: limits.world ?? 5,
  };

  const personal =
    want.personal > 0 ? db.recallNotes(entity.name, query).slice(0, want.personal) : [];
  for (const note of personal) db.touchNote(note.id);

  let guide: NoteRow[] = [];
  if (want.guide > 0) {
    const guidePool = db.getMemoryPool("guide");
    if (guidePool) {
      guide = db.recallPoolNotes(guidePool.id, query).slice(0, want.guide);
      for (const note of guide) db.touchNote(note.id);
    }
  }

  const pools: { pool: string; note: NoteRow }[] = [];
  if (want.pools > 0) {
    for (const pool of db.listMemoryPools()) {
      if (pool.name === "guide") continue;
      // Membership guard (same rule as passthru-context): a group-scoped pool
      // is readable here only by its members — retrieval verbs must not
      // harvest private group knowledge for outsiders. Ungrouped world pools
      // stay open by design.
      if (pool.group_id && !db.getGroupMember(pool.group_id, entity.id)) continue;
      const hits = db.recallPoolNotes(pool.id, query).slice(0, PER_POOL_LIMIT);
      for (const hit of hits) {
        db.touchNote(hit.id);
        pools.push({ pool: pool.name, note: hit });
        if (pools.length >= want.pools) break;
      }
      if (pools.length >= want.pools) break;
    }
  }

  // Generational credit (Phase 3.7): a shared reflection surfacing in
  // someone ELSE's recap/ask/dig is the author's wisdom put back to use —
  // the same rule `recall` and `pool … recall` apply. Credit goes to the
  // author's durable key (`users.id`, so offline authors are paid too);
  // self-reads and non-reflection tiers earn nothing, and the ledger is
  // idempotent per reflection id. Personal notes are excluded: they are the
  // reader's own. Never allowed to break retrieval.
  creditSharedReflections(db, entity.name, [...guide, ...pools.map((hit) => hit.note)]);

  const chronicle =
    want.chronicle > 0 ? db.queryChronicle({ like: query, limit: want.chronicle }) : [];

  // Chronicle hits get their own dedicated source above — drop them from the
  // world-search results so callers never show the same entry twice.
  const world =
    want.world > 0
      ? db
          .globalSearch(query)
          .filter((h) => h.type !== "chronicle")
          .slice(0, want.world)
      : [];

  return {
    personal,
    guide,
    pools,
    chronicle,
    world,
    isEmpty:
      personal.length === 0 &&
      guide.length === 0 &&
      pools.length === 0 &&
      chronicle.length === 0 &&
      world.length === 0,
  };
}

/** Pay authors of cross-entity reflection-tier hits from shared pools. Idempotent; never throws. */
export function creditSharedReflections(db: MarinaDB, readerName: string, notes: NoteRow[]): void {
  const foreign = notes.filter((n) => n.tier === "reflection" && n.entity_name !== readerName);
  if (foreign.length === 0) return;
  try {
    creditRecalledReflections(db, readerName, foreign, (name) => db.durableKeyForName(name));
  } catch {
    // Standing is a side ledger — a failed credit must never fail a read.
  }
}
