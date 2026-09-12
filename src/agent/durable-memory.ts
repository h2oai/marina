// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { MarinaClient } from "../sdk/client";
import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import type { MemoryCheckpoint, MemoryReceipt } from "../sdk/memory-types";

/** Uses the resident's existing authenticated world connection. Writes serialize
 * locally, use CAS remotely, and never turn a failed acknowledgment into success. */
export class DurableResidentMemory {
  private pending: Promise<unknown> = Promise.resolve();
  private session = crypto.randomUUID();
  private parts = new Map<string, MemoryReceipt>();
  private hadCheckpoint = false;
  constructor(private client: Pick<MarinaClient, "memoryService">) {}

  private async call<T>(request: MemoryOperationRequest): Promise<T> {
    const result = await this.client.memoryService(request);
    if (!result.ok)
      throw new MemoryClientError(result.error.status, result.error.code, result.error.message);
    return result.result as T;
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pending.then(run, run);
    this.pending = next.catch(() => {});
    return next;
  }
  async checkpoint(): Promise<MemoryCheckpoint | null> {
    try {
      return await this.call<MemoryCheckpoint>({ operation: "checkpoint", id: "resident" });
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
  save(data: Record<string, unknown>): Promise<void> {
    return this.serialize(async () => {
      const previous = await this.writableCheckpoint();
      const archive = previous?.data.archive as
        | { source_ids?: string[]; manifest_source_id?: string }
        | undefined;
      await this.call({
        operation: "save_checkpoint",
        id: "resident",
        key: crypto.randomUUID(),
        input: {
          expected_version: previous?.version ?? 0,
          source_cursor: previous?.source_cursor ?? 0,
          source_ids: [
            ...(archive?.source_ids ?? []),
            ...(archive?.manifest_source_id ? [archive.manifest_source_id] : []),
          ],
          data: { ...previous?.data, ...data },
        },
      });
      this.hadCheckpoint = true;
    });
  }
  private async writableCheckpoint(): Promise<MemoryCheckpoint | null> {
    const previous = await this.checkpoint();
    if (!previous && this.hadCheckpoint)
      throw new MemoryClientError(
        409,
        "checkpoint_invalidated",
        "Resident checkpoint was invalidated; restart before archiving local context",
      );
    this.hadCheckpoint = previous !== null;
    return previous;
  }
  archive(messages: unknown[], summary: string): Promise<void> {
    return this.serialize(async () => {
      const bytes = Buffer.from(JSON.stringify(messages));
      const digest = createHash("sha256").update(bytes).digest("hex");
      const previous = await this.writableCheckpoint();
      const priorArchive = previous?.data.archive as
        | { sha256?: string; manifest_source_id?: string }
        | undefined;
      if (priorArchive?.sha256 === digest) return;
      const sourceIds: string[] = [];
      const retained = new Map<string, MemoryReceipt>();
      let cursor = 0;
      // Stable message boundaries avoid re-uploading the entire growing history
      // when one message is appended. The ordered parts still form exact JSON.
      const segments = [
        "[",
        ...messages.map((message, index) => `${index ? "," : ""}${JSON.stringify(message)}`),
        "]",
      ];
      for (const segment of segments) {
        const chunk = Buffer.from(segment);
        for (let start = 0; start < chunk.length; ) {
          let end = Math.min(chunk.length, start + 16384);
          while (end < chunk.length && (chunk[end]! & 0xc0) === 0x80) end--;
          const content = chunk.subarray(start, end).toString("utf8");
          const partHash = createHash("sha256").update(content).digest("hex");
          const receipt =
            this.parts.get(partHash) ??
            (await this.call<MemoryReceipt>({
              operation: "capture",
              key: `archive:${this.session}:${partHash}`,
              input: {
                content,
                session_id: this.session,
              },
            }));
          this.parts.set(partHash, receipt);
          retained.set(partHash, receipt);
          sourceIds.push(receipt.id);
          cursor = Math.max(cursor, receipt.seq!);
          start = end;
        }
      }
      // Keep an immutable manifest so later compactions cannot erase the order
      // of earlier archives. This links archival sources, not inferred memories.
      const manifest = await this.call<MemoryReceipt>({
        operation: "capture",
        key: `archive-manifest:${this.session}:${digest}:${previous?.version ?? 0}`,
        input: {
          session_id: this.session,
          content: {
            format: "json-utf8-parts-v1",
            source_ids: sourceIds,
            sha256: digest,
            previous_manifest_source_id: priorArchive?.manifest_source_id ?? null,
          },
        },
      });
      cursor = Math.max(cursor, manifest.seq!);
      // All parts are durable before the checkpoint can refer to them. Rejected
      // or lost acknowledgments leave the caller's original context intact.
      await this.call({
        operation: "save_checkpoint",
        id: "resident",
        key: `archive-checkpoint:${this.session}:${digest}:${previous?.version ?? 0}`,
        input: {
          expected_version: previous?.version ?? 0,
          source_cursor: cursor,
          source_ids: [...sourceIds, manifest.id],
          data: {
            lastIntent: "Resume the preserved conversation",
            ...previous?.data,
            archive: {
              format: "json-utf8-parts-v1",
              source_ids: sourceIds,
              manifest_source_id: manifest.id,
              sha256: digest,
              session_id: this.session,
              message_count: messages.length,
              summary: summary.slice(0, 16000),
            },
            timestamp: Date.now(),
          },
        },
      });
      this.parts = retained;
      this.hadCheckpoint = true;
    });
  }
}
