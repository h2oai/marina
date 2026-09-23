// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Spend ceiling + consecutive-failure breaker: the rolling-window ledger, the
 * env parsing behind the caps, and the adapter's pause/resume/notify paths.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spendLimitsFromEnv } from "../src/agent/agent-runtime";
import {
  formatUsd,
  LeanAgentAdapter,
  operatorStatusOf,
  SpendWindow,
} from "../src/agent/lean-agent-adapter";
import {
  MAX_CONSECUTIVE_UPSTREAM_ERRORS,
  maxConsecutiveUpstreamErrorsFromEnv,
  positiveNumberFromEnv,
  upstreamErrorBackoffMs,
  upstreamErrorPauseMsFromEnv,
} from "../src/engine/constants";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";

// ─── Rolling window ───────────────────────────────────────────────────────────

describe("SpendWindow", () => {
  it("sums only samples inside the window and prunes older ones", () => {
    const w = new SpendWindow(60_000);
    w.record(0.5, 1_000);
    w.record(0.25, 30_000);
    expect(w.total(30_000)).toBeCloseTo(0.75);
    // 1_000 falls out once the cutoff (now - 60s) passes it.
    expect(w.total(61_001)).toBeCloseTo(0.25);
    expect(w.size).toBe(1);
    expect(w.total(200_000)).toBe(0);
    expect(w.size).toBe(0);
  });

  it("ignores zero, negative and non-finite costs", () => {
    const w = new SpendWindow();
    w.record(0);
    w.record(-1);
    w.record(Number.NaN);
    w.record(Number.POSITIVE_INFINITY);
    expect(w.size).toBe(0);
    expect(w.total()).toBe(0);
  });
});

describe("formatUsd", () => {
  it("uses cents above a dollar and four places below", () => {
    expect(formatUsd(12.3456)).toBe("$12.35");
    expect(formatUsd(0.00421)).toBe("$0.0042");
    expect(formatUsd(0)).toBe("$0.0000");
  });
});

// ─── Env parsing ─────────────────────────────────────────────────────────────

describe("spend / breaker env parsing", () => {
  it("positiveNumberFromEnv treats unset, blank, 0, negative and junk as undefined", () => {
    expect(positiveNumberFromEnv("X", {})).toBeUndefined();
    expect(positiveNumberFromEnv("X", { X: "" })).toBeUndefined();
    expect(positiveNumberFromEnv("X", { X: "0" })).toBeUndefined();
    expect(positiveNumberFromEnv("X", { X: "-3" })).toBeUndefined();
    expect(positiveNumberFromEnv("X", { X: "lots" })).toBeUndefined();
    expect(positiveNumberFromEnv("X", { X: "2.5" })).toBe(2.5);
  });

  it("spendLimitsFromEnv defaults to unlimited and reads both caps", () => {
    expect(spendLimitsFromEnv({})).toEqual({});
    expect(
      spendLimitsFromEnv({
        MARINA_MAX_COST_USD_PER_HOUR: "5",
        MARINA_MAX_AGENT_COST_USD_PER_HOUR: "0.75",
      }),
    ).toEqual({ globalUsdPerHour: 5, perAgentUsdPerHour: 0.75 });
    expect(spendLimitsFromEnv({ MARINA_MAX_COST_USD_PER_HOUR: "0" })).toEqual({});
  });

  it("maxConsecutiveUpstreamErrorsFromEnv defaults to 20 and floors at 1", () => {
    expect(maxConsecutiveUpstreamErrorsFromEnv({})).toBe(20);
    expect(
      maxConsecutiveUpstreamErrorsFromEnv({ MARINA_MAX_CONSECUTIVE_UPSTREAM_ERRORS: "7" }),
    ).toBe(7);
    expect(
      maxConsecutiveUpstreamErrorsFromEnv({ MARINA_MAX_CONSECUTIVE_UPSTREAM_ERRORS: "0.4" }),
    ).toBe(1);
    expect(
      maxConsecutiveUpstreamErrorsFromEnv({ MARINA_MAX_CONSECUTIVE_UPSTREAM_ERRORS: "nope" }),
    ).toBe(20);
  });

  it("upstreamErrorPauseMsFromEnv defaults to 10 minutes", () => {
    expect(upstreamErrorPauseMsFromEnv({})).toBe(600_000);
    expect(upstreamErrorPauseMsFromEnv({ MARINA_UPSTREAM_ERROR_PAUSE_MS: "1500" })).toBe(1500);
  });

  it("upstreamErrorBackoffMs doubles from 5s and caps at 30s", () => {
    expect(upstreamErrorBackoffMs(1)).toBe(5_000);
    expect(upstreamErrorBackoffMs(2)).toBe(10_000);
    expect(upstreamErrorBackoffMs(3)).toBe(20_000);
    expect(upstreamErrorBackoffMs(4)).toBe(30_000);
    expect(upstreamErrorBackoffMs(50)).toBe(30_000);
    expect(upstreamErrorBackoffMs(0)).toBe(5_000);
  });
});

