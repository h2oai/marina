// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { createTestEngine } from "./engine-fixture";

test("simultaneous in-memory engines isolate identities, commands, records and teardown", async () => {
  const worlds = [createTestEngine(), createTestEngine()];
  try {
    await Promise.all(
      worlds.map(async (world, index) => {
        const resident = world.login("Ada");
        world.engine.commands.registerOwned("fixture", {
          name: "privatefixture",
          help: "Fixture",
          handler(ctx, input) {
            ctx.send(input.entity, `world-${index}`);
          },
        });
        world.db.createNote("Ada", `private world ${index}`);
        await world.engine.processCommand(resident.entityId, "privatefixture");
        expect(resident.connection.lastText()).toBe(`world-${index}`);
        expect(world.db.getNotesByEntity("Ada").map((note) => note.content)).toEqual([
          `private world ${index}`,
        ]);
        // Uses the reader handle, which must see this same in-memory database.
        expect(world.db.tableExists("users")).toBe(true);
      }),
    );
    worlds[0]!.engine.commands.removeOwner("fixture");
    await worlds[0]!.dispose();
    expect(worlds[1]!.engine.commands.getDef("privatefixture")).toBeDefined();
    expect(worlds[1]!.db.getNotesByEntity("Ada")[0]?.content).toBe("private world 1");
  } finally {
    await Promise.all(worlds.map((world) => world.dispose()));
  }
});

test("one engine can execute and shut down while another has an unfinished command", async () => {
  const first = createTestEngine();
  const second = createTestEngine();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pending: Promise<void> | undefined;
  try {
    const ada = first.login("Ada");
    const otherAda = second.login("Ada");
    first.engine.commands.registerOwned("fixture", {
      name: "overlap",
      help: "Fixture barrier",
      async handler(ctx, input) {
        entered.resolve();
        await release.promise;
        ctx.send(input.entity, "first completed");
      },
    });
    second.engine.commands.registerOwned("fixture", {
      name: "overlap",
      help: "Fixture immediate command",
      handler(ctx, input) {
        ctx.send(input.entity, "second completed");
      },
    });
    pending = first.engine.processCommand(ada.entityId, "overlap");
    await entered.promise;
    await second.engine.processCommand(otherAda.entityId, "overlap");
    expect(otherAda.connection.lastText()).toBe("second completed");
    // Neither draining nor shutting down this engine waits for the other engine.
    await second.dispose();
    expect(ada.connection.lastText()).not.toBe("first completed");
    release.resolve();
    await pending;
    expect(ada.connection.lastText()).toBe("first completed");
    await first.engine.processCommand(ada.entityId, "look");
    expect(ada.connection.lastText()).toContain("Test Room");
  } finally {
    release.resolve();
    await pending;
    await Promise.all([first.dispose(), second.dispose()]);
  }
});
