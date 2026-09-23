// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as feedDb from "../db-feed";
import type { ExactKeys } from "./exact-keys";

/** Feed events (`db-feed.ts`). */
export interface FeedStore {
  insertFeedEvent(event: feedDb.InsertFeedEvent): number;
  queryFeedEvents(q?: feedDb.FeedQuery): feedDb.FeedEventRow[];
  trimFeedEvents(keepMs: number): number;
}

/** Runtime mirror of `FeedStore`'s method names — the drift test compares it to the facade. */
export const FEED_STORE_METHODS = [
  "insertFeedEvent",
  "queryFeedEvents",
  "trimFeedEvents",
] as const satisfies readonly (keyof FeedStore)[];

export const FEED_STORE_COMPLETE: ExactKeys<FeedStore, typeof FEED_STORE_METHODS> = true;
