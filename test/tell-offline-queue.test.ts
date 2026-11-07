// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tells for an offline account wait against its durable account id, are handed
 * to the live entity once, and expire after QUEUED_TELL_TTL_MS if it never
 * connects. The engine path (queue on `tell`, deliver after login) is covered
 * in test/agent-tool-failures.test.ts.
 */

import { afterEach, beforeEach, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { QUEUED_TELL_TTL_MS } from "../src/persistence/db-direct-messages";

let db: MarinaDB;
beforeEach(() => {
  db = new MarinaDB(":memory:");
});
afterEach(() => db.close());

const queue = (accountId: string, content: string) =>
  db.queueDirectMessage({
    correlationId: crypto.randomUUID(),
    dedupeKey: content,
    senderId: "e_1",
    senderName: "Ann",
    accountId,
    targetName: accountId === "u_a" ? "Ada" : "Bo",
    content,
  });

it("hands an account only its own queued tells, once, as delivered receipts", () => {
  queue("u_a", "first");
  queue("u_a", "second");
  queue("u_b", "for someone else");
  const taken = db.takeQueuedDirectMessages("u_a", "e_9");
  expect(taken.map((row) => row.content)).toEqual(["first", "second"]);
  expect(taken.every((row) => row.status === "delivered" && row.target_id === "e_9")).toBe(true);
  expect(db.listDirectMessageInbox("e_9").map((row) => row.content)).toEqual(["second", "first"]);
  expect(db.takeQueuedDirectMessages("u_a", "e_10")).toEqual([]);
  expect(db.takeQueuedDirectMessages("u_b", "e_11").map((row) => row.content)).toEqual([
    "for someone else",
  ]);
});

it("a queued tell nobody collects expires and is not delivered later", () => {
  const queued = queue("u_a", "stale");
  if ("full" in queued) throw new Error("unexpected full queue");
  const later = queued.row.created_at + QUEUED_TELL_TTL_MS + 1;
  expect(db.expireDirectMessages(later)).toBe(1);
  expect(db.getDirectMessage(queued.row.id)?.status).toBe("expired");
  expect(db.takeQueuedDirectMessages("u_a", "e_9", later)).toEqual([]);
});
