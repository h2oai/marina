// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Engine } from "../engine/engine";

export const MCP_MAX_PENDING = 256;
export const MCP_MAX_SESSION_PENDING = 16;
export const MCP_MAX_QUEUE_WAIT_MS = 30_000;

/** Bound admitted work, including active handlers. A cancelled active write keeps
 * its slot until completion; admission never races a mutation against a timeout. */
export class McpAdmission {
  private sessions = new WeakMap<object, number>();
  private pending = 0;
  private highWater = 0;
  private rejected = 0;
  private expired = 0;

  constructor(
    readonly limit = MCP_MAX_PENDING,
    readonly sessionLimit = MCP_MAX_SESSION_PENDING,
    readonly maxWaitMs = MCP_MAX_QUEUE_WAIT_MS,
  ) {}

  enter(session: object) {
    const count = this.sessions.get(session) ?? 0;
    if (this.pending >= this.limit || count >= this.sessionLimit) {
      this.rejected++;
      return undefined;
    }
    this.pending++;
    this.highWater = Math.max(this.highWater, this.pending);
    this.sessions.set(session, count + 1);
    const started = performance.now();
    let released = false;
    return {
      canStart: () => {
        if (performance.now() - started <= this.maxWaitMs) return true;
        this.expired++;
        return false;
      },
      release: () => {
        if (released) return;
        released = true;
        this.pending--;
        this.sessions.set(session, (this.sessions.get(session) ?? 1) - 1);
      },
    };
  }

  snapshot() {
    return {
      pending: this.pending,
      highWater: this.highWater,
      rejected: this.rejected,
      expired: this.expired,
      limit: this.limit,
      sessionLimit: this.sessionLimit,
      maxQueueWaitMs: this.maxWaitMs,
    };
  }
}

const admissions = new WeakMap<Engine, McpAdmission>();
export function mcpAdmission(engine: Engine): McpAdmission {
  let admission = admissions.get(engine);
  if (!admission) {
    admission = new McpAdmission();
    admissions.set(engine, admission);
  }
  return admission;
}
