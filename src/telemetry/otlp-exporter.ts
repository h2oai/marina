// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { tracesToOtlpJson } from "../engine/otlp-trace-export";
import type { TraceView } from "../engine/trace-projection";
import type { EngineEvent } from "../types";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_DELAY_MS = 2_000;
const MAX_PENDING_TRACES = 1_000;
const MAX_EXPORTED_SPANS = 50_000;
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

export interface OtlpExporterConfig {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
  batchDelayMs: number;
  serviceName: string;
  serviceInstanceId?: string;
  resourceAttributes: Record<string, string>;
}

export interface OtlpExporterStatus {
  enabled: boolean;
  endpoint?: string;
  protocol?: "http/json";
  pendingTraces: number;
  exportedSpans: number;
  rejectedSpans: number;
  droppedTraces: number;
  exportFailures: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export function loadOtlpExporterConfig(
  env: Record<string, string | undefined> = process.env,
): OtlpExporterConfig | undefined {
  if (env.MARINA_OTLP_ENABLED !== "true") return undefined;
  const protocol =
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/json";
  if (protocol !== "http/json") {
    throw new Error(`Marina OTLP push supports protocol "http/json", received "${protocol}".`);
  }
  const signalEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!signalEndpoint && !baseEndpoint) {
    throw new Error(
      "MARINA_OTLP_ENABLED=true requires OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT.",
    );
  }
  const endpoint = signalEndpoint
    ? validateEndpoint(signalEndpoint, env.MARINA_OTLP_ALLOW_INSECURE === "true")
    : validateEndpoint(appendTracePath(baseEndpoint!), env.MARINA_OTLP_ALLOW_INSECURE === "true");
  return {
    endpoint,
    headers: parseHeaders(
      env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? "",
    ),
    timeoutMs: parseOtlpTimeoutMs(
      env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT,
      DEFAULT_TIMEOUT_MS,
    ),
    batchDelayMs: parsePositiveInteger(env.MARINA_OTLP_BATCH_DELAY_MS, DEFAULT_BATCH_DELAY_MS),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "marina",
    serviceInstanceId: env.MARINA_NAME?.trim() || undefined,
    resourceAttributes: parseHeaders(env.OTEL_RESOURCE_ATTRIBUTES ?? ""),
  };
}

export class MarinaOtlpExporter {
  private readonly pendingTraceIds = new Set<string>();
  private readonly exportedSpanKeys = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private stopped = false;
  private nextAllowedAt = 0;
  private readonly status: OtlpExporterStatus;

  constructor(
    private readonly config: OtlpExporterConfig,
    private readonly loadTraces: (traceIds: readonly string[]) => TraceView[],
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.status = {
      enabled: true,
      endpoint: publicEndpoint(config.endpoint),
      protocol: "http/json",
      pendingTraces: 0,
      exportedSpans: 0,
      rejectedSpans: 0,
      droppedTraces: 0,
      exportFailures: 0,
      consecutiveFailures: 0,
    };
  }

  handleEvent(event: EngineEvent): void {
    if (this.stopped || !isTraceTerminalEvent(event) || !("traceId" in event) || !event.traceId) {
      return;
    }
    if (
      this.pendingTraceIds.size >= MAX_PENDING_TRACES &&
      !this.pendingTraceIds.has(event.traceId)
    ) {
      this.status.droppedTraces++;
      return;
    }
    this.pendingTraceIds.add(event.traceId);
    this.status.pendingTraces = this.pendingTraceIds.size;
    this.scheduleFlush();
  }

  getStatus(): OtlpExporterStatus {
    return { ...this.status, pendingTraces: this.pendingTraceIds.size };
  }

