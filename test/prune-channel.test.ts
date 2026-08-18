// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId } from "../src/types";
import { roomId } from "../src/types";
import { pruneChannelToAuthorized, seedChannel } from "../worlds/seed";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_prune_channel.db";

function makeAgent(id: string, name: string): Entity {
  return {
    id: id as EntityId,
    kind: "agent",
    name,
    short: name,
    long: name,
    room: roomId("test/room"),
    properties: {},
    inventory: [],
    createdAt: 0,
  };
}

describe("pruneChannelToAuthorized", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    seedChannel(db, "model-council");
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("keeps allowed orchestrator, removes unauthorized specialist", () => {
    db.saveEntity(makeAgent("e_orchestrator", "Councilor"));
    db.saveEntity(makeAgent("e_specialist", "Historian"));
    const channel = db.getChannelByName("model-council")!;
    db.addChannelMember(channel.id, "e_orchestrator");
    db.addChannelMember(channel.id, "e_specialist");

    pruneChannelToAuthorized(db, "model-council", ["Councilor"]);

    const members = db.getChannelMembers(channel.id).map((m) => m.entity_id);
    expect(members).toEqual(["e_orchestrator"]);
  });

  it("removes orphan members (entity_id with no matching entity row)", () => {
    // No entity saved for e_ghost — simulates a gen1-style external DELETE
    // FROM entities that left channel_members pointing at nothing.
    const channel = db.getChannelByName("model-council")!;
    db.addChannelMember(channel.id, "e_ghost");
    db.saveEntity(makeAgent("e_live", "Councilor"));
    db.addChannelMember(channel.id, "e_live");

    pruneChannelToAuthorized(db, "model-council", ["Councilor"]);

    const members = db.getChannelMembers(channel.id).map((m) => m.entity_id);
    expect(members).toEqual(["e_live"]);
  });

  it("leaves non-agent entities alone", () => {
    // NPCs / objects may be channel members for world-state reasons; the
    // pruner only touches agent entities.
    const npc: Entity = {
      id: "e_npc" as EntityId,
      kind: "npc",
      name: "SomeNPC",
      short: "SomeNPC",
      long: "SomeNPC",
      room: roomId("test/room"),
      properties: {},
      inventory: [],
      createdAt: 0,
    };
    db.saveEntity(npc);
    db.saveEntity(makeAgent("e_specialist", "Historian"));
    const channel = db.getChannelByName("model-council")!;
    db.addChannelMember(channel.id, "e_npc");
    db.addChannelMember(channel.id, "e_specialist");

    pruneChannelToAuthorized(db, "model-council", ["Councilor"]);

    const members = db.getChannelMembers(channel.id).map((m) => m.entity_id);
    // NPC stays (non-agent, out of scope); specialist removed.
    expect(members).toEqual(["e_npc"]);
  });

  it("no-ops when channel doesn't exist", () => {
    expect(() => pruneChannelToAuthorized(db, "nonexistent-channel", ["Anyone"])).not.toThrow();
  });
});
