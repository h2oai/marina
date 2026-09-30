// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import type { EntityId } from "../types";
import { MAX_COMMAND_QUEUE_SIZE, MAX_COMMANDS_PER_TICK } from "./constants";

interface QueuedCommand {
  entity: EntityId;
  raw: string;
  execute?: () => Promise<void>;
}

/** One running FIFO slot; `open` flips false once its command settled. */
interface Slot {
  entity: EntityId;
  open: boolean;
  parent?: Slot;
}

/** Bounded fair admission, per-entity FIFO execution and complete shutdown drain. */
export class CommandCoordinator {
  /** Which entities' FIFO slots the current async context is running inside. */
  private readonly slots = new AsyncLocalStorage<Slot>();
  private queue: QueuedCommand[] = [];
  private chains = new Map<EntityId, Promise<void>>();
  private active = new Set<Promise<unknown>>();
  private admitted = 0;
  private rejected = 0;

  constructor(
    private readonly execute: (entity: EntityId, raw: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(entity: EntityId, raw: string): boolean {
    // Moving work into a per-entity promise chain must not bypass the bound.
    if (this.admitted >= MAX_COMMAND_QUEUE_SIZE) {
      this.rejected++;
      return false;
    }
    this.admitted++;
    this.queue.push({ entity, raw });
    return true;
  }
  /** Immediate transports use the same capacity bound and per-entity FIFO as ticks. */
  submit(entity: EntityId, raw: string, execute: () => Promise<void>): boolean {
    if (this.admitted >= MAX_COMMAND_QUEUE_SIZE) {
      this.rejected++;
      return false;
    }
    this.admitted++;
    // Flush earlier queued work for this entity before admitting the immediate command.
    const earlier = this.queue.filter((command) => command.entity === entity);
    this.queue = this.queue.filter((command) => command.entity !== entity);
    for (const command of earlier) this.dispatch(command);
    this.dispatch({ entity, raw, execute });
    return true;
  }
  snapshot() {
    return {
      pending: this.admitted,
      queued: this.queue.length,
      rejected: this.rejected,
      limit: MAX_COMMAND_QUEUE_SIZE,
    };
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

  /**
   * True while the caller runs inside an open FIFO slot of `entity` — its own
   * command, or a command it is awaiting. Work admitted from there must run
   * inline: queuing it behind the slot that is waiting for it would deadlock.
   */
  isInSlot(entity: EntityId): boolean {
    for (let slot = this.slots.getStore(); slot; slot = slot.parent) {
      if (slot.open && slot.entity === entity) return true;
    }
    return false;
  }

  private dispatch({ entity, raw, execute }: QueuedCommand): void {
    const previous = this.chains.get(entity);
    const body = execute ?? (() => this.execute(entity, raw));
    const invoke = () => {
      const slot: Slot = { entity, open: true, parent: this.slots.getStore() };
      return this.slots.run(slot, async () => {
        try {
          await body();
        } finally {
          slot.open = false;
        }
      });
    };
    const run = (previous ? previous.then(invoke) : invoke()).catch(this.onError).finally(() => {
      this.admitted--;
    });
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
