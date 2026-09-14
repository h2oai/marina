// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readinessCommand, renderTrustProfileLine } from "../src/engine/commands/readiness";
import { Engine } from "../src/engine/engine";
import { computeReadiness, computeTrustProfile } from "../src/engine/readiness";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { MarinaDB } from "../src/persistence/database";
import type { CommandInput, EntityId, RoomContext } from "../src/types";
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
  "MARINA_PROFILE",
  "MARINA_AUTONOMY",
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
    resetTrustProfileForTests();
    db.close();
    cleanupDb(TEST_DB);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Run the `readiness` command against a report and capture its text. */
  const renderCommand = () => {
    const sent: string[] = [];
    const ctx = {
      send: (_to: EntityId, text: string) => sent.push(text),
    } as unknown as RoomContext;
    const input: CommandInput = {
      entity: "e_1" as EntityId,
      room: roomId("test/start"),
      verb: "readiness",
      args: "",
      tokens: [],
      raw: "readiness",
    };
    void readinessCommand({ readiness: () => computeReadiness(engine) }).handler(ctx, input);
    return sent.join("\n");
  };

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

  it("reports the trust profile: shared by default in-process, gates enforced", () => {
    const trust = computeReadiness(engine).trustProfile;
    expect(trust).toMatchObject({ profile: "shared", ungated: false, autonomy: "guarded" });
    expect(trust.reason).toContain("shared");
    const line = renderCommand()
      .split("\n")
      .find((l) => l.startsWith("Trust profile:"));
    expect(line).toBe(renderTrustProfileLine(trust));
    expect(line).toContain("SHARED — gates enforced");
    expect(line).toContain("autonomy: guarded");
    // Rendered right under the header, before the counts.
    const lines = renderCommand().split("\n");
    expect(lines[0]).toStartWith("Marina readiness");
    expect(lines[1]).toStartWith("Trust profile:");
  });

  it("LOCAL is ungated unless MARINA_AUTONOMY=guarded re-enforces gates", () => {
    setTrustProfile("local");
    const local = computeReadiness(engine).trustProfile;
    expect(local).toEqual({ profile: "local", ungated: true, autonomy: "guarded" });
    expect(renderCommand()).toContain("Trust profile: LOCAL — ungated");

    process.env.MARINA_AUTONOMY = "guarded";
    const reGated = computeTrustProfile();
    expect(reGated).toMatchObject({ profile: "local", ungated: false });
    expect(reGated.reason).toContain("MARINA_AUTONOMY=guarded");
    expect(renderCommand()).toContain("Trust profile: LOCAL — gates enforced (MARINA_AUTONOMY");

    process.env.MARINA_AUTONOMY = "open";
    expect(computeTrustProfile()).toMatchObject({
      profile: "local",
      ungated: true,
      autonomy: "open",
    });

    setTrustProfile("public");
    const publicProfile = computeTrustProfile();
    expect(publicProfile).toMatchObject({ profile: "public", ungated: false });
    expect(publicProfile.reason).toContain("public");
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
