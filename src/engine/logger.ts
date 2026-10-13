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

let warnedInvalidLevel = false;

/**
 * `LOG_LEVEL`, case-insensitive. An unknown value is `info` — never
 * `undefined`, which made every comparison false and logged everything.
 */
export function parseLogLevel(raw: string | undefined): { level: LogLevel; invalid: boolean } {
  const value = raw?.trim().toLowerCase();
  if (!value) return { level: "info", invalid: false };
  if (value in LOG_LEVELS) return { level: value as LogLevel, invalid: false };
  return { level: "info", invalid: true };
}

export class Logger {
  private minLevel: number;
  private jsonFormat: boolean;
  private sinks = new Set<LogSink>();
  private context = new AsyncLocalStorage<LogContext>();
  private repeats = new RepeatLimiter(logRepeatLimit());

  constructor(config?: LoggerConfig) {
    const envLevel = parseLogLevel(process.env.LOG_LEVEL);
    const envFormat = process.env.LOG_FORMAT;
    this.minLevel = LOG_LEVELS[config?.level ?? envLevel.level];
    this.jsonFormat = (config?.format ?? envFormat) === "json";
    if (envLevel.invalid && !config?.level && !warnedInvalidLevel) {
      warnedInvalidLevel = true;
      this.warn(
        "main",
        `LOG_LEVEL "${process.env.LOG_LEVEL}" is not debug, info, warn or error — using info`,
      );
    }
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

    // Console output (stdout → the journal) collapses repeats; sinks above
    // (the SQLite log store, OpenTelemetry) always receive every entry.
    const write = (e: LogEntry) => (this.jsonFormat ? this.writeJson(e) : this.writeText(e));
    const summary = this.repeats.admit(entry);
    if (summary) write(summary);
    if (summary !== false) write(entry);
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

/**
 * `MARINA_LOG_REPEAT_LIMIT`: console lines allowed per minute for one repeated
 * message (same level, category and message, digits ignored). Default 10;
 * `0`/`off` prints every line.
 */
export function logRepeatLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_LOG_REPEAT_LIMIT?.trim().toLowerCase();
  if (raw === "off") return 0;
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : 10;
}

/** Window over which repeats are counted. */
const REPEAT_WINDOW_MS = 60_000;
/** Distinct repeated messages tracked at once (oldest dropped beyond it). */
const REPEAT_KEYS_MAX = 2000;

/**
 * Per-message console budget. `admit` returns `false` to drop the line, an
 * entry summarising what the previous window dropped (to print first), or
 * `undefined` to print the line as is.
 */
export class RepeatLimiter {
  private windows = new Map<
    string,
    { start: number; count: number; dropped: number; sample: LogEntry }
  >();

  constructor(private limit: number) {}

  admit(entry: LogEntry): LogEntry | false | undefined {
    if (this.limit <= 0) return undefined;
    const key = `${entry.level}|${entry.category}|${entry.message.replace(/\d+/g, "#")}`;
    const now = entry.timestamp;
    const w = this.windows.get(key);
    if (!w || now - w.start >= REPEAT_WINDOW_MS) {
      const summary = w?.dropped
        ? suppressedSummary(w.sample, w.dropped, now - w.start)
        : undefined;
      this.windows.delete(key);
      if (this.windows.size >= REPEAT_KEYS_MAX) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      this.windows.set(key, { start: now, count: 1, dropped: 0, sample: entry });
      return summary;
    }
    w.count++;
    if (w.count <= this.limit) return undefined;
    w.dropped++;
    return false;
  }
}

function suppressedSummary(sample: LogEntry, dropped: number, spanMs: number): LogEntry {
  return {
    level: sample.level,
    category: sample.category,
    message: `(${dropped} more like "${sample.message.slice(0, 80)}" in the last ${Math.round(spanMs / 1000)}s, not printed; the log store has them)`,
    timestamp: Date.now(),
  };
}
