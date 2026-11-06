// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Room-based context is for agents doing spatial work. An agent is reached by
 * what it owes and is given; who shares its room, and "explore" or "you are
 * not alone" suggestions, matter only when it is moving, building or looking.
 */

import { describe, expect, it } from "bun:test";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { listWorkItems } from "../src/coordination/work-loop";
import type { Entity, EntityId, RoomId } from "../src/types";

type Internals = {
  buildContinuationPrompt(): Promise<string>;
  loopIterationCount: number;
  socialAwareness: { getSocialContext: () => string };
  actionHistory: { addAction: (a: Record<string, unknown>) => void };
};

function adapterAtCycle5(name: string): Internals {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const i = adapter as unknown as Internals;
  i.loopIterationCount = 4; // next build is cycle 5
  i.socialAwareness.getSocialContext = () => "Entities in room: Ann, Bo";
  return i;
}

describe("room-based prompt context", () => {
  it("an agent that has not moved, built or looked gets no [Nearby]", async () => {
    const i = adapterAtCycle5("not-spatial");
    expect(await i.buildContinuationPrompt()).not.toContain("[Nearby]");
  });

  it("an agent that looked around in the last hour gets [Nearby]", async () => {
    const i = adapterAtCycle5("spatial");
    i.actionHistory.addAction({
      timestamp: Date.now(),
      type: "tool_call",
      toolName: "marina_command",
      args: { command: "look" },
    });
    expect(await i.buildContinuationPrompt()).toContain("[Nearby]\nEntities in room: Ann, Bo");
  });
});

describe("the work list for an agent", () => {
  const me = { id: "e_me" as EntityId, name: "Me", room: "start" as RoomId, properties: {} };
  const peer = { id: "e_ann" as EntityId, name: "Ann", room: "start" as RoomId, properties: {} };
  const deps = { startRoom: "start", peers: [me, peer] as unknown as Entity[] };

  it("a person is offered exploring and the people in the room", () => {
    const kinds = listWorkItems(me as unknown as Entity, deps).map((w) => w.kind);
    expect(kinds).toContain("explore");
    expect(kinds).toContain("social");
  });

  it("an agent is not", () => {
    const kinds = listWorkItems(me as unknown as Entity, { ...deps, forAgent: true }).map(
      (w) => w.kind,
    );
    expect(kinds).not.toContain("explore");
    expect(kinds).not.toContain("social");
  });
});
