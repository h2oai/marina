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
