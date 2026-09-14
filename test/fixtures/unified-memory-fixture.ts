// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One seeded world shared by every unified-context surface test (direct
 * builder, `recall <q> all`, GET /mem/context, MCP think(context), passthru
 * injection, adapter §4). Seeds, for the owner:
 *
 *   - a VERIFIED legacy note            → [trusted]
 *   - a plain (unverified) legacy note  → [unverified]
 *   - a skill-tier legacy note          → skills
 *   - a durable `remember` record + captured source → [evidence]
 *   - a finished assistance proposal    → [proposal]
 *
 * The proposal is built the honest way: the owner files `assist_create`
 * naming a second world user as worker; the worker claims, performs a
 * witnessed `assist_read` of the record, and finishes `answered` citing it.
 */

import type { Engine } from "../../src/engine/engine";
import { residentMemoryOperation } from "../../src/memory/resident-service";
import type { MarinaDB } from "../../src/persistence/database";
import type { EntityId } from "../../src/types";
import { MockConnection } from "../helpers";

export const FIXTURE_QUERY = "Amber deployment port";

export interface UnifiedFixture {
  owner: string;
  worker: string;
  ownerEntityId: EntityId;
  workerEntityId: EntityId;
  ownerConn: MockConnection;
  spaceId: string;
  verifiedNoteId: number;
  plainNoteId: number;
  skillNoteId: number;
  recordId: string;
  sourceId: string;
  jobId: string;
}

export async function seedUnifiedFixture(
  engine: Engine,
  db: MarinaDB,
  opts: { owner?: string; worker?: string; disconnect?: boolean } = {},
): Promise<UnifiedFixture> {
  const owner = opts.owner ?? "Ada";
  const worker = opts.worker ?? "Bea";

  // World logins create the `users` rows (= human principals) the durable
  // service binds to. Same path every real resident and client takes.
  const ownerConn = new MockConnection(`fixture_${owner}`);
  engine.addConnection(ownerConn);
  const ownerLogin = engine.login(ownerConn.id, owner);
  if (!("entityId" in ownerLogin)) throw new Error(`owner login failed: ${ownerLogin.error}`);
  const workerConn = new MockConnection(`fixture_${worker}`);
  engine.addConnection(workerConn);
  const workerLogin = engine.login(workerConn.id, worker);
  if (!("entityId" in workerLogin)) throw new Error(`worker login failed: ${workerLogin.error}`);

  // Legacy silo.
  const verifiedNoteId = db.createNote(
    owner,
    "Amber deployment runbook: the production port is 7419 (verified against the ops wiki)",
    undefined,
    { importance: 8, noteType: "fact", verificationStatus: "verified", confidence: 0.95 },
  );
  const plainNoteId = db.createNote(
    owner,
    "Amber deployment hunch: staging probably uses the same port as production",
    undefined,
    { importance: 5, noteType: "observation" },
  );
  const skillNoteId = db.createNote(
    owner,
    "Amber deployment skill: run the smoke tests, then verify the health endpoint on the port",
    undefined,
    { importance: 6, noteType: "skill" },
  );

  // Durable silo — resident space is created lazily on first space-bound op.
  const captured = await residentMemoryOperation(db, owner, {
    operation: "capture",
    input: {
      session_id: "fixture",
      content: "Ops wiki excerpt: Amber deployment listens on port 7419 in production.",
    },
  });
  const sourceId = (captured.result as { id: string }).id;
  const remembered = await residentMemoryOperation(db, owner, {
    operation: "remember",
    input: {
      content: "Amber deployment uses port 7419",
      subject: "amber",
      source_ids: [sourceId],
    },
  });
  const spaceId = remembered.space_id!;
  const recordId = (remembered.result as { id: string }).id;

  // Assistance proposal: owner asks, worker claims → witnessed read → answers.
  const created = await residentMemoryOperation(db, owner, {
    operation: "assist_create",
    input: { worker_name: worker, role: "librarian", task: "Find the Amber deployment port" },
  });
  const jobId = (created.result as { id: string }).id;
  const claimed = await residentMemoryOperation(db, worker, {
    operation: "assist_claim",
    id: jobId,
    key: `claim:${jobId}`,
  });
  const lease = (claimed.result as { lease_token: string }).lease_token;
  await residentMemoryOperation(db, worker, {
    operation: "assist_read",
    id: jobId,
    input: { lease_token: lease, request: { operation: "get", id: recordId } },
  });
  await residentMemoryOperation(db, worker, {
    operation: "assist_finish",
    id: jobId,
    key: `finish:${jobId}`,
    input: {
      lease_token: lease,
      completion: {
        status: "answered",
        answer: "Amber deployment port is 7419 per the remembered record.",
        citations: [{ kind: "record", space_id: spaceId, id: recordId, version: 1, quote: "7419" }],
      },
    },
  });

  if (opts.disconnect) {
    engine.removeConnection(ownerConn.id);
    engine.removeConnection(workerConn.id);
  }

  return {
    owner,
    worker,
    ownerEntityId: ownerLogin.entityId,
    workerEntityId: workerLogin.entityId,
    ownerConn,
    spaceId,
    verifiedNoteId,
    plainNoteId,
    skillNoteId,
    recordId,
    sourceId,
    jobId,
  };
}

/** `{ tier: [ids…] }` for the non-empty tiers — the cross-surface equality key. */
export function tierIds(
  result: { tiers: { tier: string; items: { id: string }[] }[] } | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const tier of result?.tiers ?? []) {
    if (tier.items.length > 0) out[tier.tier] = tier.items.map((item) => item.id);
  }
  return out;
}

/** Expected tier→ids map for a fixture. */
export function expectedTierIds(fx: UnifiedFixture): Record<string, string[]> {
  return {
    skill: [String(fx.skillNoteId)],
    trusted: [String(fx.verifiedNoteId)],
    evidence: [fx.recordId, fx.sourceId],
    proposal: [fx.jobId],
    unverified: [String(fx.plainNoteId)],
  };
}
