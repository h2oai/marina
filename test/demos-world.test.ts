// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { validateRoomSource } from "../src/engine/sandbox";
import { roomId } from "../src/types";
import demosWorld from "../worlds/demos";
import bridgeRoom from "../worlds/demos/bridge";
import workshopRoom, { ROOM_SOURCE } from "../worlds/demos/workshop";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

describe("demos world reports only outcomes it checked", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  afterEach(() => fixture.dispose());

  it("the room source the Maker writes passes validation", () => {
    fixture = createTestEngine();
    expect(validateRoomSource(ROOM_SOURCE)).toEqual({ valid: true, errors: [] });
  });

  it("the workshop completes only once the built room has announced itself", () => {
    fixture = createTestEngine();
    const { db, engine } = fixture;
    demosWorld.seed?.(db);
    const id = roomId("demos/workshop");
    engine.registerRoom(id, workshopRoom);
    const tick = () => engine.rooms.get(id)!.module.onTick!(engine.buildContext(id)!);
    const ctx = engine.buildContext(id)!;
    ctx.store.set("demo", { phase: "working", startedAt: Date.now(), ticksSinceStart: 0 });

    for (let i = 0; i < 60; i++) tick();
    expect(ctx.store.get<{ phase: string }>("demo")?.phase).toBe("working");

    ctx.channels!.send(
      "demos",
      "creations/first",
      "creations/first",
      "[built] creations/first is live",
    );
    tick();
    expect(ctx.store.get<{ phase: string }>("demo")?.phase).toBe("complete");
    if (workshopRoom.exits) delete workshopRoom.exits.creation;
  });

  it("the bridge completes only when a message relayed from the peer is present", async () => {
    fixture = createTestEngine();
    const { db, engine } = fixture;
    demosWorld.seed?.(db);
    const id = roomId("demos/bridge");
    engine.registerRoom(id, bridgeRoom);
    const { connection, entityId } = fixture.login("Visitor");
    engine.entities.move(entityId, id);
    const ctx = engine.buildContext(id)!;
    ctx.store.set("bridge", { step: "bridged", startedAt: Date.now(), peerPort: 3400 });

    connection.clear();
    await engine.processCommand(entityId, "ping");
    expect(stripAnsi(connection.allTextJoined())).toContain("No message from demo-peer");
    expect(ctx.store.get<{ step: string }>("bridge")?.step).toBe("bridged");

    ctx.channels!.send("demos", "gw", "Gateway", "[from demo-peer/Alice] hello");
    connection.clear();
    await engine.processCommand(entityId, "ping");
    expect(stripAnsi(connection.allTextJoined())).toContain("Federation demo complete.");
    expect(ctx.store.get<{ step: string }>("bridge")?.step).toBe("messaged");
  });
});
