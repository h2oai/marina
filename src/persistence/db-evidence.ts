// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalFederationJson } from "../net/federation-crypto";

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

// Canonicalization is delegated to the ONE canonicalizer that feeds every
// hash chain (federation-crypto). A local 8-line fork used to live here — no
// cycle guard, no non-finite rejection — safe only by the accident that this
// file's input is a fixed array of primitives. Byte-identical output for that
// input shape, strictly safer for any future one.
function entryHash(row: Omit<EvidenceReceiptRow, "entry_hash">): string {
  return sha256(
    canonicalFederationJson([
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
      payload_hash: sha256(canonicalFederationJson(input.payload)),
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

export function verifyEvidenceChain(reader: Database, windowLimit = 1_000): EvidenceVerification {
  // Bounded window: this backs UNAUTHENTICATED discovery routes
  // (/api/federation/manifest, /api/evidence/checkpoint), so a full-table
  // rehash would be a free O(n) CPU amplifier. The newest window still
  // verifies hash continuity within itself (its first previous_hash anchors
  // it to the rest of the chain), and the genesis row is checked whenever it
  // falls inside the window.
  const total = (reader.query("SELECT COUNT(*) AS n FROM evidence_receipts").get() as { n: number })
    .n;
  const bounded = Math.min(Math.max(Math.floor(windowLimit), 1), 10_000);
  const rows = (
    reader
      .query("SELECT * FROM evidence_receipts ORDER BY sequence DESC LIMIT ?")
      .all(bounded) as EvidenceReceiptRow[]
  ).reverse();
  const headHash = rows.at(-1)?.entry_hash ?? null;
  const first = rows[0];
  if (first && first.sequence === 1 && first.previous_hash !== null) {
    return { valid: false, entries: total, headHash, firstInvalidSequence: 1 };
  }
  let previous: string | null = first?.previous_hash ?? null;
  let expectedSequence = first?.sequence ?? 1;
  for (const row of rows) {
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
      return { valid: false, entries: total, headHash, firstInvalidSequence: row.sequence };
    }
    previous = row.entry_hash;
    expectedSequence++;
  }
  return { valid: true, entries: total, headHash, firstInvalidSequence: null };
}
