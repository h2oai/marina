// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalFederationJson,
  type FederationSignature,
  federationSigningAvailable,
  signFederationDocument,
  verifyFederationDocument,
} from "../net/federation-crypto";

export const COGNITIVE_EVENT_KINDS = [
  "input",
  "memory_influence",
  "output",
  "tool_intention",
  "action",
  "consequence",
  "reflection",
  "creation",
] as const;

export type CognitiveEventKind = (typeof COGNITIVE_EVENT_KINDS)[number];

export interface CognitiveEventRow {
  id: string;
  schema: "marina.cognition.event.v1";
  sequence: number;
  kind: CognitiveEventKind;
  actor_id: string;
  journey_id: string | null;
  trace_id: string | null;
  parent_ids_json: string;
  payload_json: string;
  previous_hash: string | null;
  event_hash: string;
  signature_json: string | null;
  created_at: number;
}

export interface CognitiveVerification {
  valid: boolean;
  hashValid: boolean;
  signatureValid: boolean | null;
  error?: string;
}

export function appendCognitiveEvent(
  db: Database,
  input: {
    kind: CognitiveEventKind;
    actorId: string;
    journeyId?: string;
    traceId?: string;
    parentIds?: string[];
    payload: Record<string, unknown>;
    createdAt?: number;
  },
): CognitiveEventRow {
  const append = db.transaction(() => {
    const previous = db
      .query("SELECT sequence, event_hash FROM cognitive_events ORDER BY sequence DESC LIMIT 1")
      .get() as { sequence: number; event_hash: string } | null;
    const unsigned = {
      id: `cog_${randomUUID().slice(0, 16)}`,
      schema: "marina.cognition.event.v1" as const,
      sequence: (previous?.sequence ?? 0) + 1,
      kind: input.kind,
      actorId: input.actorId,
      journeyId: input.journeyId ?? null,
      traceId: input.traceId ?? null,
      parentIds: input.parentIds ?? [],
      payload: input.payload,
      previousHash: previous?.event_hash ?? null,
      createdAt: input.createdAt ?? Date.now(),
    };
    const eventHash = `sha256:${createHash("sha256")
      .update(canonicalFederationJson(unsigned))
      .digest("hex")}`;
    const signed = federationSigningAvailable()
      ? signFederationDocument({ ...unsigned, eventHash })
      : undefined;
    const row: CognitiveEventRow = {
      id: unsigned.id,
      schema: unsigned.schema,
      sequence: unsigned.sequence,
      kind: unsigned.kind,
      actor_id: unsigned.actorId,
      journey_id: unsigned.journeyId,
      trace_id: unsigned.traceId,
      parent_ids_json: JSON.stringify(unsigned.parentIds),
      payload_json: JSON.stringify(unsigned.payload),
      previous_hash: unsigned.previousHash,
      event_hash: eventHash,
      signature_json: signed ? JSON.stringify(signed.signature) : null,
      created_at: unsigned.createdAt,
    };
    db.run(
      `INSERT INTO cognitive_events
       (id, schema, sequence, kind, actor_id, journey_id, trace_id, parent_ids_json,
        payload_json, previous_hash, event_hash, signature_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.schema,
        row.sequence,
        row.kind,
        row.actor_id,
        row.journey_id,
        row.trace_id,
        row.parent_ids_json,
        row.payload_json,
        row.previous_hash,
        row.event_hash,
        row.signature_json,
        row.created_at,
      ],
    );
    return row;
  });
  return append();
}

export function listCognitiveEvents(
  db: Database,
  input: { journeyId?: string; actorId?: string; limit?: number } = {},
): CognitiveEventRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.journeyId) {
    clauses.push("journey_id = ?");
    params.push(input.journeyId);
  }
  if (input.actorId) {
    clauses.push("actor_id = ?");
    params.push(input.actorId);
  }
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  params.push(limit);
  return db
    .query(`SELECT * FROM cognitive_events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY sequence DESC LIMIT ?`)
    .all(...params) as CognitiveEventRow[];
}

export function countCognitiveEvents(
  db: Database,
  input: { journeyId?: string; actorId?: string } = {},
): number {
  const clauses: string[] = [];
  const params: string[] = [];
  if (input.journeyId) {
    clauses.push("journey_id = ?");
    params.push(input.journeyId);
  }
  if (input.actorId) {
    clauses.push("actor_id = ?");
    params.push(input.actorId);
  }
  return (
    db
      .query(
        `SELECT COUNT(*) AS n FROM cognitive_events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
      )
      .get(...params) as { n: number }
  ).n;
}

export function verifyCognitiveEvent(row: CognitiveEventRow): CognitiveVerification {
  // A corrupt or hand-imported row must report as invalid, not throw.
  let parentIds: unknown;
  let payload: unknown;
  let signature: FederationSignature | undefined;
  try {
    parentIds = JSON.parse(row.parent_ids_json);
    payload = JSON.parse(row.payload_json);
    signature = row.signature_json
      ? (JSON.parse(row.signature_json) as FederationSignature)
      : undefined;
  } catch {
    return {
      valid: false,
      hashValid: false,
      signatureValid: row.signature_json ? false : null,
      error: "Malformed stored JSON",
    };
  }
  const unsigned = {
    id: row.id,
    schema: row.schema,
    sequence: row.sequence,
    kind: row.kind,
    actorId: row.actor_id,
    journeyId: row.journey_id,
    traceId: row.trace_id,
    parentIds,
    payload,
    previousHash: row.previous_hash,
    createdAt: row.created_at,
  };
  let hashValid = false;
  try {
    const expected = `sha256:${createHash("sha256")
      .update(canonicalFederationJson(unsigned))
      .digest("hex")}`;
    hashValid = expected === row.event_hash;
  } catch {
    return {
      valid: false,
      hashValid: false,
      signatureValid: signature ? false : null,
      error: "Row is not canonicalizable",
    };
  }
  if (!signature) return { valid: hashValid, hashValid, signatureValid: null };
  const signatureResult = verifyFederationDocument({
    ...unsigned,
    eventHash: row.event_hash,
    signature,
  });
  return {
    valid: hashValid && signatureResult.valid,
    hashValid,
    signatureValid: signatureResult.valid,
    ...(signatureResult.error ? { error: signatureResult.error } : {}),
  };
}
