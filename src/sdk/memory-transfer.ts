// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export const MEMORY_TRANSFER_KINDS = [
  "source",
  "record",
  "revision",
  "vocabulary",
  "checkpoint",
] as const;
export type MemoryTransferKind = (typeof MEMORY_TRANSFER_KINDS)[number];
export interface MemoryTransferHeader {
  schema: "marina.memory.transfer.v1";
  origin_space: string;
  generation: number;
  counts: Record<MemoryTransferKind, number>;
}
export interface MemoryTransferFragment {
  kind: MemoryTransferKind;
  id: string;
  version: number;
  offset: number;
  size: number;
  sha256: string;
  base64: string;
}
export interface MemoryTransferPage {
  header: MemoryTransferHeader;
  position: number;
  previous: string;
  fragments: MemoryTransferFragment[];
  done: boolean;
  sha256: string;
  next_cursor: string | null;
}
export interface MemoryTransferStatus {
  id: string;
  header: MemoryTransferHeader;
  state: "receiving" | "ready" | "committed" | "aborted";
  position: number;
  sha256: string;
  bytes: number;
  next_cursor: string | null;
  expires_at: number;
}
export interface MemoryTransferList {
  transfers: (MemoryTransferStatus & { expired: boolean })[];
  next_cursor: string | null;
}
export interface MemoryTransferFilter {
  state?: MemoryTransferStatus["state"];
  expired?: boolean;
  limit?: number;
  cursor?: string;
}
