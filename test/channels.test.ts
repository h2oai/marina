// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_channels.db";

describe("Channels", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    conn1.clear();
    conn2.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should create a channel and join it", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    expect(conn1.lastText()).toContain('Created and joined channel "general"');
  });

  it("should list channels for a member", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    conn1.clear();
    engine.processCommand(conn1.entity!, "channel list");
    expect(conn1.lastText()).toContain("general");
  });

  it("should allow join and leave", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    conn2.clear();
    engine.processCommand(conn2.entity!, "channel join general");
    expect(conn2.lastText()).toContain('Joined channel "general"');

    conn2.clear();
    engine.processCommand(conn2.entity!, "channel leave general");
    expect(conn2.lastText()).toContain('Left channel "general"');
  });

  it("should send messages to channel members", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    engine.processCommand(conn2.entity!, "channel join general");
    conn1.clear();
    conn2.clear();

    engine.processCommand(conn1.entity!, "channel send general Hello everyone!");
    expect(stripAnsi(conn1.lastText())).toContain("[general] You: Hello everyone!");
    expect(stripAnsi(conn2.lastText())).toContain("[general] Alice: Hello everyone!");
  });

  it("should show channel history", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    engine.processCommand(conn2.entity!, "channel join general");
    engine.processCommand(conn1.entity!, "channel send general First message");
    engine.processCommand(conn2.entity!, "channel send general Second message");
    conn1.clear();

    engine.processCommand(conn1.entity!, "channel history general");
    const text = conn1.lastText();
    expect(text).toContain("First message");
    expect(text).toContain("Second message");
  });

  it("should prevent sending to channel you're not in", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    conn2.clear();
    engine.processCommand(conn2.entity!, "channel send general test");
    expect(conn2.lastText()).toContain("not in channel");
  });

  it("should prevent duplicate channel names", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    conn1.clear();
    engine.processCommand(conn1.entity!, "channel create general");
    expect(conn1.lastText()).toContain("already exists");
  });

  it("should list all channels", () => {
    engine.processCommand(conn1.entity!, "channel create general");
    engine.processCommand(conn1.entity!, "channel create announcements");
    conn1.clear();
    engine.processCommand(conn1.entity!, "channel listall");
    const text = conn1.lastText();
    expect(text).toContain("announcements");
    expect(text).toContain("general");
  });

  it("channel manager should create room channels", () => {
    const cm = engine.channelManager!;
    const ch = cm.ensureRoomChannel("core/nexus");
    expect(ch.type).toBe("room");
    expect(ch.name).toBe("core/nexus");

    // Calling again returns same channel
    const ch2 = cm.ensureRoomChannel("core/nexus");
    expect(ch2.id).toBe(ch.id);
  });

  it("channel manager should create direct message channels", () => {
    const cm = engine.channelManager!;
    const ch = cm.getOrCreateDirect("entity1", "entity2");
    expect(ch.type).toBe("direct");

    // Order doesn't matter
    const ch2 = cm.getOrCreateDirect("entity2", "entity1");
    expect(ch2.id).toBe(ch.id);
  });

  it("extraMeta cannot override the canonical channel/senderName/content fields", () => {
    const cm = engine.channelManager!;
    const ch = cm.createChannel({ type: "custom", name: "general" });
    cm.addMember(ch.id, conn2.entity!);
    conn2.clear();

    // A malicious caller tries to spoof the authoritative fields via extraMeta.
    cm.send(ch.id, conn1.entity!, "Alice", "real content", {
      content: "spoofed content",
      senderName: "Eve",
      channel: "spoofed-channel",
      untrusted: true,
    });

    const msg = conn2.messages.find((m) => m.data?.channel === "general");
    expect(msg).toBeDefined();
    // Canonical values win; the spoofed overrides are ignored.
    expect(msg!.data.content).toBe("real content");
    expect(msg!.data.senderName).toBe("Alice");
    expect(msg!.data.channel).toBe("general");
    // Non-canonical extraMeta still passes through.
    expect(msg!.data.untrusted).toBe(true);
  });
});
