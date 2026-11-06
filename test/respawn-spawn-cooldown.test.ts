// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The boot respawn of saved agents must never lose an agent to the 1 s spawn
 * cooldown (which rate-limits interactive `agent spawn`), while the cooldown
 * pacing itself spaces ordinary spawns a second apart instead of refusing them.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type { AgentConfig } from "../src/agent/agent-types";
import { MarinaDB } from "../src/persistence/database";

type Internals = {
  agents: Map<string, unknown>;
  lastSpawnAt: number;
  waitMs: (ms: number) => Promise<void>;
  spawn: (config: AgentConfig, opts?: { systemRespawn?: boolean }) => Promise<unknown>;
};

const COOLDOWN = "Spawn queue full";

describe("boot respawn vs the spawn cooldown", () => {
  let db: MarinaDB;
  let runtime: AgentRuntime;
  let internals: Internals;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    runtime = new AgentRuntime({ db });
    internals = runtime as unknown as Internals;
  });
  afterEach(async () => {
    await runtime.stopAll();
    db.close();
  });

  it("init() spawns every saved config as a system respawn", async () => {
    for (const name of ["Answerer", "Mathematician", "Reflector"]) {
      db.saveAgentConfig({ name, model: "openai/gpt-5-mini", spawnedBy: "system" });
    }
    const seen: Array<{ name: string; systemRespawn?: boolean }> = [];
    internals.spawn = async (config, opts) => {
      seen.push({ name: config.name, systemRespawn: opts?.systemRespawn });
      // A spawn that finishes "late" (route resolution) moves the cooldown
      // window onto the next stagger slot — the original failure.
      internals.lastSpawnAt = Date.now();
      internals.agents.set(config.name, { stop: async () => {} });
      return {};
    };
    expect(await runtime.init()).toBe(3);
    expect(seen.map((s) => s.name).sort()).toEqual(["Answerer", "Mathematician", "Reflector"]);
    expect(seen.every((s) => s.systemRespawn === true)).toBe(true);
  }, 10_000);

  it("an ordinary spawn inside the window waits for its slot instead of failing", async () => {
    const waits: number[] = [];
    internals.waitMs = async (ms) => {
      waits.push(ms);
    };
    internals.lastSpawnAt = Date.now();
    // Three spawns in a row: each takes the next one-second slot. Without a
    // WebSocket port each fails later — but never on the pacing.
    const outcomes = await Promise.all(
      ["Probe1", "Probe2", "Probe3"].map((name) =>
        runtime.spawn({ name, model: "openai/gpt-5-mini" }).then(
          () => "ok",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        ),
      ),
    );
    for (const outcome of outcomes) expect(outcome).not.toContain(COOLDOWN);
    expect(waits.length).toBe(3);
    const [a = 0, b = 0, c = 0] = [...waits].sort((x, y) => x - y);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeGreaterThanOrEqual(990);
    expect(c - b).toBeGreaterThanOrEqual(990);
  });

  it("a system respawn never waits, and a queue past 30 s is refused", async () => {
    const waits: number[] = [];
    internals.waitMs = async (ms) => {
      waits.push(ms);
    };
    internals.lastSpawnAt = Date.now();
    const config: AgentConfig = { name: "Probe", model: "openai/gpt-5-mini" };
    const outcome = await runtime.spawn(config, { systemRespawn: true }).then(
      () => "ok",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(outcome).not.toContain(COOLDOWN);
    expect(waits).toEqual([]);
    internals.lastSpawnAt = Date.now() + 60_000;
    await expect(runtime.spawn({ name: "Late", model: "openai/gpt-5-mini" })).rejects.toThrow(
      COOLDOWN,
    );
  });
});
