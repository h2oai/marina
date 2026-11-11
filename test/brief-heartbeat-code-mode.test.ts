// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The periodic brief is a world pulse: a person in Code Mode is in a coding
// session, so the heartbeat skips them (`brief` on request still works).

import { afterEach, expect, it } from "bun:test";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";

let world: ReturnType<typeof createTestEngine> | undefined;
afterEach(async () => {
  await world?.dispose();
  world = undefined;
});

it("the brief heartbeat skips an entity in Code Mode and reaches the others", () => {
  world = createTestEngine();
  const coder = world.login("Ada").entityId as EntityId;
  const explorer = world.login("Ben").entityId as EntityId;
  world.engine.subscribeBrief(coder, 1);
  world.engine.subscribeBrief(explorer, 1);
  world.engine.entities.get(coder)!.properties.active_modal = "code";
  const briefed: string[] = [];
  world.engine.sendBrief = (eid: EntityId) => {
    briefed.push(eid);
  };
  (world.engine as unknown as { tick(): void }).tick();
  expect(briefed).toEqual([explorer]);
});
