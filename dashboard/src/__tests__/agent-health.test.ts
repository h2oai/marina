import { describe, expect, it } from "vitest";
import { agentHealth, agentHealthTooltip, formatSince } from "../lib/agent-health";

const NOW = 1_700_000_000_000;

describe("agentHealth", () => {
  it("is dead when stopped", () => {
    expect(agentHealth({ state: "stopped" }, { now: NOW })).toBe("dead");
  });

  it("is stuck on error state or silent-turn threshold", () => {
    expect(agentHealth({ state: "error" }, { now: NOW })).toBe("stuck");
    expect(agentHealth({ state: "autonomous", silentTurns: 6 }, { now: NOW })).toBe("stuck");
    expect(agentHealth({ state: "autonomous", silentTurns: 5 }, { now: NOW })).not.toBe("stuck");
  });

  it("is active when mid-turn or acted recently", () => {
    expect(agentHealth({ state: "autonomous" }, { thinking: true, now: NOW })).toBe("active");
    expect(agentHealth({ state: "idle", lastActivity: NOW - 5_000 }, { now: NOW })).toBe("active");
  });

  it("is idle (alive, consolidating) when quiet beyond the active window", () => {
    expect(agentHealth({ state: "idle", lastActivity: NOW - 120_000 }, { now: NOW })).toBe("idle");
    // No lastActivity yet, not thinking → idle, not dead.
    expect(agentHealth({ state: "autonomous" }, { now: NOW })).toBe("idle");
  });

  it("stuck takes precedence over a recent activity timestamp", () => {
    expect(agentHealth({ state: "error", lastActivity: NOW - 1_000 }, { now: NOW })).toBe("stuck");
  });
});

describe("formatSince", () => {
  it("renders compact units", () => {
    expect(formatSince(8_000)).toBe("8s");
    expect(formatSince(180_000)).toBe("3m");
    expect(formatSince(2 * 3_600_000)).toBe("2h");
  });
});

describe("agentHealthTooltip", () => {
  it("summarizes liveness, latency and silent turns", () => {
    const t = agentHealthTooltip(
      { lastActivity: NOW - 4_000, avgTurnMs: 12_000, silentTurns: 0 },
      "active",
      NOW,
    );
    expect(t).toContain("active");
    expect(t).toContain("acted 4s ago");
    expect(t).toContain("~12s/turn");
    expect(t).not.toContain("silent"); // 0 silent omitted
  });
});