  async flush(): Promise<void> {
    if (this.stopped || this.flushing || this.pendingTraceIds.size === 0) return;
    if (Date.now() < this.nextAllowedAt) {
      this.scheduleFlush(this.nextAllowedAt - Date.now());
      return;
    }
    this.flushing = true;
    const traceIds = [...this.pendingTraceIds];
    this.pendingTraceIds.clear();
    try {
      const traces = this.loadTraces(traceIds)
        .map((trace) => ({
          ...trace,
          spans: trace.spans.filter(
            (span) =>
              span.endedAt !== undefined &&
              !this.exportedSpanKeys.has(`${trace.traceId}\u0000${span.spanId}`),
          ),
        }))
        .filter((trace) => trace.spans.length > 0);
      const spanKeys = traces.flatMap((trace) =>
        trace.spans.map((span) => `${trace.traceId}\u0000${span.spanId}`),
      );
      if (spanKeys.length === 0) return;
      const result = await this.sendWithRetry(traces);
      for (const key of spanKeys) this.rememberExported(key);
      this.status.exportedSpans += Math.max(0, spanKeys.length - result.rejectedSpans);
      this.status.rejectedSpans += result.rejectedSpans;
      this.status.consecutiveFailures = 0;
      this.status.lastError = undefined;
      this.status.lastSuccessAt = Date.now();
      this.nextAllowedAt = 0;
    } catch (cause) {
      for (const traceId of traceIds) this.pendingTraceIds.add(traceId);
      this.status.exportFailures++;
      this.status.consecutiveFailures++;
      this.status.lastFailureAt = Date.now();
      this.status.lastError = safeError(cause);
      const cooldown = Math.min(60_000, 1_000 * 2 ** Math.min(this.status.consecutiveFailures, 6));
      this.nextAllowedAt = Date.now() + cooldown;
    } finally {
      this.flushing = false;
      this.status.pendingTraces = this.pendingTraceIds.size;
      if (this.pendingTraceIds.size > 0) this.scheduleFlush();
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.flush();
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleFlush(delayMs = this.config.batchDelayMs): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = undefined;
        void this.flush();
      },
      Math.max(0, delayMs),
    );
    this.flushTimer.unref?.();
  }

  private async sendWithRetry(traces: TraceView[]): Promise<{ rejectedSpans: number }> {
    const body = JSON.stringify(
      tracesToOtlpJson(traces, {
        resource: {
          serviceName: this.config.serviceName,
          serviceInstanceId: this.config.serviceInstanceId,
          attributes: this.config.resourceAttributes,
        },
      }),
    );
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetchFn(this.config.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Marina-OTLP-Exporter/1",
            ...this.config.headers,
          },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (response.ok) return { rejectedSpans: await rejectedSpanCount(response) };
        if (!RETRYABLE_STATUS.has(response.status)) {
          throw new NonRetryableExportError(`collector returned HTTP ${response.status}`);
        }
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        lastError = new Error(`collector returned transient HTTP ${response.status}`);
      } catch (cause) {
        if (cause instanceof NonRetryableExportError) throw cause;
        lastError = cause;
      }
      if (attempt < 4) {
        const backoff = Math.min(5_000, 250 * 2 ** attempt) * (0.5 + Math.random());
        await delay(retryAfterMs ?? backoff);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OTLP export failed");
  }

  private rememberExported(key: string): void {
    this.exportedSpanKeys.add(key);
    if (this.exportedSpanKeys.size <= MAX_EXPORTED_SPANS) return;
    const oldest = this.exportedSpanKeys.values().next().value;
    if (oldest) this.exportedSpanKeys.delete(oldest);
  }
}

class NonRetryableExportError extends Error {}

function isTraceTerminalEvent(event: EngineEvent): boolean {
  return (
    event.type === "agent_turn_end" ||
    event.type === "agent_tool_result" ||
    (event.type === "model_request_lifecycle" &&
      (event.phase === "completed" || event.phase === "failed"))
  );
}

function appendTracePath(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/traces`;
}

function validateEndpoint(endpoint: string, allowInsecure: boolean): string {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OTLP endpoint must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("OTLP endpoint credentials must use OTEL exporter headers, not URL userinfo.");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:" && !loopback && !allowInsecure) {
    throw new Error(
      "Refusing plaintext OTLP export to a non-loopback collector. Use https or set MARINA_OTLP_ALLOW_INSECURE=true.",
    );
  }
  return url.toString();
}

function publicEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const item of raw.split(",")) {
    if (!item.trim()) continue;
    const separator = item.indexOf("=");
    if (separator <= 0)
      throw new Error("OTLP headers/resource attributes must use key=value pairs.");
    const key = decodeURIComponent(item.slice(0, separator).trim());
    const value = decodeURIComponent(item.slice(separator + 1).trim());
    if (!/^[A-Za-z0-9_.-]+$/.test(key))
      throw new Error(`Invalid OTLP header/attribute key "${key}".`);
    headers[key] = value;
  }
  return headers;
}

/** Shared OTLP timeout grammar (`ms`/`s`), clamped to [100ms, 60s]. The log
 *  exporter used to carry an unclamped near-copy — two adjacent exporters
 *  should not disagree about whether a timeout can exceed 60s. */
export function parseOtlpTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(raw.trim());
  if (!match) throw new Error(`Invalid OTLP timeout "${raw}".`);
  const value = Number(match[1]) * (match[2] === "s" ? 1_000 : 1);
  return Math.max(100, Math.min(60_000, Math.trunc(value)));
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1_000);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(60_000, date - Date.now()));
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 60_000) : fallback;
}

async function rejectedSpanCount(response: Response): Promise<number> {
  const text = await response.text();
  if (!text || text.length > 64_000) return 0;
  try {
    const body = JSON.parse(text) as { partialSuccess?: { rejectedSpans?: string | number } };
    const rejected = Number(body.partialSuccess?.rejectedSpans ?? 0);
    return Number.isFinite(rejected) && rejected > 0 ? Math.trunc(rejected) : 0;
  } catch {
    return 0;
  }
}

function safeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/https?:\/\/[^\s]+/g, "[collector]").slice(0, 240);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