// ─── Adapter pause / notify paths ────────────────────────────────────────────

type AdapterInternals = {
  spend: SpendWindow;
  config: { spawnedBy?: string };
  client: { command: (cmd: string) => Promise<unknown> };
  autonomousLoopRunning: boolean;
  autonomousMode: boolean;
  cycleWaiter: { wake(): void };
  agent: { state: { isStreaming: boolean } };
  checkSpendCaps(): string | null;
  afterUpstreamError(consecutiveErrors: number, backoffMs: number): Promise<number>;
  runAutonomousLoop(): Promise<void>;
};

function makeAdapter(
  spendGuard?: ConstructorParameters<typeof LeanAgentAdapter>[5],
  model = "anthropic/claude-haiku-4-5",
): { adapter: LeanAgentAdapter; internals: AdapterInternals; sent: string[] } {
  const adapter = new LeanAgentAdapter(
    { name: "spendy", model, spawnedBy: "Boss" },
    "ws://localhost:39999",
    null,
    "sk-test",
    undefined,
    spendGuard,
  );
  const internals = adapter as unknown as AdapterInternals;
  const sent: string[] = [];
  internals.client.command = async (cmd: string) => {
    sent.push(cmd);
    return { ok: true };
  };
  return { adapter, internals, sent };
}

describe("LeanAgentAdapter spend guard", () => {
  afterEach(() => resetTrustProfileForTests());

  it("reports zeroed operator status before the first turn", () => {
    const { adapter } = makeAdapter({ perAgentUsdPerHour: 1 });
    const ops = operatorStatusOf(adapter);
    expect(ops).toBeDefined();
    expect(ops?.totalCostUsd).toBe(0);
    expect(ops?.costLastHourUsd).toBe(0);
    expect(ops?.paused).toBeNull();
    expect(ops?.lastError).toBeNull();
    expect(ops?.nextTickInMs).toBeNull();
    expect(ops?.spendCaps).toEqual({ perAgentUsdPerHour: 1, globalUsdPerHour: undefined });
  });

  it("checkSpendCaps: per-agent cap first, then the runtime-wide cap", () => {
    let globalSpend = 0;
    const { internals } = makeAdapter({
      perAgentUsdPerHour: 1,
      globalUsdPerHour: 3,
      globalCostLastHour: () => globalSpend,
    });
    expect(internals.checkSpendCaps()).toBeNull();

    internals.spend.record(1.25);
    expect(internals.checkSpendCaps()).toContain("spend cap reached ($1.25 in last hour ≥ $1.00");
    expect(internals.checkSpendCaps()).toContain("per agent");

    // Under the per-agent cap, over the global one.
    const fresh = makeAdapter({
      perAgentUsdPerHour: 10,
      globalUsdPerHour: 3,
      globalCostLastHour: () => globalSpend,
    }).internals;
    globalSpend = 3.5;
    expect(fresh.checkSpendCaps()).toContain("$3.50 across all agents in last hour ≥ $3.00");
  });

  it("no caps configured ⇒ never breaches", () => {
    const { internals } = makeAdapter();
    internals.spend.record(1_000);
    expect(internals.checkSpendCaps()).toBeNull();
  });

  it("pauses the loop on a cap breach, tells the spawner once, and resumes when the window clears", async () => {
    const { adapter, internals, sent } = makeAdapter({
      perAgentUsdPerHour: 1,
    });
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
    internals.spend.record(2);
    internals.autonomousLoopRunning = true;
    internals.autonomousMode = true;
    const loop = internals.runAutonomousLoop();
    // An idle adapter's first dynamic delay is the 60 s idle tick — cut it
    // short the way a perception would, so the cap check runs now.
    internals.cycleWaiter.wake();
    await tick(50);
    let ops = operatorStatusOf(adapter);
    expect(ops?.paused?.kind).toBe("spend-cap");
    expect(ops?.paused?.reason).toContain("spend cap reached");
    expect(ops?.lastError?.text).toContain("spend cap reached");
    expect(ops?.nextTickInMs).not.toBeNull();
    expect(sent.filter((c) => c.startsWith("tell Boss")).length).toBe(1);

    // Window drains: swap in an empty ledger and wake the paused sleep. Park the
    // resumed loop on the streaming stall so it never reaches a real model call.
    internals.agent.state.isStreaming = true;
    (internals as { spend: SpendWindow }).spend = new SpendWindow();
    // First wake ends the 30 s pause poll; the loop then arms its dynamic
    // delay before re-checking, so a second wake brings the check forward.
    internals.cycleWaiter.wake();
    await tick(20);
    internals.cycleWaiter.wake();
    await tick(50);
    ops = operatorStatusOf(adapter);
    expect(ops?.paused).toBeNull();
    // No second notification on resume.
    expect(sent.filter((c) => c.startsWith("tell Boss")).length).toBe(1);

    internals.autonomousLoopRunning = false;
    internals.autonomousMode = false;
    internals.cycleWaiter.wake();
    await loop;
  }, 10_000);
});

