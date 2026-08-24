// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { TraceView } from "../src/engine/trace-projection";
import { loadOtlpExporterConfig, MarinaOtlpExporter } from "../src/telemetry/otlp-exporter";
import type { EngineEvent } from "../src/types";

const trace: TraceView = {
  traceId: "trace-export",
  runId: "run-export",
  status: "completed",
  startedAt: 100,
  endedAt: 150,
  durationMs: 50,
  partial: false,
  spans: [
    {
      spanId: "request-export",
      kind: "model_request",
      name: "marina",
      status: "completed",
      startedAt: 100,
      endedAt: 150,
      durationMs: 50,
      partial: false,
      attributes: { model: "openai/test", detail: "must-not-export" },
    },
  ],
};

const terminalEvent: EngineEvent = {
  type: "model_request_lifecycle",
  phase: "completed",
  requestId: "trace-export",
  runId: "run-export",
  traceId: "trace-export",
  spanId: "request-export",
  model: "marina",
  timestamp: 150,
};

describe("OTLP exporter configuration", () => {
  it("is disabled unless Marina explicitly opts in", () => {
    expect(
      loadOtlpExporterConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }),
    ).toBeUndefined();
  });

  it("honors signal endpoint precedence and standard header/resource syntax", () => {
    expect(
      loadOtlpExporterConfig({
        MARINA_OTLP_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/base",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20token,x-tenant=marina",
        OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "2500",
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=production",
        OTEL_SERVICE_NAME: "marina-prod",
        MARINA_NAME: "west-1",
      }),
    ).toEqual({
      endpoint: "https://collector.example/v1/traces",
      headers: { authorization: "Bearer token", "x-tenant": "marina" },
      timeoutMs: 2_500,
      batchDelayMs: 2_000,
      serviceName: "marina-prod",
      serviceInstanceId: "west-1",
      resourceAttributes: { "deployment.environment.name": "production" },
    });
  });

  it("appends the trace path only to the shared base and rejects unsafe transport", () => {
    expect(
      loadOtlpExporterConfig({
        MARINA_OTLP_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/custom/",
      })?.endpoint,
    ).toBe("http://localhost:4318/custom/v1/traces");
    expect(() =>
      loadOtlpExporterConfig({
        MARINA_OTLP_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318",
      }),
    ).toThrow("Refusing plaintext OTLP export");
  });
});

describe("MarinaOtlpExporter", () => {
  it("exports completed spans once and reports collector partial success", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const exporter = new MarinaOtlpExporter(
      {
        endpoint: "https://collector.example/v1/traces?api-token=hidden",
        headers: { authorization: "secret" },
        timeoutMs: 1_000,
        batchDelayMs: 60_000,
        serviceName: "marina-test",
        serviceInstanceId: "test-1",
        resourceAttributes: { "deployment.environment.name": "test" },
      },
      () => [trace],
      (async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({ partialSuccess: { rejectedSpans: "1" } }), {
          status: 200,
        });
      }) as typeof fetch,
    );
    exporter.handleEvent(terminalEvent);
    await exporter.flush();
    exporter.handleEvent(terminalEvent);
    await exporter.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://collector.example/v1/traces?api-token=hidden");
    expect(requests[0]!.init?.headers).toMatchObject({ authorization: "secret" });
    const body = JSON.parse(String(requests[0]!.init?.body));
    expect(JSON.stringify(body)).toContain("marina-test");
    expect(JSON.stringify(body)).not.toContain("must-not-export");
    expect(exporter.getStatus()).toMatchObject({
      endpoint: "https://collector.example/v1/traces",
      exportedSpans: 0,
      rejectedSpans: 1,
      exportFailures: 0,
      pendingTraces: 0,
    });
    await exporter.stop();
  });

  it("keeps non-trace events out of the bounded queue", () => {
    const exporter = new MarinaOtlpExporter(
      {
        endpoint: "https://collector.example/v1/traces",
        headers: {},
        timeoutMs: 1_000,
        batchDelayMs: 60_000,
        serviceName: "marina",
        resourceAttributes: {},
      },
      () => [],
    );
    exporter.handleEvent({ type: "tick", timestamp: 1 });
    expect(exporter.getStatus().pendingTraces).toBe(0);
  });
});
