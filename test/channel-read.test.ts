// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `channel read <name> <id>`: one channel post whole, for members only. It is
// what an agent's cut-off World Events line points to for a channel post.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { toolResultTrust } from "../src/agent/tool-policy";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_channel_read.db");

describe("channel read", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let carol: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c1");
    bob = new MockConnection("c2");
    carol = new MockConnection("c3");
    for (const c of [alice, bob, carol]) engine.addConnection(c);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    engine.spawnEntity("c3", "Carol");
    engine.processCommand(alice.entity!, "channel create general");
    engine.processCommand(bob.entity!, "channel join general");
    engine.processCommand(alice.entity!, "channel create other");
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const long = `verdict: PASS ${"detail ".repeat(400)}end`;

  it("returns the whole post with its sender and ref", () => {
    engine.processCommand(alice.entity!, `channel send general ${long}`);
    const id = bob.messages.at(-1)!.data?.messageId as number;
    bob.clear();
    engine.processCommand(bob.entity!, `channel read general ${id}`);
    const out = bob.messages.at(-1)!;
    expect(stripAnsi(out.data?.text as string)).toContain(`#general message ${id}`);
    expect(stripAnsi(out.data?.text as string)).toContain("Alice");
    expect(out.data?.content).toBe(long);
    expect(out.data?.messageRef).toBe(`channel_msg:${id}`);
    expect(out.data?.senderName).toBe("Alice");
    // `#id` reads the same.
    bob.clear();
    engine.processCommand(bob.entity!, `channel read general #${id}`);
    expect(bob.messages.at(-1)!.data?.content).toBe(long);
  });

  it("refuses non-members, and a post of another channel is not found", () => {
    engine.processCommand(alice.entity!, "channel send general hello");
    const id = bob.messages.at(-1)!.data?.messageId as number;
    carol.clear();
    engine.processCommand(carol.entity!, `channel read general ${id}`);
    expect(stripAnsi(carol.lastText())).toContain('not in channel "general"');
    alice.clear();
    engine.processCommand(alice.entity!, `channel read other ${id}`);
    expect(stripAnsi(alice.lastText())).toContain(`No message #${id} in channel "other"`);
    engine.processCommand(alice.entity!, "channel read general x");
    expect(stripAnsi(alice.lastText())).toContain("Usage: channel read <name> <id>");
  });

  it("its result is fenced as peer messages for agents", () => {
    expect(toolResultTrust("marina_command", { command: "channel read general 12" }).fence).toBe(
      "world_event",
    );
  });
});
