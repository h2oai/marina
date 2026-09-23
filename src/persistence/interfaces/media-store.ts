// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as mediaDb from "../db-media";
import type { ExactKeys } from "./exact-keys";

/** Media jobs (`db-media.ts`). */
export interface MediaStore {
  createMediaJob(job: {
    id: string;
    type: mediaDb.MediaJobType;
    entityName: string;
    entityId: string | null;
    provider: string;
    model: string;
    prompt: string;
    options: Record<string, unknown>;
    costEstimate?: number | null;
    providerJobId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): void;
  updateMediaJob(
    id: string,
    patch: Partial<{
      status: mediaDb.MediaJobStatus;
      assetId: string | null;
      error: string | null;
      costEstimate: number | null;
      providerJobId: string | null;
      metadata: Record<string, unknown> | null;
      options: Record<string, unknown>;
      completedAt: number | null;
    }>,
  ): void;
  getMediaJob(id: string): mediaDb.MediaJobRow | undefined;
  listMediaJobs(opts?: { limit?: number; entityName?: string }): mediaDb.MediaJobRow[];
  countMediaJobsSince(opts: {
    entityName?: string;
    type?: mediaDb.MediaJobType;
    since: number;
  }): number;
}

/** Runtime mirror of `MediaStore`'s method names — the drift test compares it to the facade. */
export const MEDIA_STORE_METHODS = [
  "createMediaJob",
  "updateMediaJob",
  "getMediaJob",
  "listMediaJobs",
  "countMediaJobsSince",
] as const satisfies readonly (keyof MediaStore)[];

export const MEDIA_STORE_COMPLETE: ExactKeys<MediaStore, typeof MEDIA_STORE_METHODS> = true;
