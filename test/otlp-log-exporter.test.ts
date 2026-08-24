// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  loadOtlpLogExporterConfig,
  logsToOtlpJson,
  MarinaOtlpLogExporter,
} from "../src/telemetry/otlp-log-exporter";

const entry = {
  timestamp: 1_700_000_000_000,
  level: "error" as const,
  category: "model-request",
  message: "failed safely",
  traceId: "trace-visible",
  spanId: "span-visible",
  requestId: "request-visible",
  data: { errorKind: "timeout" },
};

describe("OTLP log export", () => {
  it("is independently opt-in and honors standard signal configuration", () => {
    expect(
      loadOtlpLogExporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }),
    ).toBeUndefined();
    expect(
      loadOtlpLogExporterConfig({
        MARINA_OTLP_LOGS_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/base/",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer%20token",
        OTEL_SERVICE_NAME: "marina-test",
      }),
    ).toMatchObject({
      endpoint: "http://localhost:4318/base/v1/logs",
      headers: { authorization: "Bearer token" },
      serviceName: "marina-test",
    });
  });

  it("produces OTLP JSON with severity, resource, body, and correlation", () => {
    const json = logsToOtlpJson([entry], { serviceName: "marina-test", resourceAttributes: {} });
    const serialized = JSON.stringify(json);
    expect(serialized).toContain("marina-test");
    expect(serialized).toContain("failed safely");
    expect(serialized).toContain("ERROR");
    expect(serialized).toContain("marina.request.id");
    expect(serialized).toContain("trace-visible");
  });

  it("never exposes collector query credentials in delivery status", () => {
    const exporter = new MarinaOtlpLogExporter({
      endpoint: "https://collector.example/v1/logs?api-token=secret",
      headers: { authorization: "secret" },
      timeoutMs: 1_000,
      batchDelayMs: 1_000,
      maxQueue: 10,
      serviceName: "marina-test",
      resourceAttributes: {},
    });
    expect(exporter.getStatus().endpoint).toBe("https://collector.example/v1/logs");
  });

  it("isolates collector failures, retries queued records, and reports partial success", async () => {
    let calls = 0;
    const exporter = new MarinaOtlpLogExporter(
      {
        endpoint: "https://collector.example/v1/logs",
        headers: {},
        timeoutMs: 1_000,
        batchDelayMs: 60_000,
        maxQueue: 10,
        serviceName: "marina-test",
        resourceAttributes: {},
      },
      (async () => {
        calls++;
        if (calls === 1) throw new Error("collector offline");
        return new Response(JSON.stringify({ partialSuccess: { rejectedLogRecords: 1 } }));
      }) as unknown as typeof fetch,
    );
    exporter.handleLog(entry);
    await exporter.flush();
    expect(exporter.getStatus()).toMatchObject({
      pendingLogs: 1,
      exportFailures: 1,
      consecutiveFailures: 1,
    });
    await exporter.flush();
    expect(exporter.getStatus()).toMatchObject({
      pendingLogs: 0,
      exportedLogs: 0,
      rejectedLogs: 1,
      consecutiveFailures: 0,
    });
    await exporter.stop();
  });
});
