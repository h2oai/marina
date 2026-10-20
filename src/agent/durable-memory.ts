// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { MarinaClient } from "../sdk/client";
import { withMemoryAbort } from "../sdk/memory-abort";
import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import { retryMemoryOperation } from "../sdk/memory-retry";
import type { MemoryCheckpoint, MemoryReceipt } from "../sdk/memory-types";
import { type OutstandingRequest, updateRequestLedger } from "./outstanding-requests";

/**
 * Session prefix of the continuity journal and compaction archives. Those
 * sources are the agent's raw transcript (World Events, peer text, tool
 * results): kept for restore and explicit `source_search`, never served as
 * retrieved evidence (`buildUnifiedContext` excludes them).
 */
export const CONTINUITY_JOURNAL_SESSION_PREFIX = "journal:";

/**
 * JSON replacer for the journal and archives: an image part (base64 bytes from
 * a native look) is recorded as a short text marker, never as its bytes. The
 * source stays reopenable through the look that produced it.
 */
export function withoutImageBytes(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string"
  ) {
    const mime = (value as { mimeType?: unknown }).mimeType;
    return { type: "text", text: `[image ${typeof mime === "string" ? mime : ""} not recorded]` };
  }
  return value;
}

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

/** Stable JSON (sorted keys) for comparing checkpoint data. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/**
 * True when two checkpoint payloads differ only in their `timestamp` — a
 * save that would change nothing else is skipped (an idle resident's
 * 5-minute checkpoint used to write a new version and receipt every time).
 */
export function sameCheckpointData(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown>,
): boolean {
  if (!a) return false;
  const { timestamp: _a, ...left } = a;
  const { timestamp: _b, ...right } = b;
  return stable(left) === stable(right);
}

/** Private resident evidence; serialized writes, stable retry keys and remote CAS.
 * No inference, goal selection or implicit sharing is performed here.
 *
 * Call economy (2026-10-20): a checkpoint-only save (`save`, the request
 * ledger) uses the last checkpoint this instance read or wrote instead of
 * re-reading it (the server's `expected_version` CAS still guards it; a
 * `version_conflict` drops the copy and retries once from a fresh read), and
 * a save whose data is unchanged apart from `timestamp` is skipped — an idle
 * resident used to write an identical checkpoint every five minutes. Archive
 * and journal writes always read fresh: nothing may be captured after a
 * forget invalidated the checkpoint. */
