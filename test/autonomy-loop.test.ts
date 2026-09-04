// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type { AgentStatus } from "../src/agent/agent-types";
import { deriveAgentHealth, shouldKeepPerception } from "../src/agent/lean-agent-adapter";
import { scoreRecruitCandidate } from "../src/engine/commands/recruit";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_autonomy_loop.db";

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    name: "Scholar",
    entityId: "agent-1" as never,
    state: "idle",
    model: "test/model",
    role: "research evidence scholar",
    focus: null,
    goal: "research cited evidence",
    uptime: 1000,
    toolCalls: 2,
    errors: 0,
    errorReason: null,
    lastActivity: Date.now() - 60_000,
    supports: { text: true },
    contextWindow: 1000,
    effectiveContextWindow: 1000,
    maxOutputTokens: 100,
    peakInputTokens: 100,
    lastTurnMs: 10,
    avgTurnMs: 10,
    silentTurns: 0,
    ...overrides,
  };
}

describe("autonomous coordination loop", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("a");
    bob = new MockConnection("b");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("a", "Alice");
    engine.spawnEntity("b", "Bob");
    alice.clear();
    bob.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("persists correlated tells, suppresses duplicates, and acknowledges replies", () => {
    engine.processCommand(alice.entity!, "tell Bob --ttl=30s Please verify artifact #42");
    expect(stripAnsi(alice.lastText())).toContain("delivered #1");
    const receipt = db.getDirectMessage(1)!;
    expect(receipt.status).toBe("delivered");
    // TTL is computed from a separate Date.now() than created_at — allow 1-tick skew.
    expect(receipt.deadline_at! - receipt.created_at).toBeGreaterThanOrEqual(29_990);
    expect(receipt.deadline_at! - receipt.created_at).toBeLessThanOrEqual(30_010);

    engine.processCommand(alice.entity!, "tell Bob --ttl=30s Please verify artifact #42");
    expect(stripAnsi(alice.lastText())).toContain("Duplicate suppressed");
    expect(db.listDirectMessageInbox(bob.entity!)).toHaveLength(1);

    engine.processCommand(bob.entity!, "re Verified with independent evidence");
    expect(db.getDirectMessage(1)?.status).toBe("acknowledged");
    expect(db.getDirectMessage(1)?.reply_message_id).toBe(2);
  });

  it("expires unacknowledged messages at their deadline", () => {
    engine.processCommand(alice.entity!, "tell Bob --ttl=30s Time bounded request");
    const receipt = db.getDirectMessage(1)!;
    expect(db.expireDirectMessages(receipt.deadline_at! + 1)).toBe(1);
    expect(db.getDirectMessage(1)?.status).toBe("expired");
  });

  it("scores healthy, proven capability matches above degraded mismatches", () => {
    const strong = scoreRecruitCandidate(status(), "research cited evidence", 40, 3);
    const weak = scoreRecruitCandidate(
      status({
        role: "artist",
        goal: "draw images",
        state: "autonomous",
        errors: 4,
        silentTurns: 3,
      }),
      "research cited evidence",
      5,
      0,
    );
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.reasons.join(" ")).toContain("approved outcomes");
  });

  it("focused attention keeps addressed and high-priority events while filtering ambience", () => {
    expect(shouldKeepPerception("focused", 20, false)).toBe(false);
    expect(shouldKeepPerception("focused", 20, true)).toBe(true);
    expect(shouldKeepPerception("focused", 80, false)).toBe(true);
    expect(shouldKeepPerception("balanced", 20, false)).toBe(true);
  });

  it("classifies lifecycle health with actionable stuck diagnoses", () => {
    expect(
      deriveAgentHealth({
        state: "autonomous",
        silentTurns: 4,
        streaming: false,
        queued: 0,
        capacity: 20,
      }),
    ).toEqual({ healthState: "degraded", diagnosis: "4 consecutive silent turns" });
    expect(
      deriveAgentHealth({
        state: "autonomous",
        silentTurns: 0,
        streaming: true,
        queued: 2,
        capacity: 20,
      }).healthState,
    ).toBe("busy");
  });

  it("restarts or fails over an agent while preserving configuration and focus", async () => {
    const runtime = new AgentRuntime({ db, wsPort: 39999 });
    const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
    let stopped = false;
    let restoredFocus: string | undefined;
    let spawnConfig: Record<string, unknown> | undefined;
    db.saveAgentConfig({
      name: "Worker",
      model: "openai/gpt-4o-mini",
      role: "scholar",
      goal: "verify evidence",
      room: "test/start",
      spawnedBy: "Alice",
    });
    agents.set("Worker", {
      getStatus: () => status({ name: "Worker", focus: "review task #7" }),
      stop: async () => void (stopped = true),
    });
    (runtime as unknown as { spawn: (config: Record<string, unknown>) => Promise<unknown> }).spawn =
      async (config) => {
        spawnConfig = config;
        return { setFocus: (focus: string) => void (restoredFocus = focus) };
      };

    await runtime.restart("worker", { model: "openrouter/fallback-model" });
    expect(stopped).toBe(true);
    expect(spawnConfig?.role).toBe("scholar");
    expect(spawnConfig?.model).toBe("openrouter/fallback-model");
    expect(spawnConfig?.spawnedBy).toBe("Alice");
    expect(restoredFocus).toBe("review task #7");
  });

  it("proposes a verified outcome from completion evidence and independent review", () => {
    engine.processCommand(alice.entity!, "project create Verified | produce evidence-backed work");
    const project = db.getProjectByName("Verified")!;
    const task = engine.taskManager!.create({
      title: "Produce artifact",
      creatorId: alice.entity!,
      creatorName: "Alice",
      parentTaskId: project.bundle_id!,
    });
    engine.taskManager!.claim(task.id, bob.entity!, "Bob");
    engine.taskManager!.submit(task.id, bob.entity!, "Verified artifact note #42 with tests");
    engine.taskManager!.approveSubmission(task.id, bob.entity!, alice.entity!);

    engine.processCommand(alice.entity!, "project Verified verify");
    const text = stripAnsi(alice.lastText());
    expect(text).toContain("Verification Proposal");
    expect(text).toContain("Proposed outcome: 1.00");
    expect(text).toContain("Evidence-backed: 1/1");
    expect(text).toContain("Independently reviewed: 1/1");
    expect(db.getProject(project.id)?.status).toBe("active");
  });
});
