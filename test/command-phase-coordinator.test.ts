// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { CommandPhaseCoordinator } from "../src/engine/command-phase-coordinator";
import { CommandRouter } from "../src/engine/command-router";
import { Logger } from "../src/engine/logger";
import type { EngineEvent, RoomContext } from "../src/types";
import { roomId } from "../src/types";
import { EntityManager } from "../src/world/entity-manager";

test("execution routes modals through the same permissions and awaits async handlers without Engine", async () => {
  const entities = new EntityManager();
  const entity = entities.create({
    kind: "agent",
    name: "Alice",
    short: "Alice",
    long: "Alice",
    room: roomId("test/start"),
    properties: { active_modal: "code", rank: 0 },
  });
  const commands = new CommandRouter();
  const messages: string[] = [];
  const events: EngineEvent[] = [];
  const calls: string[] = [];
  let complete!: () => void;
  const barrier = new Promise<void>((resolve) => {
    complete = resolve;
  });
  commands.registerBuiltin({
    name: "code",
    help: "Code",
    minRank: 3,
    handler: (_, input) => {
      calls.push(input.raw);
    },
  });
  commands.registerBuiltin({
    name: "look",
    help: "Look",
    handler: async () => {
      await barrier;
      calls.push("look");
    },
  });
  const phase = new CommandPhaseCoordinator({
    entities,
    commands,
    rooms: { get: () => undefined },
    logger: new Logger(),
    promptVersion: () => undefined,
    sendToEntity: (_, message) => messages.push(message),
    processCommand: async () => {},
    buildCommandContext: () => undefined,
    buildContext: () => ({}) as RoomContext,
    logEvent: (event) => events.push(event),
  });
  await phase.execute(entity.id, "change a file");
  expect(messages.join()).toContain("rank 3");
  expect(calls).toEqual([]);
  entity.properties.rank = 3;
  await phase.execute(entity.id, "help");
  expect(calls).toEqual(["code help"]);
  const waiting = phase.execute(entity.id, "/look");
  expect(calls).not.toContain("look");
  complete();
  await waiting;
  await phase.execute(entity.id, "look", { bypassModal: true });
  expect(calls).toEqual(["code help", "look", "look"]);
  expect(events.filter((event) => event.type === "command")).toHaveLength(3);
  entity.properties.active_modal = undefined;
  await phase.execute(entity.id, "/look");
  expect(calls).toEqual(["code help", "look", "look", "look"]);
  entity.properties.rank = 0;
  await phase.execute(entity.id, "/code run forbidden");
  expect(messages.at(-1)).toContain("rank 3");
  expect(calls).toHaveLength(4);
});
