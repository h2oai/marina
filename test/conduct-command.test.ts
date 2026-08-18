// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("conduct command (integration)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  const dbPath = `/tmp/marina-conduct-cmd-${Date.now()}.db`;

  const CHAIN = JSON.stringify({
    goal: "ship a feature",
    steps: [
      { id: "plan", instruction: "draft a plan", assignee: "planner", access: [] },
      { id: "build", instruction: "implement it", assignee: "builder", access: ["plan"] },
    ],
  });

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    engine.addConnection(alice);
    engine.spawnEntity("c-alice", "alice");
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function out(): string {
    return stripAnsi(alice.allTextJoined());
  }

  it("validates a well-formed Score without storing it", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, `conduct validate -- ${CHAIN}`);
    expect(out()).toContain("Valid");
    expect(out()).toContain("2 layer(s)"); // sequential chain
    // Not stored.
    alice.clear();
    await engine.processCommand(alice.entity!, "conduct list");
    expect(out()).toContain("No Scores stored");
  });

  it("reports the validation error for a cyclic Score", async () => {
    const cyclic = JSON.stringify({
      steps: [
        { id: "a", instruction: "x", assignee: "bob", access: ["b"] },
        { id: "b", instruction: "y", assignee: "carol", access: ["a"] },
      ],
    });
    alice.clear();
    await engine.processCommand(alice.entity!, `conduct validate -- ${cyclic}`);
    expect(out()).toContain("cycle");
  });

  it("creates, lists, and shows a stored Score", async () => {
    await engine.processCommand(alice.entity!, `conduct create ship -- ${CHAIN}`);
    expect(out()).toContain('Score "ship" created');

    alice.clear();
    await engine.processCommand(alice.entity!, "conduct list");
    expect(out()).toContain("ship");

    alice.clear();
    await engine.processCommand(alice.entity!, "conduct show ship");
    const shown = out();
    expect(shown).toContain("layer 1");
    expect(shown).toContain("plan [planner]");
    expect(shown).toContain("build [builder]");
  });

  it("refuses to create a duplicate name and forks instead", async () => {
    await engine.processCommand(alice.entity!, `conduct create ship -- ${CHAIN}`);
    alice.clear();
    await engine.processCommand(alice.entity!, `conduct create ship -- ${CHAIN}`);
    expect(out()).toContain("already exists");

    alice.clear();
    await engine.processCommand(alice.entity!, "conduct fork ship ship2");
    expect(out()).toContain('Forked "ship" → "ship2"');

    alice.clear();
    await engine.processCommand(alice.entity!, "conduct show ship2");
    expect(out()).toContain("plan [planner]");
  });

  it("rejects an invalid Score on create", async () => {
    const bad = JSON.stringify({ steps: [{ id: "a", instruction: "x", assignee: "" }] });
    alice.clear();
    await engine.processCommand(alice.entity!, `conduct create broken -- ${bad}`);
    expect(out()).toContain("Invalid");
  });
});
