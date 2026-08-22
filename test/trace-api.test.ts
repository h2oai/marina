// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_trace_api.db";

describe("Trace API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let token: string;

  beforeEach(async () => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    const loginUrl = new URL("http://localhost:3300/api/command");
    const login = await handleDashboardApi(
      new Request(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TraceReader", command: "look" }),
      }),
      loginUrl,
      "POST",
      engine,
      db,
    );
    token = ((await login!.json()) as { token: string }).token;
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("requires authentication", async () => {
    const url = new URL("http://localhost:3300/api/traces");
    const response = await handleDashboardApi(new Request(url), url, "GET", engine, db);
    expect(response?.status).toBe(401);
  });

  it("returns a bounded recent trace projection without event content", async () => {
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "received",
      requestId: "req-api",
      runId: "req-api",
      traceId: "req-api",
      spanId: "span-req-api",
      model: "marina",
      timestamp: 100,
    });
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "completed",
      requestId: "req-api",
      runId: "req-api",
      traceId: "req-api",
      spanId: "span-req-api",
      model: "marina",
      durationMs: 25,
      timestamp: 125,
    });

    const url = new URL("http://localhost:3300/api/traces?traceId=req-api&limit=1");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      retention: string;
      partial: boolean;
      analytics: {
        schema: string;
        tracesObserved: number;
        models: Array<{ name: string; eligible: number; latency: { p50Ms?: number } }>;
      };
      traces: Array<{
        traceId: string;
        status: string;
        spans: unknown[];
        evaluation: { evaluator: string; checks: Array<{ id: string; result: string }> };
      }>;
    };
    expect(body).toMatchObject({
      source: "event-log",
      retention: "operator-managed",
      partial: false,
    });
    expect(body.traces).toHaveLength(1);
    expect(body.analytics).toMatchObject({
      schema: "marina.trace.analytics.v1",
      tracesObserved: 1,
      models: [expect.objectContaining({ name: "marina", eligible: 1 })],
    });
    expect(body.traces[0]).toMatchObject({ traceId: "req-api", status: "completed" });
    expect(body.traces[0]?.evaluation).toMatchObject({
      evaluator: "marina.execution.v1",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "terminal_outcome", result: "passed" }),
      ]),
    });
    expect(JSON.stringify(body)).not.toContain("secret intermediate text");
  });

  it("returns durable participant judgments as attributed assertions", async () => {
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "received",
      requestId: "req-api",
      runId: "req-api",
      traceId: "req-api",
      spanId: "request-span",
      model: "marina",
      timestamp: 100,
    });
    db.addTraceJudgment({
      traceId: "req-api",
      evaluatorEntity: "Reviewer",
      verdict: "failed",
      criterion: "correctness",
      rationale: "Expected result did not match.",
      evidenceSpanIds: ["request-span"],
    });
    const url = new URL("http://localhost:3300/api/traces?traceId=req-api");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    const body = (await response!.json()) as {
      traces: Array<{ judgments: Array<{ evaluatorEntity: string; verdict: string }> }>;
    };
    expect(body.traces[0]?.judgments).toEqual([
      expect.objectContaining({ evaluatorEntity: "Reviewer", verdict: "failed" }),
    ]);
  });

  it("reads traces persisted outside the current in-memory event window", async () => {
    db.logEvent({
      type: "agent_turn_start",
      name: "RestartedAda",
      runId: "durable-run",
      traceId: "durable-trace",
      spanId: "durable-turn",
      timestamp: 300,
    });
    expect(engine.getEventLog().some((event) => "traceId" in event && event.traceId)).toBe(false);

    const url = new URL("http://localhost:3300/api/traces?traceId=durable-trace");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    const body = (await response!.json()) as {
      source: string;
      retention: string;
      traces: Array<{ traceId: string; status: string }>;
    };
    expect(body).toMatchObject({ source: "event-log", retention: "operator-managed" });
    expect(body.traces).toEqual([
      expect.objectContaining({ traceId: "durable-trace", status: "running" }),
    ]);
  });

  it("bounds durable event reads and reports truncation", () => {
    for (let index = 0; index < 3; index++) {
      db.logEvent({
        type: "agent_turn_start",
        name: "Ada",
        runId: `bounded-${index}`,
        traceId: `bounded-${index}`,
        spanId: `turn-${index}`,
        timestamp: 400 + index,
      });
    }
    const history = db.getRecentTraceEvents(2);
    expect(history.truncated).toBe(true);
    expect(history.events.map((event) => ("traceId" in event ? event.traceId : undefined))).toEqual(
      ["bounded-1", "bounded-2"],
    );
  });

  it("uses the documented default for omitted and invalid limits", async () => {
    for (let index = 0; index < 2; index++) {
      engine.logEvent({
        type: "agent_turn_start",
        name: "Ada",
        runId: `run-${index}`,
        traceId: `trace-${index}`,
        spanId: `turn-${index}`,
        timestamp: 100 + index,
      });
    }

    for (const suffix of ["", "?limit=invalid", "?limit=0"]) {
      const url = new URL(`http://localhost:3300/api/traces${suffix}`);
      const response = await handleDashboardApi(
        new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
        url,
        "GET",
        engine,
        db,
      );
      const body = (await response!.json()) as { traces: unknown[] };
      expect(body.traces).toHaveLength(2);
    }
  });

  it("exports completed spans as an OTLP/JSON request without changing native IDs", async () => {
    db.logEvent({
      type: "model_request_lifecycle",
      phase: "received",
      requestId: "req-otlp",
      runId: "req-otlp",
      traceId: "req-otlp",
      spanId: "span-req-otlp",
      model: "marina",
      timestamp: 500,
    });
    db.logEvent({
      type: "model_request_lifecycle",
      phase: "completed",
      requestId: "req-otlp",
      runId: "req-otlp",
      traceId: "req-otlp",
      spanId: "span-req-otlp",
      model: "marina",
      durationMs: 20,
      timestamp: 520,
    });
    const url = new URL("http://localhost:3300/api/traces?traceId=req-otlp&format=otlp-json");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    const body = (await response!.json()) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    };
    const span = body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(span)).toContain("req-otlp");
  });

  it("exports replayable structural evaluation cases without request content", async () => {
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "received",
      requestId: "req-dataset",
      runId: "req-dataset",
      traceId: "req-dataset",
      spanId: "dataset-root",
      model: "model-a",
      timestamp: 100,
    });
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "completed",
      requestId: "req-dataset",
      runId: "req-dataset",
      traceId: "req-dataset",
      spanId: "dataset-root",
      model: "model-a",
      durationMs: 10,
      timestamp: 110,
    });
    const url = new URL("http://localhost:3300/api/traces?format=eval-json");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    const body = (await response!.json()) as {
      schema: string;
      cases: Array<{ trace: { traceId: string }; evaluation: { evaluator: string } }>;
    };
    expect(body).toMatchObject({ schema: "marina.trace.dataset.v1" });
    expect(body.cases[0]).toMatchObject({
      trace: { traceId: "req-dataset" },
      evaluation: { evaluator: "marina.execution.v1" },
    });
    expect(JSON.stringify(body)).not.toContain("content");
  });

  it("rejects unknown export formats", async () => {
    const url = new URL("http://localhost:3300/api/traces?format=vendor-magic");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    expect(response?.status).toBe(400);
  });
});
