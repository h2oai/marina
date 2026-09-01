// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

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
const EPHEMERAL_EVENT_TYPES = new Set(["agent_text_delta", "agent_thinking_delta", "tick"]);

export class EventLog {
  private events: EngineEvent[] = [];
  private listeners: Array<(event: EngineEvent) => void> = [];

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
