// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomContext, RoomId, RoomModule } from "../types";
import { getErrorMessage } from "./errors";

interface TickRoom {
  id: RoomId;
  module: Pick<RoomModule, "onTick">;
}
type Warn = (message: string, fields?: Record<string, unknown>) => void;

/** The 200ms budget bounds synchronous work; asynchronous handlers are tracked
 * separately, never overlap themselves, and finish before persistence closes. */
export class RoomTickCoordinator {
  private readonly active = new Map<RoomId, Promise<void>>();

  constructor(
    private readonly context: (id: RoomId) => RoomContext | undefined,
    private readonly warn: Warn,
    private readonly now: () => number = () => performance.now(),
    private readonly random: () => number = Math.random,
  ) {}

  run(input: readonly TickRoom[]): void {
    const rooms = [...input];
    for (let i = rooms.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [rooms[i], rooms[j]] = [rooms[j]!, rooms[i]!];
    }
    const start = this.now();
    let skipped = 0;
    const slow: string[] = [];
    for (const room of rooms) {
      if (!room.module.onTick || this.active.has(room.id)) continue;
      if (this.now() - start > 200) {
        skipped++;
        continue;
      }
      const ctx = this.context(room.id);
      if (!ctx) continue;
      const roomStart = this.now();
      try {
        const result = room.module.onTick(ctx);
        if (result instanceof Promise) {
          const pending = result
            .catch((error) => {
              this.warn(`Async room tick error in ${room.id}`, { error: getErrorMessage(error) });
            })
            .finally(() => this.active.delete(room.id));
          this.active.set(room.id, pending);
        }
      } catch (error) {
        this.warn(`Room tick error in ${room.id}`, { error: getErrorMessage(error) });
      }
      const duration = this.now() - roomStart;
      if (duration > 100) slow.push(`${room.id}=${Math.round(duration)}ms`);
    }
    if (skipped) this.warn(`Tick budget exceeded: skipped ${skipped} room tick(s)`);
    if (slow.length) this.warn(`Slow room onTick(s): ${slow.join(", ")}`);
  }

  async drain(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  get pendingCount(): number {
    return this.active.size;
  }
}
