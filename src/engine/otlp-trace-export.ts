// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TraceSpanView, TraceView } from "./trace-projection";

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}

const OTLP_SAFE_SPAN_ATTRIBUTES = new Set([
  "agent",
  "cacheReadTokens",
  "cacheWriteTokens",
  "candidateCount",
  "costUsd",
  "errorKind",
  "hadToolCalls",
  "inputTokens",
  "isError",
  "model",
  "origin",
  "outputTokens",
  "phase",
  "requestId",
  "risk",
  "routeAdviceMode",
  "routeKind",
  "routeStrategy",
  "target",
  "toolCount",
  "ttftMs",
]);

interface OtlpResourceOptions {
  serviceName?: string;
  serviceInstanceId?: string;
  attributes?: Record<string, string>;
}

/** Convert Marina's read model into an OTLP ExportTraceServiceRequest JSON body. */
export function tracesToOtlpJson(
  traces: readonly TraceView[],
  options: { truncated?: boolean; resource?: OtlpResourceOptions } = {},
): Record<string, unknown> {
  const spans = traces.flatMap((trace) =>
    trace.spans.filter((span) => span.endedAt !== undefined).map((span) => toOtlpSpan(trace, span)),
  );
  if (spans.length === 0) return { resourceSpans: [] };

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute("service.name", options.resource?.serviceName ?? "marina"),
            ...(options.resource?.serviceInstanceId
              ? [attribute("service.instance.id", options.resource.serviceInstanceId)]
              : []),
            attribute("telemetry.sdk.name", "marina-native"),
            attribute("telemetry.sdk.language", "nodejs"),
            attribute("marina.export.truncated", options.truncated ?? false),
            ...Object.entries(options.resource?.attributes ?? {}).map(([key, value]) =>
              attribute(key, value),
            ),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "h2oai.marina.trace-projection", version: "1" },
            spans,
          },
        ],
      },
    ],
  };
}

function toOtlpSpan(trace: TraceView, span: TraceSpanView): Record<string, unknown> {
  const attributes = [
    attribute("marina.trace_id", trace.traceId),
    attribute("marina.run_id", trace.runId),
    attribute("marina.span_id", span.spanId),
    attribute("marina.span.kind", span.kind),
    attribute("marina.span.name", span.name),
    attribute("marina.history.partial", span.partial),
    ...Object.entries(span.attributes)
      .filter(([key]) => OTLP_SAFE_SPAN_ATTRIBUTES.has(key))
      .map(([key, value]) => attribute(`marina.${key}`, value)),
  ];
  return {
    traceId: otlpId(`trace:${trace.traceId}`, 32),
    spanId: otlpId(`span:${trace.traceId}:${span.spanId}`, 16),
    ...(span.parentSpanId
      ? { parentSpanId: otlpId(`span:${trace.traceId}:${span.parentSpanId}`, 16) }
      : {}),
    name:
      span.kind === "model_request"
        ? "marina.model.request"
        : span.kind === "agent_turn"
          ? "marina.agent.turn"
          : `marina.tool.${span.name}`,
    kind: span.kind === "model_request" ? 2 : 1,
    startTimeUnixNano: unixNano(span.startedAt),
    endTimeUnixNano: unixNano(span.endedAt!),
    attributes,
    status: { code: span.status === "failed" ? 2 : 1 },
  };
}

function otlpId(value: string, length: 16 | 32): string {
  const id = new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, length);
  return /^0+$/.test(id) ? `${"0".repeat(length - 1)}1` : id;
}

function unixNano(timestampMs: number): string {
  return (BigInt(Math.trunc(timestampMs)) * 1_000_000n).toString();
}

function attribute(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}
