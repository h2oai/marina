// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { EntityId } from "../types";
import { MAX_COMMAND_QUEUE_SIZE, MAX_COMMANDS_PER_TICK } from "./constants";

interface QueuedCommand {
  entity: EntityId;
  raw: string;
}

/** Bounded fair admission, per-entity FIFO execution and complete shutdown drain. */
export class CommandCoordinator {
  private queue: QueuedCommand[] = [];
  private chains = new Map<EntityId, Promise<void>>();
  private active = new Set<Promise<unknown>>();

  constructor(
    private readonly execute: (entity: EntityId, raw: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(entity: EntityId, raw: string): void {
    if (this.queue.length < MAX_COMMAND_QUEUE_SIZE) this.queue.push({ entity, raw });
  }
  get queuedCount(): number {
    return this.queue.length;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.then(
      () => this.active.delete(promise),
      () => this.active.delete(promise),
    );
    return promise;
  }

  private dispatch({ entity, raw }: QueuedCommand): void {
    const previous = this.chains.get(entity);
    const run = (
      previous ? previous.then(() => this.execute(entity, raw)) : this.execute(entity, raw)
    ).catch(this.onError);
    this.chains.set(entity, run);
    void run.then(() => {
      if (this.chains.get(entity) === run) this.chains.delete(entity);
    });
  }

  runPhase(budgetMs: number): void {
    const start = performance.now();
    const byEntity = new Map<EntityId, QueuedCommand[]>();
    for (const cmd of this.queue) {
      const list = byEntity.get(cmd.entity) ?? [];
      list.push(cmd);
      byEntity.set(cmd.entity, list);
    }
    // Commands admitted by a handler belong to the next phase, not this snapshot.
    this.queue = [];
    const queues = [...byEntity.values()];
    const cursors = queues.map(() => 0);
    let processed = 0;
    let more = true;
    outer: while (more && processed < MAX_COMMANDS_PER_TICK) {
      more = false;
      for (let i = 0; i < queues.length; i++) {
        const queue = queues[i]!,
          cursor = cursors[i]!;
        if (cursor >= queue.length) continue;
        if (processed > 0 && performance.now() - start >= budgetMs) break outer;
        this.dispatch(queue[cursor]!);
        cursors[i] = cursor + 1;
        processed++;
        more = true;
        if (processed >= MAX_COMMANDS_PER_TICK) break outer;
      }
    }
    const remaining = queues.flatMap((queue, i) => queue.slice(cursors[i]));
    this.queue = [...remaining, ...this.queue];
  }

  async drain(): Promise<void> {
    while (this.queue.length || this.chains.size || this.active.size) {
      this.runPhase(Number.POSITIVE_INFINITY);
      await Promise.allSettled([...this.chains.values(), ...this.active]);
    }
  }
}
