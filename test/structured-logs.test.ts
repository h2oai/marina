// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { EventLog } from "../src/engine/event-log";
import { Logger, redactLogData } from "../src/engine/logger";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_structured_logs.db";

afterEach(() => cleanupDb(TEST_DB));

describe("structured logs", () => {
  it("redacts nested credentials and preserves correlation context in durable queries", () => {
    const db = new MarinaDB(TEST_DB);
    try {
      const logger = new Logger({ level: "debug" });
      logger.addSink((entry) => db.appendStructuredLog(entry));
      logger.withContext({ traceId: "trace-1", spanId: "span-1", requestId: "request-1" }, () =>
        logger.warn("provider", "request failed", {
          apiKey: "must-not-survive",
          sessionToken: "also-secret",
          inputTokens: 42,
          nested: { authorization: "Bearer secret", safe: "visible" },
        }),
      );

      const page = db.queryStructuredLogs({ traceId: "trace-1" });
      expect(page.logs).toHaveLength(1);
      expect(page.logs[0]).toMatchObject({
        level: "warn",
        category: "provider",
        traceId: "trace-1",
        spanId: "span-1",
        requestId: "request-1",
        data: {
          apiKey: "[REDACTED]",
          sessionToken: "[REDACTED]",
          inputTokens: 42,
          nested: { authorization: "[REDACTED]", safe: "visible" },
        },
      });
      expect(JSON.stringify(page.logs)).not.toContain("must-not-survive");
      expect(JSON.stringify(page.logs)).not.toContain("Bearer secret");
    } finally {
      db.close();
    }
  });

  it("filters, paginates stably, and prunes to a bounded tail", () => {
    const db = new MarinaDB(TEST_DB);
    try {
      for (let index = 0; index < 5; index++) {
        db.appendStructuredLog({
          timestamp: 100 + index,
          level: index % 2 ? "error" : "info",
          category: index < 3 ? "alpha" : "beta",
          message: `message ${index}`,
        });
      }
      const first = db.queryStructuredLogs({ limit: 2 });
      expect(first.logs.map((entry) => entry.message)).toEqual(["message 4", "message 3"]);
      expect(first.hasMore).toBe(true);
      const second = db.queryStructuredLogs({ limit: 2, beforeId: first.logs[1]!.id });
      expect(second.logs.map((entry) => entry.message)).toEqual(["message 2", "message 1"]);
      expect(db.queryStructuredLogs({ level: "error" }).logs).toHaveLength(2);
      expect(db.queryStructuredLogs({ category: "beta", q: "message" }).logs).toHaveLength(2);
      expect(db.pruneStructuredLogs(2)).toBe(3);
      expect(db.queryStructuredLogs().logs).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("makes circular and Error metadata JSON-safe", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactLogData({ circular, error: new Error("safe failure") })).toEqual({
      circular: { self: "[CIRCULAR]" },
      error: { name: "Error", message: "safe failure" },
    });
  });

  it("automatically correlates terminal model and failed tool lifecycle logs", () => {
    const db = new MarinaDB(TEST_DB);
    try {
      const logger = new Logger();
      logger.addSink((entry) => db.appendStructuredLog(entry));
      const events = new EventLog(logger, db);
      events.log({
        type: "model_request_lifecycle",
        phase: "failed",
        requestId: "request-auto",
        traceId: "trace-auto",
        spanId: "span-auto",
        model: "local/test",
        errorKind: "timeout",
        timestamp: 100,
      });
      events.log({
        type: "agent_tool_result",
        name: "Ada",
        toolName: "search",
        traceId: "trace-auto",
        spanId: "tool-auto",
        isError: true,
        timestamp: 101,
      });
      expect(db.queryStructuredLogs({ traceId: "trace-auto" }).logs).toEqual([
        expect.objectContaining({ category: "agent-tool", spanId: "tool-auto" }),
        expect.objectContaining({
          category: "model-request",
          requestId: "request-auto",
          spanId: "span-auto",
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
