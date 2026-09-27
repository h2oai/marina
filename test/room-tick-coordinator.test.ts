// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, spyOn, test } from "bun:test";
import { Engine } from "../src/engine/engine";
import { RoomTickCoordinator } from "../src/engine/room-tick-coordinator";
import { type RoomContext, roomId } from "../src/types";

test("budget exhaustion defers remaining rooms and reports the slow handler", () => {
  let now = 0;
  const visited: string[] = [];
  const warnings: string[] = [];
  const ticks = new RoomTickCoordinator(
    () => ({}) as RoomContext,
    (message) => warnings.push(message),
    () => now,
    () => 0.999,
  );
  ticks.run(
    ["slow", "next"].map((name) => ({
      id: roomId(name),
      module: {
        onTick: () => {
          visited.push(name);
          now += 201;
        },
      },
    })),
  );
  expect(visited).toEqual(["slow"]);
  expect(warnings).toEqual([
    "Tick budget exceeded: skipped 1 room tick(s)",
    "Slow room onTick(s): slow=201ms",
  ]);
});

test("async ticks cannot overlap themselves; drain waits and contains rejected work", async () => {
  let reject!: (error: Error) => void;
  const work = new Promise<void>((_, fail) => {
    reject = fail;
  });
  let calls = 0;
  let drained = false;
  const warnings: string[] = [];
  const ticks = new RoomTickCoordinator(
    () => ({}) as RoomContext,
    (message) => warnings.push(message),
  );
  const rooms = [
    {
      id: roomId("async"),
      module: {
        onTick: () => {
          calls++;
          return work;
        },
      },
    },
  ];
  ticks.run(rooms);
  ticks.run(rooms);
  const draining = ticks.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(drained).toBe(false);
  reject(new Error("fixture asynchronous failure"));
  await draining;
  expect(warnings).toEqual(["Async room tick error in async"]);
  expect(drained).toBe(true);
});

test("Engine shutdown snapshots only after its asynchronous room work completes", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let written = false;
  const snapshots: boolean[] = [];
  const engine = new Engine({ tickInterval: 60_000 });
  const save = spyOn(engine, "saveWorldState").mockImplementation(() => {
    snapshots.push(written);
  });
  engine.registerRoom(roomId("pending"), {
    short: "pending",
    long: "pending",
    async onTick() {
      await barrier;
      written = true;
    },
  });
  try {
    engine.start();
    (engine as unknown as { tick(): void }).tick();
    const closing = engine.shutdown();
    expect(snapshots).toEqual([]);
    release();
    await closing;
    expect(snapshots).toEqual([true]);
  } finally {
    release();
    engine.stop();
    save.mockRestore();
  }
});
