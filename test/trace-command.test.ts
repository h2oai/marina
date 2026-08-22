// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_trace_command.db";

describe("trace command", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: "test/start" as RoomId, tickInterval: 60_000 });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());
    conn = new MockConnection("trace-reader");
    engine.addConnection(conn);
    const login = engine.login(conn.id, "TraceReader");
    if ("error" in login) throw new Error(login.error);
    entityId = login.entityId;
    conn.clear();

    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "received",
      requestId: "req-command",
      runId: "req-command",
      traceId: "req-command",
      spanId: "request",
      model: "marina",
      routeStrategy: "adaptive",
      routeAdviceMode: "insufficient",
      routeReason: "insufficient advice had no eligible candidate; fell back to least-busy",
      timestamp: 100,
    });
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "completed",
      requestId: "req-command",
      runId: "req-command",
      traceId: "req-command",
      spanId: "request",
      model: "marina",
      durationMs: 25,
      timestamp: 125,
    });
  });

  afterEach(() => {
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("lists retained traces at rank zero", async () => {
    await engine.processCommand(entityId, "trace");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("Recent Traces");
    expect(output).toContain("req-command");
    expect(output).not.toContain("prompts");
  });

  it("shows causal spans without event content", async () => {
    await engine.processCommand(entityId, "trace show req-command");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("Trace: req-command");
    expect(output).toContain("model_request marina [completed]");
    expect(output).toContain("(request)");
    expect(output).toContain("strategy=adaptive · advice=insufficient");
    expect(output).toContain("fell back to least-busy");
  });

  it("shows objective checks and evidence", async () => {
    await engine.processCommand(entityId, "trace eval req-command");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("marina.execution.v1");
    expect(output).toContain("terminal_outcome: passed");
    expect(output).toContain("evidence: request");
    expect(output).toContain("tool_results: not_applicable");
  });

  it("summarizes mechanics with visible denominators and no quality claim", async () => {
    await engine.processCommand(entityId, "trace stats");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("Trace Analytics");
    expect(output).toContain("marina: n=1/1 terminal=100% success=100% p50=25ms");
    expect(output).toContain("not quality scores");
  });

  it("compares descriptive cohorts and exposes structural dataset boundaries", async () => {
    await engine.processCommand(entityId, "trace compare models");
    expect(stripAnsi(conn.lastText())).toContain("model:marina · n=1/1");
    expect(stripAnsi(conn.lastText())).toContain("does not infer a winner");
    conn.clear();

    await engine.processCommand(entityId, "trace dataset");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("marina.trace.dataset.v1 · 1 cases");
    expect(output).toContain("cannot replay private model inputs");
  });

  it("verifies the exported dataset replays without drift", async () => {
    await engine.processCommand(entityId, "trace dataset verify");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("Evaluation Dataset Replay");
    expect(output).toContain("schema: valid marina.trace.dataset.v1");
    expect(output).toContain("cases: 1 · judgments: 0");
    expect(output).toContain("replayed evaluations: 1 · drift from export: 0");
    expect(output).toContain("the export is replayable");
  });

  it("keeps model advice read-only and explicit about insufficient cohorts", async () => {
    await engine.processCommand(entityId, "trace advise models");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("mode: insufficient");
    expect(output).toContain("does not automatically apply model advice");
  });

  it("appends and reads identity-attributed advisory judgments", async () => {
    await engine.processCommand(
      entityId,
      "trace judge req-command passed correctness | Verified against the expected result",
    );
    expect(stripAnsi(conn.lastText())).toContain("advisory evidence, not an execution gate");
    conn.clear();

    await engine.processCommand(entityId, "trace judgments req-command");
    const output = stripAnsi(conn.lastText());
    expect(output).toContain("passed · correctness · by TraceReader");
    expect(output).toContain("Verified against the expected result");
    expect(output).toContain("evidence: request");
  });

  it("rejects judgments for traces outside retained history", async () => {
    await engine.processCommand(
      entityId,
      "trace judge missing passed correctness | This must not be stored",
    );
    expect(stripAnsi(conn.lastText())).toContain('Trace "missing" not found');
    expect(db.getTraceJudgments("missing")).toHaveLength(0);
  });

  it("removes terminal control sequences from durable judgment text", () => {
    const row = db.addTraceJudgment({
      traceId: "req-command",
      evaluatorEntity: "Reviewer\u001b[31m",
      verdict: "inconclusive",
      criterion: "safe\u0000text",
      rationale: "line\nreset\u001b[0m",
      evidenceSpanIds: ["request"],
    });
    expect(row.evaluatorEntity).not.toContain("\u001b");
    expect(row.criterion).toBe("safe text");
    expect([...row.rationale].every((character) => character.charCodeAt(0) >= 32)).toBe(true);
  });

  it("reports missing retained traces precisely", async () => {
    await engine.processCommand(entityId, "trace show missing");
    expect(stripAnsi(conn.lastText())).toContain('Trace "missing" not found in retained history.');
  });
});
