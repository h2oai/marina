// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `agent_configs.thinking_level` (migration 120): the reasoning depth chosen
 * with `agent spawn … thinking:<level>` / `agent config <name> thinking <level>`
 * survives a restart. NULL means "never set" — it must come back as undefined
 * (so `resolveAgentThinkingLevel` applies the crew/env default), never as "off".
 */

import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type { AgentConfig, AgentHandle } from "../src/agent/agent-types";
import { parseAgentThinkingLevel } from "../src/agent/agent-types";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

describe("agent config persistence — thinking level", () => {
  const path = `/tmp/marina-agent-config-${crypto.randomUUID()}.db`;
  const open: MarinaDB[] = [];
  const openDb = () => {
    const db = new MarinaDB(path);
    open.push(db);
    return db;
  };

  afterEach(() => {
    for (const db of open.splice(0)) db.close();
    cleanupDb(path);
  });

  it("survives a reload from a fresh MarinaDB on the same file; unset stays undefined", () => {
    const db = openDb();
    db.saveAgentConfig({
      name: "deep",
      model: "marina/default",
      role: "scholar",
      spawnedBy: "system",
      thinkingLevel: "high",
    });
    db.saveAgentConfig({ name: "plain", model: "marina/default", spawnedBy: "system" });
    db.close();
    open.length = 0;

    const reopened = openDb();
    const deep = reopened.getAgentConfig("deep");
    expect(deep?.thinking_level).toBe("high");
    expect(parseAgentThinkingLevel(deep?.thinking_level ?? undefined)).toBe("high");
    // Every other column is untouched.
    expect(deep?.model).toBe("marina/default");
    expect(deep?.role).toBe("scholar");
    expect(deep?.supports).toBe('{"text":true}');

    const plain = reopened.getAgentConfig("plain");
    expect(plain?.thinking_level).toBeNull();
    expect(parseAgentThinkingLevel(plain?.thinking_level ?? undefined)).toBeUndefined();
    expect(reopened.getAllAgentConfigs().map((c) => [c.name, c.thinking_level])).toEqual([
      ["deep", "high"],
      ["plain", null],
    ]);
  });

  it("a re-save that does not mention thinking keeps the stored level; `off` is stored as off", () => {
    const db = openDb();
    db.saveAgentConfig({
      name: "deep",
      model: "marina/default",
      spawnedBy: "system",
      thinkingLevel: "high",
    });
    // `agent config deep model …` → reconfigure re-saves without a level.
    db.saveAgentConfig({ name: "deep", model: "openai/gpt-5", spawnedBy: "system" });
    expect(db.getAgentConfig("deep")?.model).toBe("openai/gpt-5");
    expect(db.getAgentConfig("deep")?.thinking_level).toBe("high");
    // `agent config deep thinking off` is an explicit choice, not "unset".
    db.saveAgentConfig({
      name: "deep",
      model: "openai/gpt-5",
      spawnedBy: "system",
      thinkingLevel: "off",
    });
    expect(db.getAgentConfig("deep")?.thinking_level).toBe("off");
  });

  it("the boot-time respawn hands the persisted level to spawn (NULL → undefined)", async () => {
    const db = openDb();
    db.saveAgentConfig({
      name: "deep",
      model: "marina/default",
      spawnedBy: "system",
      thinkingLevel: "xhigh",
    });
    db.saveAgentConfig({ name: "plain", model: "marina/default", spawnedBy: "system" });

    const runtime = new AgentRuntime({ db, wsPort: 0 });
    const seen: AgentConfig[] = [];
    runtime.spawn = async (config: AgentConfig): Promise<AgentHandle> => {
      seen.push(config);
      return {} as AgentHandle;
    };
    try {
      expect(await runtime.init()).toBe(2);
    } finally {
      await runtime.stopAll();
    }
    const byName = new Map(seen.map((c) => [c.name, c]));
    expect(byName.get("deep")?.thinkingLevel).toBe("xhigh");
    expect(byName.has("plain")).toBe(true);
    expect(byName.get("plain")?.thinkingLevel).toBeUndefined();
  });
});
