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

export interface ActionSummary {
  period: { start: number; end: number };
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  toolUsage: Record<string, number>;
  keyEvents: string[];
  learnings: string[];
  achievements: string[];
  challenges: string[];
  summary: string;
}

// ─── Action History ─────────────────────────────────────────────────────────

export class ActionHistory {
  private actions: ActionEntry[] = [];
  private readonly maxActions = 1000;
  private lastSummaryTime: number = Date.now();
  private readonly summaryInterval = 5 * 60 * 1000;

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

  shouldSummarize(): boolean {
    return Date.now() - this.lastSummaryTime >= this.summaryInterval;
  }

  createSummary(): ActionSummary | null {
    const now = Date.now();
    const startTime = this.lastSummaryTime;
    const periodActions = this.getActions(startTime, now);

    if (periodActions.length === 0) return null;

    const totalActions = periodActions.length;
    const successfulActions = periodActions.filter((a) => a.success !== false).length;
    const failedActions = periodActions.filter((a) => a.success === false || a.error).length;

    const toolUsage: Record<string, number> = {};
    for (const action of periodActions) {
      if (action.type === "tool_call" && action.toolName) {
        toolUsage[action.toolName] = (toolUsage[action.toolName] || 0) + 1;
      }
    }

    const keyEvents: string[] = [];
    const learnings: string[] = [];
    const achievements: string[] = [];
    const challenges: string[] = [];

    for (const action of periodActions) {
      if (action.type === "learning" && action.context) {
        learnings.push(action.context);
      } else if (action.type === "outcome" && action.success) {
        achievements.push(action.context || "Completed action successfully");
      } else if (action.type === "outcome" && !action.success) {
        challenges.push(action.error || action.context || "Action failed");
      } else if (action.type === "tool_call" && action.toolName) {
        if (["marina_move", "marina_build", "marina_command", "memory"].includes(action.toolName)) {
          keyEvents.push(
            `Used ${action.toolName}${action.args ? `: ${JSON.stringify(action.args).substring(0, 50)}` : ""}`,
          );
        }
      }
    }

    const summary = this.generateSummary({
      totalActions,
      successfulActions,
      failedActions,
      toolUsage,
      keyEvents: keyEvents.slice(-10),
      learnings: learnings.slice(-5),
      achievements: achievements.slice(-5),
      challenges: challenges.slice(-3),
    });

    this.lastSummaryTime = now;

    return {
      period: { start: startTime, end: now },
      totalActions,
      successfulActions,
      failedActions,
      toolUsage,
      keyEvents: keyEvents.slice(-10),
      learnings: learnings.slice(-5),
      achievements: achievements.slice(-5),
      challenges: challenges.slice(-3),
      summary,
    };
  }

  private generateSummary(data: {
    totalActions: number;
    successfulActions: number;
    failedActions: number;
    toolUsage: Record<string, number>;
    keyEvents: string[];
    learnings: string[];
    achievements: string[];
    challenges: string[];
  }): string {
    const parts: string[] = [];

    parts.push(
      `Performed ${data.totalActions} actions (${data.successfulActions} successful, ${data.failedActions} failed).`,
    );

    const topTools = Object.entries(data.toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tool, count]) => `${tool} (${count}x)`)
      .join(", ");
    if (topTools) parts.push(`Primary tools: ${topTools}.`);
    if (data.achievements.length > 0)
      parts.push(`Achievements: ${data.achievements.slice(0, 3).join("; ")}.`);
    if (data.learnings.length > 0) parts.push(`Learned: ${data.learnings.slice(0, 2).join("; ")}.`);
    if (data.challenges.length > 0)
      parts.push(`Challenges: ${data.challenges.slice(0, 2).join("; ")}.`);

    return parts.join(" ");
  }

  getRecentSummary(minutes = 5): string {
    const startTime = Date.now() - minutes * 60 * 1000;
    const recentActions = this.getActions(startTime);

    if (recentActions.length === 0) return "No recent activity.";

    const successCount = recentActions.filter((a) => a.success !== false).length;
    const failCount = recentActions.filter((a) => a.success === false).length;

    const toolCounts: Record<string, number> = {};
    for (const action of recentActions) {
      if (action.type === "tool_call" && action.toolName) {
        toolCounts[action.toolName] = (toolCounts[action.toolName] || 0) + 1;
      }
    }

    const topTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0];
    return `Last ${minutes} min: ${recentActions.length} actions (${successCount} ok, ${failCount} failed). Most used: ${topTool?.[0] || "none"}.`;
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
