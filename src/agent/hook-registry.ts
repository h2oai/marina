import type { Perception } from "../types";

// ─── Hook Types ─────────────────────────────────────────────────────────────

export type HookType =
  | "beforeToolCall"
  | "afterToolCall"
  | "beforePrompt"
  | "afterPrompt"
  | "onPerception"
  | "onError";

export type BeforeToolCallHook = (toolName: string, args: Record<string, unknown>) => void;
export type AfterToolCallHook = (
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  isError: boolean,
) => void;
export type BeforePromptHook = (prompt: string) => void;
export type AfterPromptHook = () => void;
export type OnPerceptionHook = (perception: Perception) => void;
export type OnErrorHook = (error: Error, context: string) => void;

type HookFn =
  | BeforeToolCallHook
  | AfterToolCallHook
  | BeforePromptHook
  | AfterPromptHook
  | OnPerceptionHook
  | OnErrorHook;

// ─── Registry ───────────────────────────────────────────────────────────────

export class HookRegistry {
  private hooks = new Map<HookType, HookFn[]>();

  /** Register a hook. Returns an unsubscribe function. */
  register(type: HookType, fn: HookFn): () => void {
    if (!this.hooks.has(type)) {
      this.hooks.set(type, []);
    }
    this.hooks.get(type)!.push(fn);
    return () => {
      const arr = this.hooks.get(type);
      if (arr) {
        const idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  runBeforeToolCall(toolName: string, args: Record<string, unknown>): void {
    this.run("beforeToolCall", toolName, args);
  }

  runAfterToolCall(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    isError: boolean,
  ): void {
    this.run("afterToolCall", toolName, args, result, isError);
  }

  runBeforePrompt(prompt: string): void {
    this.run("beforePrompt", prompt);
  }

  runAfterPrompt(): void {
    this.run("afterPrompt");
  }

  runOnPerception(perception: Perception): void {
    this.run("onPerception", perception);
  }

  runOnError(error: Error, context: string): void {
    this.run("onError", error, context);
  }

  hasHooks(type: HookType): boolean {
    const arr = this.hooks.get(type);
    return !!arr && arr.length > 0;
  }

  private run(type: HookType, ...args: unknown[]): void {
    const arr = this.hooks.get(type);
    if (!arr) return;
    for (const fn of arr) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.warn(`[hooks] ${type} hook error:`, err);
      }
    }
  }
}
