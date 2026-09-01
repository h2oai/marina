// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  federationSigningAvailable,
  signFederationDocument,
  verifyFederationDocument,
} from "../net/federation-crypto";

export const ECONOMIC_EVENT_KINDS = [
  "offer",
  "acceptance",
  "funding",
  "escrow",
  "resource_use",
  "contribution",
  "delivery",
  "verification",
  "counterexample",
  "dispute",
  "appeal",
  "settlement",
  "refund",
  "royalty",
  "license",
  "transfer",
  "donation",
  "attribution",
] as const;
export type EconomicEventKind = (typeof ECONOMIC_EVENT_KINDS)[number];
export interface EconomicContractRow {
  id: string;
  goal_ref: string;
  terms_json: string;
  verification_method: string;
  dispute_method: string;
  settlement_adapter: string | null;
  asset_ref: string | null;
  created_by: string;
  created_at: number;
}
export interface EconomicEventRow {
  id: string;
  contract_id: string;
  kind: EconomicEventKind;
  actor_ref: string;
  subject_ref: string | null;
  amount: string | null;
  asset_ref: string | null;
  external_ref: string | null;
  causal_refs_json: string;
  data_json: string;
  signature_json: string | null;
  created_at: number;
}
export interface EconomicAdapterRow {
  id: string;
  kind: string;
  network: string;
  capability: "reference" | "observe" | "submit";
  endpoint_ref: string | null;
  configuration_ref: string | null;
  created_by: string;
  created_at: number;
}

export function createEconomicContract(
  db: Database,
  input: {
    goalRef: string;
    terms: Record<string, unknown>;
    verificationMethod: string;
    disputeMethod: string;
    settlementAdapter?: string;
    assetRef?: string;
    createdBy: string;
    id?: string;
  },
): EconomicContractRow {
  const row = {
    id: input.id ?? `contract_${randomUUID().slice(0, 16)}`,
    goal_ref: input.goalRef,
    terms_json: JSON.stringify(input.terms),
    verification_method: input.verificationMethod,
    dispute_method: input.disputeMethod,
    settlement_adapter: input.settlementAdapter ?? null,
    asset_ref: input.assetRef ?? null,
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  db.transaction(() => {
    db.run(
      "INSERT INTO economic_contracts (id,goal_ref,terms_json,verification_method,dispute_method,settlement_adapter,asset_ref,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      Object.values(row),
    );
    appendEconomicEvent(db, {
      contractId: row.id,
      kind: "offer",
      actorRef: input.createdBy,
      subjectRef: input.goalRef,
      assetRef: input.assetRef,
      data: {
        terms: input.terms,
        verificationMethod: input.verificationMethod,
        disputeMethod: input.disputeMethod,
        settlementAdapter: input.settlementAdapter ?? null,
      },
      createdAt: row.created_at,
    });
  })();
  return row;
}
export function getEconomicContract(db: Database, id: string): EconomicContractRow | undefined {
  return (
    (db
      .query("SELECT * FROM economic_contracts WHERE id=?")
      .get(id) as EconomicContractRow | null) ?? undefined
  );
}
export function listEconomicContracts(db: Database): EconomicContractRow[] {
  return db
    .query("SELECT * FROM economic_contracts ORDER BY created_at DESC,id")
    .all() as EconomicContractRow[];
}
export function appendEconomicEvent(
  db: Database,
  input: {
    contractId: string;
    kind: EconomicEventKind;
    actorRef: string;
    subjectRef?: string;
    amount?: string;
    assetRef?: string;
    externalRef?: string;
    causalRefs?: string[];
    data?: Record<string, unknown>;
    id?: string;
    createdAt?: number;
  },
): EconomicEventRow {
  const document = {
    schema: "marina.economic.event.v1",
    id: input.id ?? `economic_event_${randomUUID().slice(0, 16)}`,
    contractId: input.contractId,
    kind: input.kind,
    actorRef: input.actorRef,
    subjectRef: input.subjectRef ?? null,
    amount: input.amount ?? null,
    assetRef: input.assetRef ?? null,
    externalRef: input.externalRef ?? null,
    causalRefs: input.causalRefs ?? [],
    data: input.data ?? {},
    createdAt: input.createdAt ?? Date.now(),
  };
  const signature = sign(document);
  db.run(
    "INSERT INTO economic_events (id,contract_id,kind,actor_ref,subject_ref,amount,asset_ref,external_ref,causal_refs_json,data_json,signature_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      document.id,
      document.contractId,
      document.kind,
      document.actorRef,
      document.subjectRef,
      document.amount,
      document.assetRef,
      document.externalRef,
      JSON.stringify(document.causalRefs),
      JSON.stringify(document.data),
      signature,
      document.createdAt,
    ],
  );
  return db.query("SELECT * FROM economic_events WHERE id=?").get(document.id) as EconomicEventRow;
}
export function listEconomicEvents(db: Database, contractId: string): EconomicEventRow[] {
  return db
    .query("SELECT * FROM economic_events WHERE contract_id=? ORDER BY created_at,rowid")
    .all(contractId) as EconomicEventRow[];
}
export function verifyEconomicEvent(row: EconomicEventRow) {
  if (!row.signature_json) return { valid: false, keyId: null, error: "Event is unsigned" };
  try {
    return verifyFederationDocument({
      schema: "marina.economic.event.v1",
      id: row.id,
      contractId: row.contract_id,
      kind: row.kind,
      actorRef: row.actor_ref,
      subjectRef: row.subject_ref,
      amount: row.amount,
      assetRef: row.asset_ref,
      externalRef: row.external_ref,
      causalRefs: JSON.parse(row.causal_refs_json),
      data: JSON.parse(row.data_json),
      createdAt: row.created_at,
      signature: JSON.parse(row.signature_json),
    });
  } catch {
    return { valid: false, keyId: null, error: "Malformed economic event" };
  }
}
export function createEconomicAdapter(
  db: Database,
  input: {
    id: string;
    kind: string;
    network: string;
    capability: EconomicAdapterRow["capability"];
    endpointRef?: string;
    configurationRef?: string;
    createdBy: string;
  },
): EconomicAdapterRow {
  const row = {
    id: input.id,
    kind: input.kind,
    network: input.network,
    capability: input.capability,
    endpoint_ref: input.endpointRef ?? null,
    configuration_ref: input.configurationRef ?? null,
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  db.run(
    "INSERT INTO economic_adapters (id,kind,network,capability,endpoint_ref,configuration_ref,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
    Object.values(row),
  );
  return row;
}
export function listEconomicAdapters(db: Database): EconomicAdapterRow[] {
  return db.query("SELECT * FROM economic_adapters ORDER BY id").all() as EconomicAdapterRow[];
}
function sign(document: Record<string, unknown>) {
  return federationSigningAvailable()
    ? JSON.stringify(signFederationDocument(document).signature)
    : null;
}
