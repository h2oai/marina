// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface EvidenceReceiptRow {
  sequence: number;
  event_type: string;
  ref: string;
  payload_hash: string;
  previous_hash: string | null;
  entry_hash: string;
  created_at: number;
}

export interface EvidenceVerification {
  valid: boolean;
  entries: number;
  headHash: string | null;
  firstInvalidSequence: number | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function entryHash(row: Omit<EvidenceReceiptRow, "entry_hash">): string {
  return sha256(
    canonical([
      row.sequence,
      row.event_type,
      row.ref,
      row.payload_hash,
      row.previous_hash,
      row.created_at,
    ]),
  );
}

export function appendEvidenceReceipt(
  db: Database,
  input: { eventType: string; ref: string; payload: unknown; createdAt?: number },
): EvidenceReceiptRow {
  const append = db.transaction(() => {
    const previous = db
      .query("SELECT sequence, entry_hash FROM evidence_receipts ORDER BY sequence DESC LIMIT 1")
      .get() as { sequence: number; entry_hash: string } | null;
    const base = {
      sequence: (previous?.sequence ?? 0) + 1,
      event_type: input.eventType,
      ref: input.ref,
      payload_hash: sha256(canonical(input.payload)),
      previous_hash: previous?.entry_hash ?? null,
      created_at: input.createdAt ?? Date.now(),
    };
    const row: EvidenceReceiptRow = { ...base, entry_hash: entryHash(base) };
    db.run(
      `INSERT INTO evidence_receipts
       (sequence,event_type,ref,payload_hash,previous_hash,entry_hash,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        row.sequence,
        row.event_type,
        row.ref,
        row.payload_hash,
        row.previous_hash,
        row.entry_hash,
        row.created_at,
      ],
    );
    return row;
  });
  return append();
}

export function listEvidenceReceipts(reader: Database, limit = 100): EvidenceReceiptRow[] {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 1_000);
  return reader
    .query("SELECT * FROM evidence_receipts ORDER BY sequence DESC LIMIT ?")
    .all(bounded) as EvidenceReceiptRow[];
}

export function verifyEvidenceChain(reader: Database): EvidenceVerification {
  const rows = reader
    .query("SELECT * FROM evidence_receipts ORDER BY sequence ASC")
    .all() as EvidenceReceiptRow[];
  let previous: string | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const expectedSequence = index + 1;
    const expectedHash = entryHash({
      sequence: row.sequence,
      event_type: row.event_type,
      ref: row.ref,
      payload_hash: row.payload_hash,
      previous_hash: row.previous_hash,
      created_at: row.created_at,
    });
    if (
      row.sequence !== expectedSequence ||
      row.previous_hash !== previous ||
      row.entry_hash !== expectedHash
    ) {
      return {
        valid: false,
        entries: rows.length,
        headHash: rows.at(-1)?.entry_hash ?? null,
        firstInvalidSequence: row.sequence,
      };
    }
    previous = row.entry_hash;
  }
  return {
    valid: true,
    entries: rows.length,
    headHash: rows.at(-1)?.entry_hash ?? null,
    firstInvalidSequence: null,
  };
}
