// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaClient } from "../src/sdk/client";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

test("native cognition and world tools remain functional while a coding session is active", async () => {
  using _state = scopeProcessState({
    trustProfile: "shared",
    env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
  });
  const world = createTestEngine();
  const server = new WebSocketServer(world.engine, 0);
  server.setDb(world.db);
  server.start();
  const native = new MarinaClient(`ws://localhost:${server.getPort()}`, {
    autoReconnect: false,
    pingInterval: 0,
    commandGrammar: "world",
    commandTimeout: 1000,
  });
  const human = new MarinaClient(`ws://localhost:${server.getPort()}`, {
    autoReconnect: false,
    pingInterval: 0,
    commandTimeout: 1000,
  });
  try {
    const session = await native.connect("NativeCoder");
    const observer = world.login("Observer");
    await human.connect("HumanCoder");
    const entity = world.engine.entities.get(session.entityId as EntityId)!;
    entity.properties.active_modal = "code";
    const memory = new PlatformMemoryBackend(native);
    const focus = { description: "Finish the code task", startedAt: 123 };
    expect((await memory.saveFocus(focus)).success).toBe(true);
    expect(await memory.getFocus()).toEqual(focus);
    expect((await memory.saveCheckpoint({ stage: "coding" })).success).toBe(true);
    expect(await memory.getCheckpoint()).toMatchObject({ stage: "coding" });
    await native.command("tell Observer the coding task is still active");
    expect(observer.connection.allText().join("\n")).toContain("the coding task is still active");
    expect((await native.command("look")).map((p) => p.data.text).join("\n")).toContain(
      "Test Room",
    );
    expect(entity.properties.active_modal).toBe("code");
    // Explicit world grammar only chooses the command parser. Gates still apply.
    const refused = await native.command("gate grant NativeCoder code.exec");
    expect(refused.map((p) => p.data.text).join("\n")).toMatch(
      /rank|admin|permission|gate|capability/i,
    );
    const humanId = human.getSession()!.entityId as EntityId;
    world.engine.entities.get(humanId)!.properties.active_modal = "code";
    const reply = await human.memoryService({ operation: "checkpoint", id: "resident" }, 1000);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("checkpoint_not_found");
  } finally {
    native.disconnect();
    human.disconnect();
    await server.stop();
    await world.dispose();
  }
});
