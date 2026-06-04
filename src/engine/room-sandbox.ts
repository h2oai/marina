import type { EntityId, RoomContext, RoomModule } from "../types";
import { getErrorMessage } from "./errors";

/**
 * Runtime sandbox for room module handlers.
 *
 * Wraps onTick, onEnter, onLeave, canEnter, long, items, and room commands with:
 * - Try/catch to prevent room errors from crashing the engine
 * - Execution time tracking per room
 * - Automatic disabling of rooms that repeatedly exceed time limits or throw errors
 *
 * Note: This does NOT provide memory-level isolation (no V8 isolates).
 * Static analysis in sandbox.ts blocks dangerous patterns at compile time.
 * This layer provides runtime fault tolerance.
 */

export interface RoomSandboxConfig {
  /** Max execution time per handler call in ms (default: 50) */
  handlerTimeoutMs: number;
  /** Max accumulated violations before a room is disabled (default: 10) */
  maxViolations: number;
  /** Violation decay interval in ticks — reduce by 1 every N ticks (default: 100) */
  violationDecayTicks: number;
}

const DEFAULT_CONFIG: RoomSandboxConfig = {
  handlerTimeoutMs: 50,
  maxViolations: 10,
  violationDecayTicks: 100,
};

interface RoomMetrics {
  violations: number;
  disabled: boolean;
  totalCalls: number;
  totalTimeMs: number;
  lastError?: string;
}

export class RoomSandbox {
  private config: RoomSandboxConfig;
  private metrics = new Map<string, RoomMetrics>();
  private tickCount = 0;

  constructor(config?: Partial<RoomSandboxConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Get or create metrics for a room */
  private getMetrics(roomId: string): RoomMetrics {
    let m = this.metrics.get(roomId);
    if (!m) {
      m = { violations: 0, disabled: false, totalCalls: 0, totalTimeMs: 0 };
      this.metrics.set(roomId, m);
    }
    return m;
  }

  /** Check if a room is disabled */
  isDisabled(roomId: string): boolean {
    return this.getMetrics(roomId).disabled;
  }

  /** Remove metrics for a room (e.g. when the room is destroyed) */
  clearMetrics(roomId: string): void {
    this.metrics.delete(roomId);
  }

  /** Manually re-enable a disabled room (for admin use) */
  enableRoom(roomId: string): void {
    const m = this.getMetrics(roomId);
    m.disabled = false;
    m.violations = 0;
  }

  /** Get metrics snapshot for all tracked rooms */
  getAllMetrics(): Record<string, RoomMetrics> {
    const result: Record<string, RoomMetrics> = {};
    for (const [id, m] of this.metrics) {
      result[id] = { ...m };
    }
    return result;
  }

  /** Called once per tick to decay violations */
  tick(): void {
    this.tickCount++;
    if (this.tickCount % this.config.violationDecayTicks === 0) {
      for (const m of this.metrics.values()) {
        if (m.violations > 0 && !m.disabled) {
          m.violations--;
        }
      }
    }
  }

  /** Execute a room handler with safety wrapping */
  execHandler(
    roomId: string,
    handlerName: string,
    fn: () => void,
    onError?: (roomId: string, error: string) => void,
  ): void {
    const m = this.getMetrics(roomId);
    if (m.disabled) return;

    m.totalCalls++;
    const start = performance.now();

    try {
      fn();
    } catch (err) {
      const msg = getErrorMessage(err);
      m.lastError = `${handlerName}: ${msg}`;
      this.recordViolation(roomId, m, `Error in ${handlerName}: ${msg}`, onError);
      return;
    }

    const elapsed = performance.now() - start;
    m.totalTimeMs += elapsed;

    if (elapsed > this.config.handlerTimeoutMs) {
      this.recordViolation(
        roomId,
        m,
        `${handlerName} took ${elapsed.toFixed(1)}ms (limit: ${this.config.handlerTimeoutMs}ms)`,
        onError,
      );
    }
  }

  private recordViolation(
    roomId: string,
    m: RoomMetrics,
    reason: string,
    onError?: (roomId: string, error: string) => void,
  ): void {
    m.violations++;
    if (m.violations >= this.config.maxViolations) {
      m.disabled = true;
      const msg = `Room "${roomId}" disabled after ${m.violations} violations. Last: ${reason}`;
      onError?.(roomId, msg);
    } else {
      onError?.(
        roomId,
        `Room "${roomId}" violation (${m.violations}/${this.config.maxViolations}): ${reason}`,
      );
    }
  }

  /**
   * Wrap a RoomModule to produce a safe proxy.
   * All handlers (onTick, onEnter, onLeave, canEnter, long, items, commands)
   * are wrapped with exec tracking.
   */
  wrapModule(
    roomId: string,
    module: RoomModule,
    onError?: (roomId: string, error: string) => void,
  ): RoomModule {
    const wrapped: RoomModule = {
      ...module,
    };

    if (module.onTick) {
      const original = module.onTick;
      wrapped.onTick = (ctx: RoomContext) => {
        this.execHandler(roomId, "onTick", () => original(ctx), onError);
      };
    }

    if (module.onEnter) {
      const original = module.onEnter;
      wrapped.onEnter = (ctx: RoomContext, entity: EntityId) => {
        this.execHandler(roomId, "onEnter", () => original(ctx, entity), onError);
      };
    }

    if (module.onLeave) {
      const original = module.onLeave;
      wrapped.onLeave = (ctx: RoomContext, entity: EntityId) => {
        this.execHandler(roomId, "onLeave", () => original(ctx, entity), onError);
      };
    }

    if (module.canEnter) {
      const original = module.canEnter;
      wrapped.canEnter = (ctx: RoomContext, entity: EntityId) => {
        let result: true | string = true;
        this.execHandler(
          roomId,
          "canEnter",
          () => {
            result = original(ctx, entity);
          },
          onError,
        );
        return result;
      };
    }

    if (typeof module.long === "function") {
      const original = module.long;
      wrapped.long = (ctx: RoomContext, viewer: EntityId) => {
        let result = "";
        this.execHandler(
          roomId,
          "long",
          () => {
            result = original(ctx, viewer);
          },
          onError,
        );
        return result;
      };
    }

    if (module.items) {
      const wrappedItems: Record<
        string,
        string | ((ctx: RoomContext, viewer: EntityId) => string)
      > = {};
      for (const [name, desc] of Object.entries(module.items)) {
        if (typeof desc === "function") {
          const original = desc;
          wrappedItems[name] = (ctx: RoomContext, viewer: EntityId) => {
            let result = "";
            this.execHandler(
              roomId,
              `item:${name}`,
              () => {
                result = original(ctx, viewer);
              },
              onError,
            );
            return result;
          };
        } else {
          wrappedItems[name] = desc;
        }
      }
      wrapped.items = wrappedItems;
    }

    if (module.commands) {
      const wrappedCommands: RoomModule["commands"] = {};
      for (const [name, handler] of Object.entries(module.commands)) {
        wrappedCommands[name] = (ctx, input) => {
          this.execHandler(roomId, `command:${name}`, () => handler(ctx, input), onError);
        };
      }
      wrapped.commands = wrappedCommands;
    }

    return wrapped;
  }
}
