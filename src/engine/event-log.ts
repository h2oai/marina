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
    if (this.db) {
      const db = this.db;
      tryLog(this.logger, "event", "DB log failed", () => db.logEvent(event));
    }

    // Notify external listeners (copy to avoid mutation during iteration)
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      tryLog(this.logger, "event", "Listener failed", () => listener(event));
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
