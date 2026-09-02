// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { LogEntry } from "../engine/logger";
import { otlpSpanId, otlpTraceId } from "../engine/otlp-trace-export";
import { parseOtlpTimeoutMs } from "./otlp-exporter";

export interface OtlpLogExporterConfig {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
  batchDelayMs: number;
  maxQueue: number;
  serviceName: string;
  resourceAttributes: Record<string, string>;
}

export interface OtlpLogExporterStatus {
  enabled: boolean;
  endpoint?: string;
  protocol?: "http/json";
  pendingLogs: number;
  exportedLogs: number;
  rejectedLogs: number;
  droppedLogs: number;
  exportFailures: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export function loadOtlpLogExporterConfig(
  env: Record<string, string | undefined> = process.env,
): OtlpLogExporterConfig | undefined {
  if (env.MARINA_OTLP_LOGS_ENABLED !== "true") return undefined;
  const protocol =
    env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/json";
  if (protocol !== "http/json") {
    throw new Error(`Marina OTLP log push supports protocol "http/json", received "${protocol}".`);
  }
  const signal = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!signal && !base) {
    throw new Error("MARINA_OTLP_LOGS_ENABLED=true requires an OTLP logs or base endpoint.");
  }
  return {
    endpoint: validateEndpoint(
      signal ?? `${base!.replace(/\/+$/, "")}/v1/logs`,
      env.MARINA_OTLP_ALLOW_INSECURE === "true",
    ),
    headers: parsePairs(
      env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? "",
    ),
    timeoutMs: parseOtlpTimeoutMs(
      env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT,
      10_000,
    ),
    batchDelayMs: positive(env.MARINA_OTLP_LOGS_BATCH_DELAY_MS, 2_000),
    maxQueue: positive(env.MARINA_OTLP_LOGS_MAX_QUEUE, 2_000),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "marina",
    resourceAttributes: parsePairs(env.OTEL_RESOURCE_ATTRIBUTES ?? ""),
  };
}

export class MarinaOtlpLogExporter {
  private queue: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;
  private status: OtlpLogExporterStatus;

  constructor(
    private readonly config: OtlpLogExporterConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.status = {
      enabled: true,
      endpoint: publicEndpoint(config.endpoint),
      protocol: "http/json",
      pendingLogs: 0,
      exportedLogs: 0,
      rejectedLogs: 0,
      droppedLogs: 0,
      exportFailures: 0,
      consecutiveFailures: 0,
    };
  }

  handleLog = (entry: LogEntry): void => {
    if (this.stopped) return;
    if (this.queue.length >= this.config.maxQueue) {
      this.queue.shift();
      this.status.droppedLogs++;
    }
    this.queue.push(entry);
    this.status.pendingLogs = this.queue.length;
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.config.batchDelayMs);
  };

  getStatus(): OtlpLogExporterStatus {
    return { ...this.status, pendingLogs: this.queue.length };
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, 100);
    this.status.pendingLogs = this.queue.length;
    this.flushing = this.send(batch)
      .then((rejected) => {
        this.status.exportedLogs += batch.length - rejected;
        this.status.rejectedLogs += rejected;
        this.status.consecutiveFailures = 0;
        this.status.lastSuccessAt = Date.now();
        this.status.lastError = undefined;
      })
      .catch((cause) => {
        this.status.exportFailures++;
        this.status.consecutiveFailures++;
        this.status.lastFailureAt = Date.now();
        this.status.lastError = cause instanceof Error ? cause.message : String(cause);
        const room = Math.max(0, this.config.maxQueue - this.queue.length);
        if (room > 0) this.queue.unshift(...batch.slice(-room));
        this.status.droppedLogs += Math.max(0, batch.length - room);
      })
      .finally(() => {
        this.flushing = undefined;
        this.status.pendingLogs = this.queue.length;
        if (!this.stopped && this.queue.length > 0 && !this.timer) {
          this.timer = setTimeout(() => void this.flush(), this.config.batchDelayMs);
        }
      });
    return this.flushing;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  private async send(entries: LogEntry[]): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(this.config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.config.headers },
        body: JSON.stringify(logsToOtlpJson(entries, this.config)),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OTLP log collector returned HTTP ${response.status}`);
      const result = (await response.json().catch(() => ({}))) as {
        partialSuccess?: { rejectedLogRecords?: number; errorMessage?: string };
      };
      return Math.max(0, Math.trunc(result.partialSuccess?.rejectedLogRecords ?? 0));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function logsToOtlpJson(
  entries: readonly LogEntry[],
  config: Pick<OtlpLogExporterConfig, "serviceName" | "resourceAttributes">,
) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: Object.entries({
            "service.name": config.serviceName,
            ...config.resourceAttributes,
          }).map(([key, value]) => ({ key, value: { stringValue: value } })),
        },
        scopeLogs: [
          {
            scope: { name: "marina.logger", version: "1" },
            logRecords: entries.map((entry) => ({
              timeUnixNano: String(BigInt(entry.timestamp) * 1_000_000n),
              observedTimeUnixNano: String(BigInt(entry.timestamp) * 1_000_000n),
              severityNumber: { debug: 5, info: 9, warn: 13, error: 17 }[entry.level],
              severityText: entry.level.toUpperCase(),
              body: { stringValue: entry.message },
              attributes: attributes(entry),
              ...(entry.traceId ? { traceId: otlpTraceId(entry.traceId) } : {}),
              ...(entry.traceId && entry.spanId
                ? { spanId: otlpSpanId(entry.traceId, entry.spanId) }
                : {}),
            })),
          },
        ],
      },
    ],
  };
}

function attributes(entry: LogEntry) {
  const values: Record<string, unknown> = {
    "log.category": entry.category,
    ...(entry.requestId ? { "marina.request.id": entry.requestId } : {}),
    ...(entry.entityId ? { "marina.entity.id": entry.entityId } : {}),
    ...(entry.traceId ? { "marina.trace_id": entry.traceId } : {}),
    ...(entry.spanId ? { "marina.span_id": entry.spanId } : {}),
    ...(entry.data ? { "marina.log.data": JSON.stringify(entry.data) } : {}),
  };
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }));
}

function validateEndpoint(raw: string, allowInsecure: boolean): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("OTLP log endpoint must use http or https.");
  if (url.username || url.password)
    throw new Error("OTLP credentials belong in exporter headers, not URL userinfo.");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback && !allowInsecure) {
    throw new Error("Refusing plaintext OTLP log export to a non-loopback collector.");
  }
  return url.toString();
}

function publicEndpoint(raw: string): string {
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parsePairs(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  return Object.fromEntries(
    raw.split(",").map((part) => {
      const index = part.indexOf("=");
      if (index <= 0)
        throw new Error("OTLP log headers/resource attributes must use key=value pairs.");
      return [
        decodeURIComponent(part.slice(0, index).trim()),
        decodeURIComponent(part.slice(index + 1).trim()),
      ];
    }),
  );
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
