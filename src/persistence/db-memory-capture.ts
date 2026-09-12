// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { MemoryError, object, textValue } from "../memory/service-types";
import { captureSource, mutation } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

/** Bounded all-or-nothing batches retain per-source keys across regrouped retries. */
export function captureMemoryBatch(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 64)
    throw new MemoryError(400, "invalid_batch", "A capture batch requires 1–64 sources");
  const items = raw.map((item) => {
    const input = object(item);
    if (input.content === undefined)
      throw new MemoryError(400, "invalid_batch", "Source content is required");
    return {
      content: input.content,
      key: textValue(input.key, "key", 128),
      session_id:
        input.session_id === undefined ? undefined : textValue(input.session_id, "session_id", 256),
    };
  });
  if (Buffer.byteLength(JSON.stringify(items)) > 1024 * 1024)
    throw new MemoryError(413, "batch_too_large", "Capture batch exceeds 1 MiB");
  return mutation(db, actor, space, key, "sources.capture_batch", items, () => {
    const receipts = items.map((item) =>
      captureSource(db, actor, space, item.content, item.session_id, item.key),
    );
    return { id: space, receipts, seq: Math.max(...receipts.map((receipt) => receipt.seq!)) };
  });
}
