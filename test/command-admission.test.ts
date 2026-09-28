// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { CommandCoordinator } from "../src/engine/command-coordinator";
import { MAX_COMMAND_QUEUE_SIZE } from "../src/engine/constants";
import { Engine } from "../src/engine/engine";
import { entityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

it("counts commands in promise chains against capacity and recovers after drain", async () => {
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const queue = new CommandCoordinator(
    async () => {
      await release.promise;
      calls++;
    },
    () => {},
  );
  try {
    for (let i = 0; i < MAX_COMMAND_QUEUE_SIZE; i++)
      expect(queue.enqueue(entityId("same"), "work")).toBe(true);
    queue.runPhase(Number.POSITIVE_INFINITY);
    expect(queue.enqueue(entityId("other"), "excess")).toBe(false);
    expect(queue.snapshot().pending).toBe(MAX_COMMAND_QUEUE_SIZE);
    release.resolve();
    await queue.drain();
    expect(calls).toBe(MAX_COMMAND_QUEUE_SIZE);
    expect(queue.snapshot()).toMatchObject({ pending: 0, rejected: 1 });
    expect(queue.enqueue(entityId("other"), "recovered")).toBe(true);
  } finally {
    release.resolve();
    await queue.drain();
  }
});

it("tells a connected participant when a command was not admitted", async () => {
  const engine = new Engine({ startRoom: roomId("test/admission") });
  engine.registerRoom(roomId("test/admission"), makeTestRoom());
  const conn = new MockConnection("admission");
  engine.addConnection(conn);
  const entity = engine.spawnEntity(conn.id, "Admission")!;
  engine.commands.registerBuiltin({ name: "noop", help: "Noop", handler() {} });
  try {
    for (let i = 0; i <= MAX_COMMAND_QUEUE_SIZE; i++) engine.queueCommand(entity.id, "noop");
    expect(conn.messages.at(-1)).toMatchObject({
      kind: "error",
      data: { code: "command_overloaded", executed: false },
    });
    expect(engine.commandAdmission.pending).toBe(MAX_COMMAND_QUEUE_SIZE);
  } finally {
    await engine.shutdown();
  }
});
