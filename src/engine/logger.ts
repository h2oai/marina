// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

// ─── Structured Logger ───────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  entityId?: string;
}

export type LogContext = Pick<LogEntry, "traceId" | "spanId" | "requestId" | "entityId">;
export type LogSink = (entry: LogEntry) => void;

export interface LoggerConfig {
  level?: LogLevel;
  format?: "text" | "json";
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: number;
  private jsonFormat: boolean;
  private sinks = new Set<LogSink>();
  private context = new AsyncLocalStorage<LogContext>();

  constructor(config?: LoggerConfig) {
    const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
    const envFormat = process.env.LOG_FORMAT;
    this.minLevel = LOG_LEVELS[config?.level ?? envLevel ?? "info"];
    this.jsonFormat = (config?.format ?? envFormat) === "json";
  }

  log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const safeData = data ? redactLogData(data) : undefined;
    const stored = this.context.getStore();
    const traceId = stringField(safeData?.traceId) ?? stored?.traceId;
    const spanId = stringField(safeData?.spanId) ?? stored?.spanId;
    const requestId = stringField(safeData?.requestId) ?? stored?.requestId;
    const entityId = stringField(safeData?.entityId) ?? stored?.entityId;
    const entry: LogEntry = {
      level,
      category,
      message,
      ...(safeData ? { data: safeData } : {}),
      timestamp: Date.now(),
      ...(traceId ? { traceId } : {}),
      ...(spanId ? { spanId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(entityId ? { entityId } : {}),
    };

    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch (cause) {
        // A telemetry sink must never recurse through Logger or interrupt the
        // operation that produced the log.
        console.error(
          `[logger] sink failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    if (this.jsonFormat) {
      this.writeJson(entry);
    } else {
      this.writeText(entry);
    }
  }

  addSink(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  withContext<T>(context: LogContext, fn: () => T): T {
    return this.context.run({ ...this.context.getStore(), ...context }, fn);
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", category, message, data);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", category, message, data);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", category, message, data);
  }

  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("error", category, message, data);
  }

  private writeJson(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  private writeText(entry: LogEntry): void {
    const ts = new Date(entry.timestamp).toISOString();
    const prefix = `[${ts}] ${entry.level.toUpperCase().padEnd(5)} [${entry.category}]`;
    const msg = entry.data
      ? `${prefix} ${entry.message} ${JSON.stringify(entry.data)}`
      : `${prefix} ${entry.message}`;

    if (entry.level === "error") {
      console.error(msg);
    } else {
      console.log(msg);
    }
  }
}

const MAX_DEPTH = 6;
const MAX_STRING = 8_192;

/** Redact secret-shaped fields and make arbitrary metadata JSON-safe. */
export function redactLogData(data: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, key: string, depth: number): unknown => {
    if (isSensitiveKey(key)) return "[REDACTED]";
    if (value === undefined) return undefined;
    if (typeof value === "string") return value.slice(0, MAX_STRING);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (value instanceof Error)
      return { name: value.name, message: value.message.slice(0, MAX_STRING) };
    if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => visit(item, key, depth + 1));
    if (typeof value === "object") {
      if (seen.has(value)) return "[CIRCULAR]";
      seen.add(value);
      const result: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value).slice(0, 100)) {
        result[childKey] = visit(child, childKey, depth + 1);
      }
      return result;
    }
    return String(value).slice(0, MAX_STRING);
  };
  return visit(data, "data", 0) as Record<string, unknown>;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
  if (
    ["authorization", "cookie", "password", "passwd", "secret", "apikey", "privatekey"].some(
      (marker) => normalized.includes(marker),
    ) ||
    normalized.includes("credential")
  ) {
    return true;
  }
  // Preserve operational counters such as inputTokens/outputTokens while
  // redacting actual bearer/session/access token fields.
  return normalized === "token" || (normalized.endsWith("token") && !normalized.endsWith("tokens"));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 512) : undefined;
}