describe("LeanAgentAdapter consecutive-failure breaker", () => {
  it("below the threshold: sleeps the backoff and keeps the count", async () => {
    const { internals, sent } = makeAdapter();
    const next = await internals.afterUpstreamError(MAX_CONSECUTIVE_UPSTREAM_ERRORS - 1, 1);
    expect(next).toBe(MAX_CONSECUTIVE_UPSTREAM_ERRORS - 1);
    expect(sent).toEqual([]);
  });

  it("at the threshold: pauses, tells the spawner once, resets the counter", async () => {
    const { adapter, internals, sent } = makeAdapter();
    // Loop flags are false on a fresh adapter, so the pause loop exits at once
    // instead of sleeping UPSTREAM_ERROR_PAUSE_MS.
    const next = await internals.afterUpstreamError(MAX_CONSECUTIVE_UPSTREAM_ERRORS, 1);
    expect(next).toBe(0);
    const tells = sent.filter((c) => c.startsWith("tell Boss"));
    expect(tells.length).toBe(1);
    expect(tells[0]).toContain(`${MAX_CONSECUTIVE_UPSTREAM_ERRORS} consecutive upstream errors`);
    const ops = operatorStatusOf(adapter);
    expect(ops?.paused).toBeNull(); // pause lifted
    expect(ops?.consecutiveErrors).toBe(0);
    expect(ops?.lastError?.text).toContain("consecutive upstream errors");
    expect(ops?.lastError?.at).toBeGreaterThan(0);
  });

  it("does not tell a system-spawned agent's (absent) spawner", async () => {
    const { internals, sent } = makeAdapter();
    internals.config.spawnedBy = "system";
    await internals.afterUpstreamError(MAX_CONSECUTIVE_UPSTREAM_ERRORS, 1);
    expect(sent).toEqual([]);
  });
});

describe("LeanAgentAdapter remote-target guard", () => {
  afterEach(() => resetTrustProfileForTests());

  it("start() refuses a metadata-IP marina@ target without connecting", async () => {
    setTrustProfile("shared");
    const { adapter, internals } = makeAdapter(undefined, "marina@169.254.169.254:3300");
    let connected = false;
    (internals.client as unknown as { connect: () => Promise<never> }).connect = async () => {
      connected = true;
      throw new Error("should not connect");
    };
    await expect(adapter.start()).rejects.toThrow(/blocked|not connected/i);
    expect(connected).toBe(false);
  });

  it("reconfigure() refuses a blocked target and leaves the model unchanged", async () => {
    setTrustProfile("shared");
    const { adapter } = makeAdapter();
    await expect(adapter.reconfigure({ model: "marina@localhost:3300" })).rejects.toThrow(
      /loopback/i,
    );
    expect(adapter.getStatus().model).toBe("anthropic/claude-haiku-4-5");
  });
});
