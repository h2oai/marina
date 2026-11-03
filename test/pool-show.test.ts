// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * A pool listing shows the first sixty characters of a note and, when that is
 * not the whole note, names `pool <name> show <id>`, which prints it whole.
 * Seen 2026-11-03: a reviewer approved a submission having read only the
 * listing's excerpt of the note it cited.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("pool-show");

describe("pool show and listing excerpts", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c1");
    engine.addConnection(alice);
    engine.spawnEntity("c1", "Alice");
    alice.clear();
  });

  afterEach(() => {
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  const text = () => stripAnsi(alice.allTextJoined());
  const long =
    "Launch plan: (1) a concrete up-front outcome; (2) a live Host to Builder to Critic handoff that cites its own artifact; (3) one entry point and one next command. END";

  it("a long note is excerpted in listings with a pointer, and shown whole by `show`", () => {
    engine.processCommand(alice.entity!, "pool create plans");
    engine.processCommand(alice.entity!, `pool plans add ${long}`);
    engine.processCommand(alice.entity!, "pool plans add short note");
    alice.clear();
    engine.processCommand(alice.entity!, "pool plans list");
    const listing = text();
    expect(listing).not.toContain("END");
    expect(listing).toMatch(/…\s+\(pool plans show \d+\)/);
    // A note that fits is shown whole, with no pointer.
    expect(listing).toContain("short note");
    expect(listing).not.toMatch(/short note…/);
    const id = Number(listing.match(/\(pool plans show (\d+)\)/)?.[1]);
    alice.clear();
    engine.processCommand(alice.entity!, "pool plans recall handoff");
    expect(text()).toContain(`(pool plans show ${id})`);
    alice.clear();
    engine.processCommand(alice.entity!, `pool plans show ${id}`);
    expect(text()).toContain("END");
    expect(text()).toContain(`note #${id}`);
    alice.clear();
    engine.processCommand(alice.entity!, "pool plans show 999999");
    expect(text()).toContain("No note #999999");
    alice.clear();
    engine.processCommand(alice.entity!, "pool plans show x");
    expect(text()).toContain("Usage: pool plans show <id>");
  });
});
