// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { computeReadiness } from "../src/engine/readiness";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_readiness.db";

// Provider key env vars that gate agentRuntime.isAvailable().
const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
];
const OTHER_VARS = [
  "AGENT_AUTORESPAWN",
  "MARINA_ROOM_AGENTS",
  "TABH2O_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
];

describe("computeReadiness", () => {
  let db: MarinaDB;
  let engine: Engine;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot + clear all relevant env so checks are deterministic.
    for (const v of [...KEY_VARS, ...OTHER_VARS]) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const find = (id: string) => computeReadiness(engine).checks.find((c) => c.id === id)!;

  it("reports everything off on a bare instance with no keys or config", () => {
    expect(find("llm-key").status).toBe("off");
    expect(find("auto-respawn").status).toBe("off");
    expect(find("chronicler").status).toBe("off"); // no config seeded in a bare engine
    expect(find("watcher").status).toBe("off");
    expect(find("tabh2o").status).toBe("off");
    expect(find("model-api").status).toBe("off");
    // Room agents enabled-by-default but no key → degraded, not off.
    expect(find("room-agents").status).toBe("degraded");
    expect(computeReadiness(engine).demo.status).toBe("degraded");
  });

  it("flips llm-key and room-agents to ok when a provider key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(find("llm-key").status).toBe("ok");
    expect(find("room-agents").status).toBe("ok");
  });

  it("auto-respawn turns ok when AGENT_AUTORESPAWN=true", () => {
    process.env.AGENT_AUTORESPAWN = "true";
    expect(find("auto-respawn").status).toBe("ok");
  });

  it("Chronicler is degraded (not off) once a config is seeded but no agent runs", () => {
    db.saveAgentConfig({
      name: "Chronicler",
      model: "marina/default",
      role: "chronicler",
      spawnedBy: "system",
    });
    const chronicler = find("chronicler");
    expect(chronicler.status).toBe("degraded");
    expect(chronicler.remediation).toContain("agent spawn Chronicler");
  });

  it("model-api is degraded when auth is set but no upstream key exists", () => {
    process.env.MODEL_API_KEYS = "sk-marina-test";
    expect(find("model-api").status).toBe("degraded");
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(find("model-api").status).toBe("ok");
  });

  it("room agents off when MARINA_ROOM_AGENTS=false", () => {
    process.env.MARINA_ROOM_AGENTS = "false";
    expect(find("room-agents").status).toBe("off");
  });

  it("requires recent meaningful communication from multiple agents as participation proof", () => {
    const record = (actorName: string, communication = false) =>
      db.recordPrimitiveUsage({
        actorName,
        actorKind: "agent",
        source: "command",
        primitive: communication ? "communication" : "memory",
        action: communication ? "tell" : "note",
        safeLabel: communication ? "tell" : "note",
        success: true,
        meaningful: true,
        worldAction: true,
        communication,
      });
    record("Ada");
    record("Ada", true);
    record("Grace");
    for (const actorName of ["Ada", "Grace"]) {
      db.recordPrimitiveUsage({
        actorName,
        actorKind: "agent",
        source: "agent_tool",
        primitive: "marina",
        action: "marina_command",
        safeLabel: "marina_command",
        toolName: "marina_command",
        success: true,
      });
    }

    const report = computeReadiness(engine);
    expect(report.checks.find((check) => check.id === "primitive-evidence")?.status).toBe("ok");
    expect(report.demo).toMatchObject({
      recentPrimitiveActions: 3,
      activeAgents: 2,
      recentCommunications: 1,
      marinaToolCalls: 2,
      autonomyQualified: true,
    });
  });
});
