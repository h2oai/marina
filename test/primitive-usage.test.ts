// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { classifyPrimitive } from "../src/telemetry/primitive-usage";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const DB_PATH = "/tmp/marina-primitive-usage.test.db";

describe("primitive usage evidence", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(DB_PATH);
    db = new MarinaDB(DB_PATH);
  });

  afterEach(() => {
    db.close();
    cleanupDb(DB_PATH);
  });

  test("classifies useful activity without retaining command content", () => {
    expect(classifyPrimitive("recall confidential launch phrase")).toMatchObject({
      meaningful: false,
      safeLabel: "recall",
    });
    expect(classifyPrimitive("note confidential launch phrase")).toMatchObject({
      meaningful: true,
      primitive: "memory",
      safeLabel: "note",
    });
    expect(classifyPrimitive("note list")).toMatchObject({
      meaningful: false,
      safeLabel: "note list",
    });
    expect(classifyPrimitive("code const privateToken = value")).toMatchObject({
      meaningful: true,
      safeLabel: "code",
    });
    expect(classifyPrimitive("task confidential-project-name")).toMatchObject({
      safeLabel: "task",
    });
    expect(classifyPrimitive("tell Ada confidential launch phrase")).toMatchObject({
      meaningful: true,
      communication: true,
      safeLabel: "tell",
    });
    expect(classifyPrimitive("web search current research")).toMatchObject({
      meaningful: true,
      worldAction: false,
      safeLabel: "web search",
    });
    expect(classifyPrimitive("l", "look")).toMatchObject({
      meaningful: false,
      primitive: "awareness",
      safeLabel: "look",
    });
  });

  test("uses one evidence model for agents and humans while tool calls remain provenance", () => {
    const at = Date.now() - 1_000;
    for (const actor of [
      { id: "agent-ada", name: "Ada", kind: "agent" },
      { id: "human-lin", name: "Lin", kind: "player" },
    ]) {
      const classified = classifyPrimitive("note result");
      db.recordPrimitiveUsage({
        actorId: actor.id,
        actorName: actor.name,
        actorKind: actor.kind,
        source: "command",
        ...classified,
        success: true,
        promptVersion: "prompt-a",
        createdAt: at,
      });
    }
    db.recordPrimitiveUsage({
      actorName: "Ada",
      actorKind: "agent",
      source: "agent_tool",
      primitive: "reasoning",
      action: "think",
      safeLabel: "think",
      toolName: "think",
      createdAt: at,
    });
    db.recordPrimitiveUsage({
      actorName: "Ada",
      actorKind: "agent",
      source: "agent_tool",
      primitive: "marina",
      action: "marina_memory",
      safeLabel: "marina_memory",
      toolName: "marina_memory",
      riskClass: "consequential",
      trustSources: ["memory", "world_event"],
      createdAt: at,
    });
    db.finishAgentToolUsage("Ada", "marina_memory", true, at + 25);

    const world = db.getPrimitiveUsageSummary();
    expect(world.meaningfulActions).toBe(2);
    expect(world.activeParticipants).toBe(2);
    expect(world.activeAgents).toBe(1);
    expect(world.promptVersions).toEqual(["prompt-a"]);
    expect(db.getPrimitiveUsageSummary("Ada").meaningfulActions).toBe(1);
    expect(db.getPrimitiveUsageSummary("Lin").meaningfulActions).toBe(1);
    expect(db.getPrimitiveUsageSummary("Ada")).toMatchObject({
      toolCalls: 2,
      marinaToolCalls: 1,
      reasoningOnlyCalls: 1,
      consequentialToolCalls: 1,
      untrustedToolCalls: 1,
    });
  });

  test("correlates meaningful action volume with terminal outcomes", () => {
    const startedAt = Date.now() - 5_000;
    db.startProductivitySession("agent-ada", "Ada", 42, startedAt, 0, "prompt-a", 100, 20, 0.01);
    for (const offset of [1_000, 2_000]) {
      db.recordPrimitiveUsage({
        actorName: "Ada",
        actorKind: "agent",
        source: "command",
        ...classifyPrimitive("task submit 42"),
        success: true,
        promptVersion: "prompt-a",
        createdAt: startedAt + offset,
      });
    }
    expect(
      db.finishProductivitySession(
        "agent-ada",
        "Ada",
        42,
        "approved",
        startedAt + 3_000,
        0,
        150,
        35,
        0.025,
      ),
    ).toBe(true);
    expect(db.getPrimitiveUsageSummary("Ada")).toMatchObject({
      outcomeSessions: 1,
      approvedMeaningfulAverage: 2,
      failedMeaningfulAverage: 0,
    });
    const [promptOutcome] = db.getPromptOutcomeSummaries();
    expect(promptOutcome).toMatchObject({
      promptVersion: "prompt-a",
      outcomes: 1,
      successes: 1,
      meaningfulActions: 2,
      averageInputTokens: 50,
      averageOutputTokens: 15,
    });
    expect(promptOutcome?.averageCostUsd).toBeCloseTo(0.015);
  });

  test("records agent commands on the canonical engine path and tools only as provenance", async () => {
    const engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    const connection = new MockConnection("agent-connection");
    engine.addConnection(connection);
    const entity = engine.spawnEntity(connection.id, "Ada")!;
    entity.kind = "agent";

    await engine.processCommand(entity.id, "note private result text");
    engine.logEvent({
      type: "agent_tool_call",
      name: "Ada",
      toolName: "marina_memory",
      timestamp: Date.now(),
    });
    engine.logEvent({
      type: "agent_tool_result",
      name: "Ada",
      toolName: "marina_memory",
      isError: false,
      timestamp: Date.now() + 10,
    });

    expect(db.getPrimitiveUsageSummary("Ada")).toMatchObject({
      commands: 1,
      meaningfulActions: 1,
      activeAgents: 1,
      toolCalls: 1,
      marinaToolCalls: 1,
    });
  });
});
