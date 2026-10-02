// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The boot respawn of saved agents must never lose an agent to the 1 s spawn
 * cooldown (which rate-limits interactive `agent spawn`), while the cooldown
 * itself stays in force for ordinary spawns.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type { AgentConfig } from "../src/agent/agent-types";
import { MarinaDB } from "../src/persistence/database";

type Internals = {
  agents: Map<string, unknown>;
  lastSpawnAt: number;
  spawn: (config: AgentConfig, opts?: { systemRespawn?: boolean }) => Promise<unknown>;
};

const COOLDOWN = "Spawn cooldown";

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

  it("the cooldown still refuses an ordinary spawn and never a system respawn", async () => {
    const config: AgentConfig = { name: "Probe", model: "openai/gpt-5-mini" };
    internals.lastSpawnAt = Date.now();
    await expect(runtime.spawn(config)).rejects.toThrow(COOLDOWN);
    internals.lastSpawnAt = Date.now();
    // Without a WebSocket port the spawn fails later — but never on the cooldown.
    const outcome = await runtime.spawn(config, { systemRespawn: true }).then(
      () => "ok",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(outcome).not.toContain(COOLDOWN);
  });
});