export class DurableResidentMemory {
  private pending: Promise<unknown> = Promise.resolve();
  /** Last checkpoint seen: `undefined` = unknown (read it), `null` = none. */
  private known: MemoryCheckpoint | null | undefined;
  /** Idempotency-key component (unchanged length budget for receipt keys). */
  private sessionKey = crypto.randomUUID();
  /** Capture session of every journal/archive source: tagged so retrieval never
   *  serves the agent's own raw transcript back to it as `[evidence]`. */
  private session = `${CONTINUITY_JOURNAL_SESSION_PREFIX}${this.sessionKey}`;
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
    // allow-empty-catch: serialization tail only; the caller awaits `next` and sees its error
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
      this.known = structuredClone(result);
      return result;
    } catch (error) {
      this.known = undefined;
      if (
        error instanceof MemoryClientError &&
        error.status === 404 &&
        error.code === "checkpoint_not_found"
      ) {
        this.known = null;
        return null;
      }
      throw error;
    }
  }
  private async writableCheckpoint(
    signal?: AbortSignal,
    opts: { fresh?: boolean } = {},
  ): Promise<MemoryCheckpoint | null> {
    if (opts.fresh) this.known = undefined;
    // A copy: callers merge into `previous.data`, and an in-place change to
    // the remembered value would make the unchanged-save check lie.
    const previous =
      this.known !== undefined ? structuredClone(this.known) : await this.checkpoint(signal);
    if (!previous && this.hadCheckpoint)
      throw new MemoryClientError(
        409,
        "checkpoint_invalidated",
        "Resident checkpoint was invalidated; restart before archiving local context",
      );
    return previous;
  }
  /** Save the resident checkpoint and remember what was written. */
  private async writeCheckpoint(
    key: string,
    previous: MemoryCheckpoint | null,
    input: { source_cursor: number; data: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<void> {
    const saved = await this.call<{ version: number }>(
      {
        operation: "save_checkpoint",
        id: "resident",
        key,
        input: {
          expected_version: previous?.version ?? 0,
          source_cursor: input.source_cursor,
          source_ids: references(input.data),
          data: input.data,
        },
      },
      signal,
    );
    this.hadCheckpoint = true;
    this.known =
      typeof saved?.version === "number"
        ? {
            name: "resident",
            version: saved.version,
            source_cursor: input.source_cursor,
            data: structuredClone(input.data),
            updated_at: Date.now(),
          }
        : undefined;
  }
  /**
   * Run a read-modify-write. Any failure drops the remembered checkpoint; a
   * `version_conflict` against a REMEMBERED (not freshly read) checkpoint is
   * retried once from a fresh read — someone else wrote in between.
   */
  private async freshOnConflict(run: () => Promise<void>): Promise<void> {
    const remembered = this.known !== undefined;
    try {
      await run();
    } catch (error) {
      this.known = undefined;
      if (
        remembered &&
        error instanceof MemoryClientError &&
        error.status === 409 &&
        error.code === "version_conflict"
      )
        return run();
      throw error;
    }
  }
  save(data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(data));
    return this.updateCheckpoint((previous) => ({ ...previous, ...snapshot }), signal);
  }
  /** Remove settled requests from the durable ledger (no transcript entry). */
  completeRequests(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    const completed = [...ids];
    return this.updateCheckpoint(
      (previous) => ({
        ...previous,
        outstandingRequests: updateRequestLedger(previous?.outstandingRequests, [], completed),
      }),
      signal,
    );
  }
  saveRequests(requests: OutstandingRequest[], signal?: AbortSignal): Promise<void> {
    const snapshot = requests.map((r) => ({ ...r }));
    return this.updateCheckpoint(
      (previous) => ({
        ...previous,
        outstandingRequests: updateRequestLedger(previous?.outstandingRequests, snapshot),
      }),
      signal,
    );
  }
  private updateCheckpoint(
    update: (previous: Record<string, unknown> | undefined) => Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.serialize(
      () =>
        this.freshOnConflict(async () => {
          const previous = await this.writableCheckpoint(signal);
          const merged = update(previous?.data);
          if (previous && sameCheckpointData(previous.data, merged)) return;
          await this.writeCheckpoint(
            crypto.randomUUID(),
            previous,
            { source_cursor: previous?.source_cursor ?? 0, data: merged },
            signal,
          );
        }),
      signal,
    );
  }
  archive(messages: unknown[], summary: string, signal?: AbortSignal): Promise<void> {
    // Snapshot before entering the asynchronous queue: callers may keep appending.
    const originals = JSON.stringify(messages, withoutImageBytes),
      count = messages.length;
    return this.serialize(
      () => this.freshOnConflict(() => this.persist(originals, count, summary, "archive", signal)),
      signal,
    );
  }
  journal(
    message: unknown,
    signal?: AbortSignal,
    completedRequests: readonly string[] = [],
  ): Promise<void> {
    const original = JSON.stringify([message], withoutImageBytes);
    const completed = [...completedRequests];
    return this.serialize(
      () => this.freshOnConflict(() => this.persist(original, 1, "", "journal", signal, completed)),
      signal,
    );
  }
  private async persist(
    original: string,
    messageCount: number,
    summary: string,
    kind: "archive" | "journal",
    signal?: AbortSignal,
    completedRequests: readonly string[] = [],
  ): Promise<void> {
    const hash = digest(original);
    // Always a fresh read before archiving: nothing may be captured once a
    // forget has invalidated the checkpoint (the remembered copy cannot know).
    const previous = await this.writableCheckpoint(signal, { fresh: true });
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
          key: `archive-batch:${this.sessionKey}:${digest(JSON.stringify(batch.map(([id]) => id)))}`,
          input: {
            items: batch.map(([id, content]) => ({
              content,
              session_id: this.session,
              key: `archive:${this.sessionKey}:${id}`,
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
        key: `manifest:${this.sessionKey}:${operation}:${previous?.version ?? 0}`,
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
      ...(completedRequests.length
        ? {
            outstandingRequests: updateRequestLedger(
              previous?.data.outstandingRequests,
              [],
              completedRequests,
            ),
          }
        : {}),
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
    await this.writeCheckpoint(
      `checkpoint:${this.sessionKey}:${operation}:${previous?.version ?? 0}`,
      previous,
      {
        source_cursor: kind === "archive" ? manifest.seq! : (previous?.source_cursor ?? 0),
        data,
      },
      signal,
    );
    // A bounded local optimization only; evicted entries still deduplicate remotely.
    while (this.parts.size > 4096) this.parts.delete(this.parts.keys().next().value!);
  }
}
