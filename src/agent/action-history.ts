// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActionEntry {
  timestamp: number;
  type: "tool_call" | "decision" | "outcome" | "learning";
  toolName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  success?: boolean;
  error?: string;
  reasoning?: string;
  context?: string;
}

// ─── Action History ─────────────────────────────────────────────────────────

export class ActionHistory {
  private actions: ActionEntry[] = [];
  private readonly maxActions = 1000;

  addAction(entry: ActionEntry): void {
    this.actions.push(entry);
    if (this.actions.length > this.maxActions) {
      this.actions = this.actions.slice(-this.maxActions);
    }
  }

  getActions(startTime?: number, endTime?: number): ActionEntry[] {
    return this.actions.filter((action) => {
      if (startTime && action.timestamp < startTime) return false;
      if (endTime && action.timestamp > endTime) return false;
      return true;
    });
  }

  clear(): void {
    this.actions = [];
  }

  getActionCount(): number {
    return this.actions.length;
  }

  export(): ActionEntry[] {
    return [...this.actions];
  }

  import(actions: ActionEntry[]): void {
    this.actions = actions;
    if (this.actions.length > this.maxActions) {
      this.actions = this.actions.slice(-this.maxActions);
    }
  }
}
