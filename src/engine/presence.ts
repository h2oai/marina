// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Presence status for every agent, derived in memory from engine events:
 * in-process agents from their turn and lifecycle events (and `memory set
 * rest`), supervised residents from the supervisor's `agent_status` reports.
 * Nothing is persisted; the events are the record.
 *
 * `who watch <name> [idle|blocked|any] [once]` registers a watcher that gets
 * one perception per matching change, so "tell me when Ash is done" replaces
 * polling.
 */

import type { EngineEvent, EntityId } from "../types";
import { sanitizeEntityName } from "./entity-name";

export type PresenceStatus = "working" | "idle" | "blocked" | "needs_you" | "resting" | "offline";

export type WatchFilter = "idle" | "blocked" | "any";

export const WATCH_FILTERS: readonly WatchFilter[] = ["idle", "blocked", "any"];

export interface Presence {
  status: PresenceStatus;
  since: number;
  /** Supervised residents: how world messages reach them while they work. */
  steer?: "mid-turn" | "next-turn" | "none";
}

export interface PresenceWatch {
  watcher: EntityId;
  target: string;
  filter: WatchFilter;
  once: boolean;
}

export interface PresenceHost {
  /** Entity id → name (for `command` events). */
  nameOf(entity: EntityId): string | undefined;
  /** Deliver one change notice to a watcher. */
  notify(watcher: EntityId, text: string, data: Record<string, unknown>): void;
}

/** At most this many watches per watcher; the oldest is replaced. */
const MAX_WATCHES_PER_WATCHER = 20;

const SUPERVISED: Record<string, PresenceStatus> = {
  starting: "working",
  running: "working",
  idle: "idle",
  waiting: "needs_you",
  failed: "blocked",
  stopped: "offline",
  disconnected: "offline",
};

const LIFECYCLE: Record<string, PresenceStatus> = {
  starting: "working",
  connected: "idle",
  autonomous: "idle",
  idle: "idle",
  stopping: "offline",
  stopped: "offline",
  error: "blocked",
};

const key = (name: string) => sanitizeEntityName(name).toLowerCase();

/** Whether a watch filter matches a new status. */
export function watchMatches(filter: WatchFilter, status: PresenceStatus): boolean {
  if (filter === "any") return true;
  if (filter === "idle") return status === "idle" || status === "resting";
  return status === "blocked" || status === "needs_you";
}

/** The status an event moves an agent to, if any. */
export function statusFromEvent(
  event: EngineEvent,
  nameOf: (entity: EntityId) => string | undefined,
): { name: string; status: PresenceStatus; steer?: Presence["steer"] } | undefined {
  switch (event.type) {
    case "agent_status": {
      const status = SUPERVISED[event.status];
      return status ? { name: event.name, status, steer: event.steer } : undefined;
    }
    case "agent_state_change": {
      const status = LIFECYCLE[event.state];
      return status ? { name: event.name, status } : undefined;
    }
    case "agent_turn_start":
      return { name: event.name, status: "working" };
    case "agent_turn_end":
      return { name: event.name, status: "idle" };
    case "agent_stop":
      return { name: event.name, status: "offline" };
    case "command": {
      if (!/^\s*memory\s+set\s+rest\b/i.test(event.input)) return undefined;
      const name = nameOf(event.entity);
      return name ? { name, status: "resting" } : undefined;
    }
    default:
      return undefined;
  }
}

export class PresenceTracker {
  private readonly statuses = new Map<string, Presence & { name: string }>();
  private watches: PresenceWatch[] = [];

  constructor(private readonly host: PresenceHost) {}

  /** Feed one engine event. */
  observe(event: EngineEvent): void {
    const change = statusFromEvent(event, (id) => this.host.nameOf(id));
    if (!change) return;
    const id = key(change.name);
    const prior = this.statuses.get(id);
    // A resting agent stays resting through the turn that ends with the rest.
    if (prior?.status === "resting" && change.status === "idle") return;
    if (prior?.status === change.status && prior.steer === (change.steer ?? prior.steer)) return;
    const at = event.timestamp ?? Date.now();
    this.statuses.set(id, {
      name: change.name,
      status: change.status,
      since: at,
      ...(change.steer ? { steer: change.steer } : prior?.steer ? { steer: prior.steer } : {}),
    });
    if (prior?.status === change.status) return;
    this.fire(change.name, prior?.status, change.status);
  }

  /** The agent's current status, if it has reported one. */
  statusOf(name: string): Presence | undefined {
    const entry = this.statuses.get(key(name));
    if (!entry) return undefined;
    const { name: _name, ...presence } = entry;
    return presence;
  }

  watch(watch: PresenceWatch): void {
    const target = key(watch.target);
    this.watches = this.watches.filter(
      (w) => !(w.watcher === watch.watcher && w.target === target),
    );
    const mine = this.watches.filter((w) => w.watcher === watch.watcher);
    if (mine.length >= MAX_WATCHES_PER_WATCHER)
      this.watches.splice(this.watches.indexOf(mine[0]!), 1);
    this.watches.push({ ...watch, target });
  }

  unwatch(watcher: EntityId, target: string): boolean {
    const before = this.watches.length;
    const id = key(target);
    this.watches = this.watches.filter((w) => !(w.watcher === watcher && w.target === id));
    return this.watches.length !== before;
  }

  watchesOf(watcher: EntityId): PresenceWatch[] {
    return this.watches.filter((w) => w.watcher === watcher);
  }

  /** Drop a departed watcher's watches. */
  forget(watcher: EntityId): void {
    this.watches = this.watches.filter((w) => w.watcher !== watcher);
  }

  private fire(name: string, from: PresenceStatus | undefined, to: PresenceStatus): void {
    const id = key(name);
    const fired: PresenceWatch[] = [];
    for (const w of this.watches) {
      if (w.target !== id || !watchMatches(w.filter, to)) continue;
      fired.push(w);
      this.host.notify(
        w.watcher,
        `[watch] ${name} is ${to.replace("_", " ")}${from ? ` (was ${from.replace("_", " ")})` : ""}.`,
        {
          watch: { name, status: to, ...(from ? { was: from } : {}) },
        },
      );
    }
    if (fired.some((w) => w.once))
      this.watches = this.watches.filter((w) => !(w.once && fired.includes(w)));
  }
}

/** `Wren [claude] · working` style suffix for rosters. */
export function presenceTag(presence: Presence | undefined): string {
  return presence ? presence.status.replace("_", " ") : "";
}
