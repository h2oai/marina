// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Engine } from "../src/engine/engine";
import type { MarinaDB } from "../src/persistence/database";
import type { RoomContext, RoomModule } from "../src/types";
import { roomId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

describe("room entry checks apply to every movement command", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let processState: DisposableStack;
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    processState = scopeProcessState({ env: { MARINA_DECISION_VERIFY: "off" } });
    fixture = createTestEngine();
    ({ db, engine } = fixture);
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", exits: { north: roomId("test/vault") } }),
    );
    engine.registerRoom(
      roomId("test/vault"),
      makeTestRoom({ short: "Vault", canEnter: () => "The vault is sealed." }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      processState.dispose();
    }
  });

  const roomOf = () => engine.entities.get(conn.entity!)?.room;

  it("move honours canEnter", async () => {
    await engine.processCommand(conn.entity!, "north");
    expect(conn.lastText()).toContain("The vault is sealed.");
    expect(roomOf()).toBe(roomId("test/start"));
  });

  it("goto <room> honours canEnter", async () => {
    await engine.processCommand(conn.entity!, "goto test/vault");
    expect(conn.lastText()).toContain("The vault is sealed.");
    expect(roomOf()).toBe(roomId("test/start"));
  });

  it("goto <entity> honours canEnter of the entity's room", async () => {
    const other = new MockConnection("c2");
    engine.addConnection(other);
    engine.spawnEntity("c2", "Bob");
    engine.entities.move(other.entity!, roomId("test/vault"));
    conn.clear();
    await engine.processCommand(conn.entity!, "goto Bob");
    expect(conn.lastText()).toContain("The vault is sealed.");
    expect(roomOf()).toBe(roomId("test/start"));
  });

  it("goto enters a room whose canEnter allows it", async () => {
    engine.registerRoom(roomId("test/open"), makeTestRoom({ short: "Open", canEnter: () => true }));
    await engine.processCommand(conn.entity!, "goto test/open");
    expect(roomOf()).toBe(roomId("test/open"));
  });

  it("a canEnter that throws refuses entry", async () => {
    engine.registerRoom(
      roomId("test/broken"),
      makeTestRoom({
        short: "Broken",
        canEnter: () => {
          throw new Error("guard failed");
        },
      }),
    );
    await engine.processCommand(conn.entity!, "goto test/broken");
    expect(stripAnsi(conn.lastText())).toContain("unavailable");
    expect(roomOf()).toBe(roomId("test/start"));
  });

  it("a disabled room's canEnter refuses entry", async () => {
    engine.registerRoom(
      roomId("test/disabled"),
      makeTestRoom({ short: "Disabled", canEnter: () => true }),
    );
    // Accumulate violations until the sandbox disables the room.
    for (let i = 0; i < 20 && !engine.sandbox.isDisabled("test/disabled"); i++) {
      engine.sandbox.execHandler("test/disabled", "onTick", () => {
        throw new Error("fail");
      });
    }
    expect(engine.sandbox.isDisabled("test/disabled")).toBe(true);
    await engine.processCommand(conn.entity!, "goto test/disabled");
    expect(stripAnsi(conn.lastText())).toContain("unavailable");
    expect(roomOf()).toBe(roomId("test/start"));
  });

  it("a room command that throws is recorded as a failure, not a success", async () => {
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Start",
        commands: {
          explode: () => {
            throw new Error("room command failed");
          },
        },
      }),
    );
    const events: string[] = [];
    engine.addEventListener((event) => {
      if (event.type === "command") events.push(event.input);
    });
    const usage: boolean[] = [];
    const record = db.recordPrimitiveUsage.bind(db);
    db.recordPrimitiveUsage = (input) => {
      usage.push(input.success === true);
      return record(input);
    };
    await engine.processCommand(conn.entity!, "explode");
    expect(stripAnsi(conn.allTextJoined())).toContain("room command failed");
    expect(events).not.toContain("explode");
    expect(usage).toEqual([false]);
  });

  it("an async room command that rejects is recorded as a failure", async () => {
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Start",
        commands: {
          fizzle: async () => {
            throw new Error("async room command failed");
          },
        },
      }),
    );
    const events: string[] = [];
    engine.addEventListener((event) => {
      if (event.type === "command") events.push(event.input);
    });
    await engine.processCommand(conn.entity!, "fizzle");
    expect(events).not.toContain("fizzle");
  });
});

describe("RoomSandbox canEnter wrapper fails closed", () => {
  it("returns a refusal when the guard throws", async () => {
    const { RoomSandbox } = await import("../src/engine/room-sandbox");
    const sandbox = new RoomSandbox();
    const mod: RoomModule = makeTestRoom({
      canEnter: () => {
        throw new Error("boom");
      },
    });
    const wrapped = sandbox.wrapModule("r", mod);
    expect(wrapped.canEnter!({} as RoomContext, "e_1" as never)).not.toBe(true);
  });
});
