// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_trace_api.db";

describe("Trace API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let token: string;

  beforeEach(async () => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    // Mint a real session token directly — the /api/command ingress no longer
    // returns a usable token.
    const conn = new MockConnection("trace-reader");
    engine.addConnection(conn);
    const login = engine.login(conn.id, "TraceReader");
    if ("error" in login) throw new Error(`login failed: ${login.error}`);
    token = login.token;
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
      retention: "pruned-hourly (MARINA_EVENT_RETENTION rows)",
      partial: false,
      otlp: { enabled: false, exportedSpans: 0, pendingTraces: 0 },
    });
    expect(body.traces).toHaveLength(1);
    expect(body.analytics).toMatchObject({
      schema: "marina.trace.analytics.v1",
      tracesObserved: 1,
      models: [expect.objectContaining({ name: "marina", eligible: 1 })],
    });
    expect(body.traces[0]).toMatchObject({ traceId: "req-api", status: "completed" });
    expect(body.traces[0]?.evaluation).toMatchObject({
      evaluator: "marina.execution.v2",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "terminal_outcome", result: "passed" }),
      ]),
    });
    expect(JSON.stringify(body)).not.toContain("secret intermediate text");
  });

  it("makes autonomous model metrics consumable through the authenticated API", async () => {
    const trace = {
      runId: "agent-run-1",
      traceId: "agent-trace-1",
      spanId: "turn-1",
      origin: "autonomous" as const,
    };
    engine.logEvent({
      type: "agent_turn_start",
      name: "Ada",
      model: "local/qwen",
      ...trace,
      timestamp: 100,
    });
    engine.logEvent({
      type: "agent_turn_end",
      name: "Ada",
      model: "local/qwen",
      ...trace,
      hadToolCalls: false,
      toolCount: 0,
      durationMs: 40,
      ttftMs: 7,
      inputTokens: 100,
      outputTokens: 12,
      costUsd: 0,
      timestamp: 140,
    });

    const url = new URL("http://localhost:3300/api/traces?traceId=agent-trace-1");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    const body = (await response!.json()) as {
      traces: Array<{ spans: Array<{ attributes: Record<string, unknown> }> }>;
      analytics: { agentModels: Array<Record<string, unknown>> };
      shadowAdvice: {
        autonomousModels: {
          schema: string;
          dimension: string;
          mode: string;
          candidates: string[];
          reasons: string[];
          advisoryOnly: boolean;
        };
      };
    };
    expect(body.traces[0]?.spans[0]?.attributes).toMatchObject({
      origin: "autonomous",
      model: "local/qwen",
      ttftMs: 7,
      inputTokens: 100,
      outputTokens: 12,
      costUsd: 0,
    });
    expect(body.analytics.agentModels[0]).toMatchObject({
      name: "local/qwen",
      ttft: { samples: 1, p50Ms: 7 },
      tokens: { samples: 1, input: 100, output: 12 },
    });
    expect(body.shadowAdvice.autonomousModels).toEqual({
      schema: "marina.routing.shadow.v1",
      dimension: "autonomous_model",
      mode: "insufficient",
      candidates: [],
      reasons: ["Fewer than two observed cohorts."],
      advisoryOnly: true,
    });
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
    expect(body).toMatchObject({
      source: "event-log",
      retention: "pruned-hourly (MARINA_EVENT_RETENTION rows)",
    });
    expect(body.traces).toEqual([
      expect.objectContaining({ traceId: "durable-trace", status: "running" }),
    ]);
  });

  it("a user-supplied traceId cannot poison the unfiltered listing cache", async () => {
    db.logEvent({
      type: "agent_turn_start",
      name: "Ada",
      runId: "poison-run",
      traceId: "poison-trace",
      spanId: "poison-turn",
      timestamp: 400,
    });
    // A traceId of "*" matches nothing — its (empty) projection must be cached
    // under a namespaced key, never the key the unfiltered listing reads.
    const poisonUrl = new URL("http://localhost:3300/api/traces?traceId=*");
    await handleDashboardApi(
      new Request(poisonUrl, { headers: { Authorization: `Bearer ${token}` } }),
      poisonUrl,
      "GET",
      engine,
      db,
    );
    const listUrl = new URL("http://localhost:3300/api/traces");
    const response = await handleDashboardApi(
      new Request(listUrl, { headers: { Authorization: `Bearer ${token}` } }),
      listUrl,
      "GET",
      engine,
      db,
    );
    const body = (await response!.json()) as { traces: Array<{ traceId: string }> };
    expect(body.traces.some((trace) => trace.traceId === "poison-trace")).toBe(true);
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

  it("filters traces and paginates with stable opaque cursors", async () => {
    for (const [index, spec] of [
      { id: "filter-new", model: "gpt-remote", failed: false },
      { id: "filter-mid", model: "qwen-local", failed: true },
      { id: "filter-old", model: "qwen-local", failed: false },
    ].entries()) {
      const timestamp = 1_000 - index * 100;
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "received",
        requestId: spec.id,
        runId: spec.id,
        traceId: spec.id,
        spanId: `span-${spec.id}`,
        model: spec.model,
        timestamp,
      });
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: spec.failed ? "failed" : "completed",
        requestId: spec.id,
        runId: spec.id,
        traceId: spec.id,
        spanId: `span-${spec.id}`,
        model: spec.model,
        timestamp: timestamp + 10,
        durationMs: 10,
      });
    }

    const firstUrl = new URL("http://localhost:3300/api/traces?model=qwen&limit=1");
    const firstResponse = await handleDashboardApi(
      new Request(firstUrl, { headers: { Authorization: `Bearer ${token}` } }),
      firstUrl,
      "GET",
      engine,
      db,
    );
    const first = (await firstResponse!.json()) as {
      traces: Array<{ traceId: string }>;
      page: { hasMore: boolean; nextCursor: string };
    };
    expect(first.traces.map((trace) => trace.traceId)).toEqual(["filter-mid"]);
    expect(first.page.hasMore).toBe(true);

    // A newer trace does not shift the next page because the cursor is based
    // on the last observed timestamp and trace ID, not an array offset.
    engine.logEvent({
      type: "agent_turn_start",
      name: "NewAgent",
      runId: "new-run",
      traceId: "new-trace",
      spanId: "new-span",
      timestamp: 2_000,
    });
    const secondUrl = new URL(
      `http://localhost:3300/api/traces?model=qwen&limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`,
    );
    const secondResponse = await handleDashboardApi(
      new Request(secondUrl, { headers: { Authorization: `Bearer ${token}` } }),
      secondUrl,
      "GET",
      engine,
      db,
    );
    const second = (await secondResponse!.json()) as {
      traces: Array<{ traceId: string }>;
      page: { hasMore: boolean };
    };
    expect(second.traces.map((trace) => trace.traceId)).toEqual(["filter-old"]);
    expect(second.page.hasMore).toBe(false);

    const failedUrl = new URL("http://localhost:3300/api/traces?status=failed&q=filter-mid");
    const failedResponse = await handleDashboardApi(
      new Request(failedUrl, { headers: { Authorization: `Bearer ${token}` } }),
      failedUrl,
      "GET",
      engine,
      db,
    );
    const failed = (await failedResponse!.json()) as { traces: Array<{ traceId: string }> };
    expect(failed.traces.map((trace) => trace.traceId)).toEqual(["filter-mid"]);
  });

  it("validates retrieval filters and marks requested exports as downloads", async () => {
    const invalidUrl = new URL("http://localhost:3300/api/traces?status=unknown");
    const invalidResponse = await handleDashboardApi(
      new Request(invalidUrl, { headers: { Authorization: `Bearer ${token}` } }),
      invalidUrl,
      "GET",
      engine,
      db,
    );
    expect(invalidResponse?.status).toBe(400);

    const cursorUrl = new URL("http://localhost:3300/api/traces?cursor=not_valid");
    const cursorResponse = await handleDashboardApi(
      new Request(cursorUrl, { headers: { Authorization: `Bearer ${token}` } }),
      cursorUrl,
      "GET",
      engine,
      db,
    );
    expect(cursorResponse?.status).toBe(400);

    const exportUrl = new URL("http://localhost:3300/api/traces?format=eval-json&download=1");
    const exportResponse = await handleDashboardApi(
      new Request(exportUrl, { headers: { Authorization: `Bearer ${token}` } }),
      exportUrl,
      "GET",
      engine,
      db,
    );
    expect(exportResponse?.headers.get("content-disposition")).toBe(
      'attachment; filename="marina-traces-eval.json"',
    );
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
      evaluation: { evaluator: "marina.execution.v2" },
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
