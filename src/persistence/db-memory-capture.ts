// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import type { MemoryReceipt } from "../sdk/memory-types";
import { captureSource, mutation, saveMemoryCheckpoint } from "./db-memory-service";
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

/**
 * Capture chunked sources, their manifest, and the checkpoint that names them
 * as ONE transaction. The checkpoint's expected version is checked before
 * anything is captured, so a checkpoint that changed or was forgotten in the
 * meantime rejects the whole request and nothing is stored. `order` lists the
 * manifest's sources: an existing source id, or the index of a new item.
 * The server writes the resolved ids into the manifest (`source_ids`) and
 * into `data[field]` with the manifest's id.
 */
export function captureIntoCheckpoint(
  db: Database,
  actor: MemoryActor,
  space: string,
  name: string,
  raw: unknown,
  key: string,
) {
  const input = object(raw);
  const expected = integer(input.expected_version, "expected_version", 0, Number.MAX_SAFE_INTEGER);
  const session =
    input.session_id === undefined ? undefined : textValue(input.session_id, "session_id", 256);
  const rawItems = input.items ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > 64)
    throw new MemoryError(
      400,
      "invalid_batch",
      "A checkpoint capture takes at most 64 new sources",
    );
  const items = rawItems.map((item) => {
    const value = object(item);
    if (value.content === undefined)
      throw new MemoryError(400, "invalid_batch", "Source content is required");
    return { content: value.content, key: textValue(value.key, "key", 128) };
  });
  if (Buffer.byteLength(JSON.stringify(items)) > 1024 * 1024)
    throw new MemoryError(413, "batch_too_large", "Capture batch exceeds 1 MiB");
  const order = input.order;
  if (!Array.isArray(order) || !order.length || order.length > 2000)
    throw new MemoryError(400, "invalid_order", "order must list 1–2000 sources");
  for (const ref of order)
    if (
      !(typeof ref === "string" && ref.length > 0 && ref.length <= 128) &&
      !(Number.isSafeInteger(ref) && (ref as number) >= 0 && (ref as number) < items.length)
    )
      throw new MemoryError(400, "invalid_order", "order entries are source ids or item indexes");
  const manifest = object(input.manifest);
  const manifestKey = textValue(manifest.key, "manifest.key", 128);
  const manifestContent = object(manifest.content);
  const field = textValue(input.field, "field", 64);
  const entry = object(input.entry);
  const data = object(input.data);
  const checkpointKey = textValue(input.checkpoint_key, "checkpoint_key", 128);
  const kept = input.source_ids ?? [];
  if (!Array.isArray(kept) || kept.some((id) => typeof id !== "string"))
    throw new MemoryError(400, "invalid_sources", "source_ids must be source identifiers");
  const cursor =
    input.cursor === "manifest"
      ? "manifest"
      : integer(input.cursor ?? 0, "cursor", 0, Number.MAX_SAFE_INTEGER);
  return mutation(db, actor, space, key, "checkpoint.capture", { name, input }, () => {
    const current = db
      .query("SELECT version FROM memory_checkpoints WHERE space_id=? AND name=?")
      .get(space, name) as { version: number } | null;
    if ((current?.version ?? 0) !== expected)
      throw new MemoryError(409, "version_conflict", "Checkpoint version is stale");
    const receipts = items.map((item) =>
      captureSource(db, actor, space, item.content, session, item.key),
    );
    const sourceIds = order.map((ref) =>
      typeof ref === "string" ? ref : receipts[ref as number]!.id,
    );
    const manifestReceipt: MemoryReceipt = captureSource(
      db,
      actor,
      space,
      { ...manifestContent, source_ids: sourceIds },
      session,
      manifestKey,
    );
    const saved = saveMemoryCheckpoint(
      db,
      actor,
      space,
      name,
      expected,
      {
        ...data,
        [field]: { ...entry, source_ids: sourceIds, manifest_source_id: manifestReceipt.id },
      },
      cursor === "manifest" ? manifestReceipt.seq! : cursor,
      checkpointKey,
      [...new Set([...(kept as string[]), ...sourceIds, manifestReceipt.id])],
    );
    return {
      id: name,
      version: saved.version,
      seq: saved.seq,
      manifest: { id: manifestReceipt.id, seq: manifestReceipt.seq },
      source_ids: sourceIds,
    };
  });
}
