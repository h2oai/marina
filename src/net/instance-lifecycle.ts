// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What an embedder needs to manage a Marina it did not start in its own
 * process: find it (`endpoint.json`), let it go away when nobody uses it
 * (`MARINA_IDLE_SHUTDOWN`), and tie its life to a parent (`MARINA_PARENT_PID`).
 *
 * Activity is EXTERNAL use: HTTP, WebSocket and MCP requests from callers.
 * Marina's own agents calling its `/v1` with the internal token are not
 * activity, and an autonomous agent's turns never reset the idle clock (an
 * open turn only postpones the shutdown until it ends) — otherwise one
 * self-driven agent would keep an on-demand instance alive forever.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDuration } from "../engine/commands/format-duration";

/** Counts in-flight external requests and remembers when the last one ended. */
export class ActivityTracker {
  private active = 0;
  private last: number;

  constructor(private readonly now: () => number = Date.now) {
    this.last = now();
  }

  /** One external request begins; call the returned function when it ends. */
  begin(): () => void {
    this.active++;
    this.last = this.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active--;
      this.last = this.now();
    };
  }

  /** A one-shot external event (a WebSocket frame). */
  touch(): void {
    this.last = this.now();
  }

  get inFlight(): number {
    return this.active;
  }

  get lastActivityAt(): number {
    return this.last;
  }
}

/** The process-wide tracker the listeners feed. */
export const instanceActivity = new ActivityTracker();

/**
 * `MARINA_IDLE_SHUTDOWN`: a duration (`15m`, `900s`, `1h`) → ms; unset, empty
 * or `0` → 0 (never). Anything else is a configuration error.
 */
export function parseIdleShutdown(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || value === "0") return 0;
  const ms = parseDuration(value);
  if (ms === undefined || ms <= 0) {
    throw new Error(
      `MARINA_IDLE_SHUTDOWN must be a duration such as 15m, 900s or 1h, or 0 (got "${value}")`,
    );
  }
  return ms;
}

export interface IdleShutdownOptions {
  idleMs: number;
  activity?: ActivityTracker;
  /** Work that must finish first (an agent turn, tracked background work, a tick job). */
  isBusy: () => boolean;
  onIdle: () => void;
  now?: () => number;
  checkEveryMs?: number;
}

/** Fire `onIdle` once after `idleMs` with no external activity and nothing busy. Returns a stop function. */
export function startIdleShutdown(opts: IdleShutdownOptions): () => void {
  if (opts.idleMs <= 0) return () => {};
  const activity = opts.activity ?? instanceActivity;
  const now = opts.now ?? Date.now;
  const every = opts.checkEveryMs ?? Math.min(30_000, Math.max(250, Math.floor(opts.idleMs / 4)));
  let fired = false;
  const timer = setInterval(() => {
    if (fired || activity.inFlight > 0 || opts.isBusy()) return;
    if (now() - activity.lastActivityAt < opts.idleMs) return;
    fired = true;
    clearInterval(timer);
    opts.onIdle();
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** An open turn older than this no longer postpones idle shutdown (a hung or lost turn). */
export const MAX_OPEN_TURN_MS = 30 * 60_000;

/**
 * Tracks open agent turns from `agent_turn_start` / `agent_turn_end` events.
 * A turn whose end never arrives cannot hold the instance up forever: an
 * agent's turns are dropped when it stops (`agent_stop`, or an
 * `agent_state_change` to `stopped`/`error`), and any turn older than
 * `maxTurnMs` stops counting.
 */
export class OpenTurns {
  /** Start times of each agent's open turns, oldest first. */
  private open = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxTurnMs: number;

  constructor(
    private readonly activity: ActivityTracker = instanceActivity,
    opts: { now?: () => number; maxTurnMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxTurnMs = opts.maxTurnMs ?? MAX_OPEN_TURN_MS;
  }

  observe(event: { type: string; name?: string; origin?: string; state?: string }): void {
    if (!event.name) return;
    if (event.type === "agent_turn_start") {
      const starts = this.open.get(event.name) ?? [];
      starts.push(this.now());
      this.open.set(event.name, starts);
    } else if (event.type === "agent_turn_end") {
      const starts = this.open.get(event.name);
      starts?.shift();
      if (!starts?.length) this.open.delete(event.name);
      // A turn that answered a caller is that caller's activity; an autonomous
      // turn is not (see the module comment).
      if (event.origin === "request") this.activity.touch();
    } else if (
      event.type === "agent_stop" ||
      (event.type === "agent_state_change" &&
        (event.state === "stopped" || event.state === "error"))
    ) {
      // A stopped or crashed agent ends no more turns.
      this.open.delete(event.name);
    }
  }

  get count(): number {
    const cutoff = this.now() - this.maxTurnMs;
    let n = 0;
    for (const starts of this.open.values()) for (const t of starts) if (t > cutoff) n++;
    return n;
  }
}

// ─── endpoint.json ───────────────────────────────────────────────────────────

export interface EndpointInfo {
  /** HTTP base, e.g. `http://127.0.0.1:43117` (the OpenAI-compatible API is `${url}/v1`). */
  url: string;
  /** Streamable HTTP MCP endpoint, when MCP is enabled. */
  mcpUrl?: string;
  pid: number;
  /** The local profile's generated bearer; absent under shared/public (callers bring MODEL_API_KEYS). */
  apiKey?: string;
  version: string;
  world: string;
  startedAt: string;
  /** 0 = never. */
  idleShutdownMs: number;
}

/**
 * `<MARINA_DATA_DIR>/endpoint.json`, or undefined without a data directory:
 * the file is an embedding feature, so a plain run writes nothing new.
 */
export function endpointFilePath(dataDir: string | undefined): string | undefined {
  return dataDir ? join(dataDir, "endpoint.json") : undefined;
}

/** Write atomically (temp file + rename), mode 0600: it may carry the API key. */
export function writeEndpointFile(path: string, info: EndpointInfo): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Remove the file only when it still describes this process (a newer instance may own it). */
export function removeEndpointFile(path: string, pid = process.pid): void {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as Partial<EndpointInfo>;
    if (info.pid === pid) rmSync(path, { force: true });
  } catch {
    // allow-empty-catch: absent or unreadable — nothing of ours to remove.
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live instance described at `path`, or undefined (absent, unreadable, or its pid is dead). */
export function readEndpointFile(path: string): EndpointInfo | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as EndpointInfo;
    if (typeof info.url !== "string" || !isProcessAlive(info.pid)) return undefined;
    return info;
  } catch {
    return undefined;
  }
}

// ─── MARINA_PARENT_PID ───────────────────────────────────────────────────────

/** Call `onGone` once when `pid` no longer exists (an owner that died without stopping us). */
export function watchParent(
  pid: number,
  onGone: () => void,
  opts: { everyMs?: number; alive?: (pid: number) => boolean } = {},
): () => void {
  const alive = opts.alive ?? isProcessAlive;
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    onGone();
  }, opts.everyMs ?? 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** `MARINA_PARENT_PID` as a pid, or undefined when unset; anything else is a configuration error. */
export function parseParentPid(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`MARINA_PARENT_PID must be a process id (got "${value}")`);
  }
  return pid;
}
