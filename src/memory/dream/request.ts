// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The compaction-event trigger (Letta's recommended one): when the agent's
 * context is about to be compacted, the region that is leaving its window
 * is exactly what a dream should look at. The adapter files a REQUEST
 * (`memory dream request`, one `core_memory` row under owner `memory:dream`,
 * key `request:<entity>`, numbers and a reason only); a 5-minute job runs a
 * requested dream once the agent has been quiet for DREAM_IDLE_MS, under the
 * budget gate — the material and cooldown gates are what the request waives.
 * A request older than REQUEST_TTL_MS is dropped; a dream of any trigger
 * clears it.
 */

import type { MarinaDB } from "../../persistence/database";
import { parseDreamJson } from "../../persistence/db-memory-dreams";
import { PROPOSAL_OWNER } from "./apply";

export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Messages a compaction must take out before the adapter asks for a dream. */
export const DREAM_COMPACTION_MIN_MESSAGES = 8;

export interface DreamRequest {
  entityName: string;
  reason: string;
  /** Messages the compaction summarised, when known. */
  messages?: number;
  requestedAt: number;
}

const requestKey = (entityName: string) => `request:${entityName}`;

export function requestDream(
  db: MarinaDB,
  entityName: string,
  reason: string,
  opts: { messages?: number; now?: number } = {},
): DreamRequest {
  const value: DreamRequest = {
    entityName,
    reason: reason.trim().slice(0, 80) || "requested",
    ...(opts.messages !== undefined ? { messages: opts.messages } : {}),
    requestedAt: opts.now ?? Date.now(),
  };
  db.setCoreMemory(PROPOSAL_OWNER, requestKey(entityName), JSON.stringify(value));
  return value;
}

/** The pending request, if any; an expired one is dropped on the way. */
export function pendingRequest(
  db: MarinaDB,
  entityName: string,
  now = Date.now(),
): DreamRequest | undefined {
  const row = db.getCoreMemory(PROPOSAL_OWNER, requestKey(entityName));
  if (!row) return undefined;
  const value = parseDreamJson<DreamRequest | null>(row.value, null);
  if (!value || value.entityName !== entityName || now - value.requestedAt > REQUEST_TTL_MS) {
    db.deleteCoreMemory(PROPOSAL_OWNER, requestKey(entityName));
    return undefined;
  }
  return value;
}

export function clearRequest(db: MarinaDB, entityName: string): void {
  db.deleteCoreMemory(PROPOSAL_OWNER, requestKey(entityName));
}

/** Every entity with a pending request. */
export function pendingRequests(db: MarinaDB, now = Date.now()): DreamRequest[] {
  const out: DreamRequest[] = [];
  for (const row of db.listCoreMemory(PROPOSAL_OWNER)) {
    if (!row.key.startsWith("request:")) continue;
    const value = parseDreamJson<DreamRequest | null>(row.value, null);
    if (!value) continue;
    const live = pendingRequest(db, value.entityName, now);
    if (live) out.push(live);
  }
  return out.sort((a, b) => a.requestedAt - b.requestedAt);
}
