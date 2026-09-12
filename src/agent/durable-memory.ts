// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { MarinaClient } from "../sdk/client";
import { withMemoryAbort } from "../sdk/memory-abort";
import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import { retryMemoryOperation } from "../sdk/memory-retry";
import type { MemoryCheckpoint, MemoryReceipt } from "../sdk/memory-types";

type Archive = { source_ids: string[]; manifest_source_id?: string; sha256: string };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const references = (data: Record<string, unknown> | undefined) => {
  const ids: string[] = [];
  for (const kind of ["archive", "journal"]) {
    const archive = data?.[kind] as Archive | undefined;
    if (archive)
      ids.push(
        ...archive.source_ids,
        ...(archive.manifest_source_id ? [archive.manifest_source_id] : []),
      );
  }
  return [...new Set(ids)];
};

/** Private resident evidence; serialized writes, stable retry keys and remote CAS.
 * No inference, goal selection or implicit sharing is performed here. */
export class DurableResidentMemory {
  private pending: Promise<unknown> = Promise.resolve();
  private session = crypto.randomUUID();
  private parts = new Map<string, MemoryReceipt>();
  private hadCheckpoint = false;
  constructor(private client: Pick<MarinaClient, "memoryService">) {}

  private call<T>(request: MemoryOperationRequest, signal?: AbortSignal): Promise<T> {
    return retryMemoryOperation(
      async () => {
        const result = await this.client.memoryService(request, undefined, signal);
        if (!result.ok)
          throw new MemoryClientError(
            result.error.status,
            result.error.code,
            result.error.message,
            result.error.retry_after_ms,
          );
        return result.result as T;
      },
      { signal },
    );
  }
  private serialize<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const guarded = () => {
      signal?.throwIfAborted();
      return run();
    };
    const next = this.pending.then(guarded, guarded);
    this.pending = next.catch(() => {});
    return withMemoryAbort(() => next, signal);
  }
  async checkpoint(signal?: AbortSignal): Promise<MemoryCheckpoint | null> {
    try {
      const result = await this.call<MemoryCheckpoint>(
        { operation: "checkpoint", id: "resident" },
        signal,
      );
      this.hadCheckpoint = true;
      return result;
    } catch (error) {
      if (
        error instanceof MemoryClientError &&
        error.status === 404 &&
        error.code === "checkpoint_not_found"
      )
        return null;
      throw error;
    }
  }
  private async writableCheckpoint(signal?: AbortSignal): Promise<MemoryCheckpoint | null> {
    const previous = await this.checkpoint(signal);
    if (!previous && this.hadCheckpoint)
      throw new MemoryClientError(
        409,
        "checkpoint_invalidated",
        "Resident checkpoint was invalidated; restart before archiving local context",
      );
    return previous;
  }
  save(data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(data));
    return this.serialize(async () => {
      const previous = await this.writableCheckpoint(signal);
      const merged = { ...previous?.data, ...snapshot };
      await this.call(
        {
          operation: "save_checkpoint",
          id: "resident",
          key: crypto.randomUUID(),
          input: {
            expected_version: previous?.version ?? 0,
            source_cursor: previous?.source_cursor ?? 0,
            source_ids: references(merged),
            data: merged,
          },
        },
        signal,
      );
      this.hadCheckpoint = true;
    }, signal);
  }
  archive(messages: unknown[], summary: string, signal?: AbortSignal): Promise<void> {
    // Snapshot before entering the asynchronous queue: callers may keep appending.
    const originals = JSON.stringify(messages),
      count = messages.length;
    return this.serialize(() => this.persist(originals, count, summary, "archive", signal), signal);
  }
  journal(message: unknown, signal?: AbortSignal): Promise<void> {
    const original = JSON.stringify([message]);
    return this.serialize(() => this.persist(original, 1, "", "journal", signal), signal);
  }
  private async persist(
    original: string,
    messageCount: number,
    summary: string,
    kind: "archive" | "journal",
    signal?: AbortSignal,
  ): Promise<void> {
    const hash = digest(original);
    const previous = await this.writableCheckpoint(signal);
    const prior = previous?.data[kind] as Archive | undefined;
    if (kind === "archive" && prior?.sha256 === hash) return;
    const operation = kind === "journal" ? crypto.randomUUID() : hash;
    const messages = JSON.parse(original) as unknown[];
    const segments = [
      "[",
      ...messages.map((message, i) => `${i ? "," : ""}${JSON.stringify(message)}`),
      "]",
    ];
    const ordered: string[] = [];
    const missing = new Map<string, string>();
    for (const segment of segments) {
      const chunk = Buffer.from(segment);
      for (let start = 0; start < chunk.length; ) {
        let end = Math.min(chunk.length, start + 16384);
        while (end < chunk.length && (chunk[end]! & 0xc0) === 0x80) end--;
        const text = chunk.subarray(start, end).toString("utf8"),
          partHash = digest(text);
        ordered.push(partHash);
        if (!this.parts.has(partHash)) missing.set(partHash, text);
        start = end;
      }
    }
    if (ordered.length > 2000)
      throw new MemoryClientError(
        413,
        "archive_capacity",
        "Archive exceeds 2000 parts; original context retained",
      );
    const entries = [...missing];
    for (let offset = 0; offset < entries.length; ) {
      const batch: [string, string][] = [];
      let bytes = 0;
      while (offset < entries.length && batch.length < 64) {
        const item = entries[offset]!;
        const size = Buffer.byteLength(JSON.stringify(item[1])) + 512;
        if (batch.length && bytes + size > 512 * 1024) break;
        batch.push(item);
        bytes += size;
        offset++;
      }
      const receipt = await this.call<MemoryReceipt & { receipts: MemoryReceipt[] }>(
        {
          operation: "capture_batch",
          key: `archive-batch:${this.session}:${digest(JSON.stringify(batch.map(([id]) => id)))}`,
          input: {
            items: batch.map(([id, content]) => ({
              content,
              session_id: this.session,
              key: `archive:${this.session}:${id}`,
            })),
          },
        },
        signal,
      );
      for (const [index, [id]] of batch.entries()) this.parts.set(id, receipt.receipts[index]!);
    }
    const sourceIds = ordered.map((id) => this.parts.get(id)!.id);
    const manifest = await this.call<MemoryReceipt>(
      {
        operation: "capture",
        key: `manifest:${this.session}:${operation}:${previous?.version ?? 0}`,
        input: {
          session_id: this.session,
          content: {
            format: "json-utf8-parts-v1",
            source_ids: sourceIds,
            sha256: hash,
            kind,
            previous_manifest_source_id: prior?.manifest_source_id ?? null,
          },
        },
      },
      signal,
    );
    const data = {
      lastIntent: "Resume the preserved conversation",
      ...previous?.data,
      [kind]: {
        format: "json-utf8-parts-v1",
        source_ids: sourceIds,
        sha256: hash,
        manifest_source_id: manifest.id,
        session_id: this.session,
        message_count: messageCount,
        ...(kind === "archive" ? { summary: summary.slice(0, 16000) } : {}),
      },
      timestamp: Date.now(),
    };
    await this.call(
      {
        operation: "save_checkpoint",
        id: "resident",
        key: `checkpoint:${this.session}:${operation}:${previous?.version ?? 0}`,
        input: {
          expected_version: previous?.version ?? 0,
          source_cursor: kind === "archive" ? manifest.seq! : (previous?.source_cursor ?? 0),
          source_ids: references(data),
          data,
        },
      },
      signal,
    );
    this.hadCheckpoint = true;
    // A bounded local optimization only; evicted entries still deduplicate remotely.
    while (this.parts.size > 4096) this.parts.delete(this.parts.keys().next().value!);
  }
}
