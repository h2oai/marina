// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChannelManager } from "../src/coordination/channel-manager";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_channel_retention_prune.db";
const HOUR_MS = 3_600_000;

describe("pruneExpiredMessages honours retention_hours", () => {
  let db: MarinaDB;
  let raw: Database;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    raw = (db as unknown as { db: Database }).db;
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  function backdate(messageId: number, ageMs: number): void {
    raw.run("UPDATE channel_messages SET created_at = ? WHERE id = ?", [
      Date.now() - ageMs,
      messageId,
    ]);
  }

  it("removes only messages older than the channel's retention window", () => {
    db.createChannel({ id: "ch_conv", type: "model", name: "model-conv-1", retentionHours: 24 });
    const fresh = db.addChannelMessage("ch_conv", "e_1", "Alice", "fresh");
    const stale = db.addChannelMessage("ch_conv", "e_1", "Alice", "stale");
    backdate(stale, 25 * HOUR_MS);
    backdate(fresh, 1 * HOUR_MS);

    const removed = db.pruneExpiredMessages(Date.now());

    expect(removed).toBe(1);
    const remaining = db.getChannelHistory("ch_conv", 10).map((m) => m.content);
    expect(remaining).toEqual(["fresh"]);
  });

  it("keeps everything in channels with NULL retention", () => {
    db.createChannel({ id: "ch_perm", type: "public", name: "general" });
    const old = db.addChannelMessage("ch_perm", "e_1", "Alice", "ancient");
    backdate(old, 400 * 24 * HOUR_MS);
    db.addChannelMessage("ch_perm", "e_1", "Alice", "recent");

    const removed = db.pruneExpiredMessages(Date.now());

    expect(removed).toBe(0);
    expect(db.getChannelHistory("ch_perm", 10)).toHaveLength(2);
  });

  it("ChannelManager.pruneExpiredMessages leaves a 24h conversation's recent history intact", () => {
    const cm = new ChannelManager(db, () => {});
    const ch = cm.createChannel({ type: "model", name: "model-conv-abc", retentionHours: 24 });
    cm.send(ch.id, "e_1", "Alice", "turn 1");
    cm.send(ch.id, "e_1", "Alice", "turn 2");

    expect(cm.pruneExpiredMessages()).toBe(0);
    expect(cm.getHistory(ch.id).map((m) => m.content)).toEqual(["turn 1", "turn 2"]);
  });
});
