// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { providerSetupHint } from "../net/model/provider-setup";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";
import { EVENT_LOG_TRIM_SIZE, MAX_EVENT_LOG } from "./constants";
import { tryLog } from "./errors";
import type { Logger } from "./logger";

/**
 * Manages the in-memory event log with optional DB persistence and external listeners.
 *
 * Extracted from Engine to reduce god-object surface area.
 * The Engine delegates all event logging through this class.
 */
/**
 * High-frequency, zero-retention-value event types that stay in memory and
 * reach listeners (dashboard, log server) but are NEVER durably persisted.
 * Streaming deltas arrive once per token chunk per agent — a synchronous
 * SQLite INSERT each would serialize thousands of writes/sec onto the tick
 * thread — and `tick` alone is 86k rows/day. Nothing reads any of these back
 * from the DB (trace projection uses turn/tool/lifecycle events only).
 */
const EPHEMERAL_EVENT_TYPES = new Set([
  "agent_text_delta",
  "agent_thinking_delta",
  "tick",
  "resource_changed",
]);

/** At most one "no model provider" warning per this interval; the rest are counted. */
export const NO_PROVIDER_NOTICE_INTERVAL_MS = 10 * 60_000;

export class EventLog {
  private events: EngineEvent[] = [];
  private listeners: Array<(event: EngineEvent) => void> = [];
  /** When the last no-provider warning was logged, and refusals since. */
  private noProviderNotice = { at: Number.NEGATIVE_INFINITY, suppressed: 0 };

  constructor(
    private readonly logger: Logger,
    private readonly db?: MarinaDB,
  ) {}

  /** Record an event, trim if over limit, persist to DB, and notify listeners. */
  log(event: EngineEvent): void {
    this.events.push(event);
    // Keep recent events in memory; persistence layer handles durable storage
    if (this.events.length > MAX_EVENT_LOG) {
      this.events = this.events.slice(-EVENT_LOG_TRIM_SIZE);
    }
    if (this.db && !EPHEMERAL_EVENT_TYPES.has(event.type)) {
      const db = this.db;
      tryLog(this.logger, "event", "DB log failed", () => db.logEvent(event));
    }
    this.logLifecycle(event);

    // Notify external listeners (copy to avoid mutation during iteration)
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      tryLog(this.logger, "event", "Listener failed", () => listener(event));
    }
  }

  private logLifecycle(event: EngineEvent): void {
    if (event.type === "model_request_lifecycle" && ["completed", "failed"].includes(event.phase)) {
      const data = {
        requestId: event.requestId,
        traceId: event.traceId,
        spanId: event.spanId,
        model: event.model,
        target: event.target,
        routeKind: event.routeKind,
        durationMs: event.durationMs,
        errorKind: event.errorKind,
      };
      if (event.phase === "failed" && event.errorKind === "unavailable" && !event.target) {
        // No upstream at all (a configuration state, not a fault): one WARN per
        // interval with the fix; real provider failures stay ERROR below.
        this.noteNoProvider(data);
        return;
      }
      if (event.phase === "failed")
        this.logger.error("model-request", "Model request failed", data);
      else this.logger.info("model-request", "Model request completed", data);
      return;
    }
    if (event.type === "agent_tool_result" && event.isError) {
      this.logger.warn("agent-tool", `Tool ${event.toolName} failed for ${event.name}`, {
        traceId: event.traceId,
        spanId: event.spanId,
        agentName: event.name,
        toolName: event.toolName,
      });
    }
  }

  private noteNoProvider(data: Record<string, unknown>, now = Date.now()): void {
    const notice = this.noProviderNotice;
    if (now - notice.at < NO_PROVIDER_NOTICE_INTERVAL_MS) {
      notice.suppressed++;
      return;
    }
    const earlier = notice.suppressed ? ` (${notice.suppressed} more since the last notice)` : "";
    this.logger.warn(
      "model-request",
      `Model request refused: no model provider${earlier}. ${providerSetupHint()}`,
      data,
    );
    this.noProviderNotice = { at: now, suppressed: 0 };
  }

  /** Get all in-memory events. */
  getAll(): EngineEvent[] {
    return this.events;
  }

  /** Register a listener for engine events. */
  addListener(listener: (event: EngineEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Remove a previously registered event listener. */
  removeListener(listener: (event: EngineEvent) => void): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }
}
