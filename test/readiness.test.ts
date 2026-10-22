// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  recordToolProbeResultForTests,
  resetToolProbeForTests,
} from "../src/agent/tool-call-probe";
import { readinessCommand, renderTrustProfileLine } from "../src/engine/commands/readiness";
import { Engine } from "../src/engine/engine";
import {
  computeReadiness,
  computeTrustProfile,
  readinessCounts,
  supervisedResidentsCheck,
} from "../src/engine/readiness";
import { setTrustProfile } from "../src/engine/trust-profile";
import { MarinaDB } from "../src/persistence/database";
import type { CommandInput, EntityId, RoomContext } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";
import { providerEnvironmentKeys } from "./hermetic-env";
import { scopeProcessState } from "./process-state";

const TEST_DB = "test_readiness.db";

// Provider credentials and local runtimes that gate agentRuntime.isAvailable().
const KEY_VARS = providerEnvironmentKeys();
const OTHER_VARS = [
  "AGENT_AUTORESPAWN",
  "MARINA_ROOM_AGENTS",
  "TABH2O_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_PROFILE",
  "MARINA_AUTONOMY",
  "GOOGLE_API_KEY",
  "MARINA_DECISIONS",
  "MARINA_DECISION_ENGINE",
  "MARINA_DECISION_ENGINES",
  "MARINA_DECISION_ENSEMBLE",
  "MARINA_DECISION_GATE",
  "MARINA_DECISION_GATE_CONTEXT",
  "MARINA_DECISION_VERIFY",
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

  it("reports supervised residents: on by default with the enrolled count, off when set off", () => {
    db.saveAgentConfig({
      name: "Wren",
      model: "claude",
      spawnedBy: "Ann",
      runtime: "supervised",
      vendor: "claude",
    });
    db.saveAgentConfig({ name: "Helper", model: "marina/default", spawnedBy: "Ann" });
    const on = supervisedResidentsCheck(engine, {});
    expect(on).toMatchObject({ id: "supervised-residents", status: "ok", optional: true });
    expect(on.detail).toContain("1 enrolled, 0 present");
    const off = supervisedResidentsCheck(engine, { MARINA_SUPERVISED_RESIDENTS: "off" });
    expect(off).toMatchObject({ status: "off", optional: true });
    expect(off.remediation).toContain("MARINA_SUPERVISED_RESIDENTS");
    expect(computeReadiness(engine).checks.some((c) => c.id === "supervised-residents")).toBe(true);
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

  it("classifies optional extras: neutral, apart from `off`, status unchanged", () => {
    const report = computeReadiness(engine);
    const optional = report.checks.filter((c) => c.optional).map((c) => c.id);
    for (const id of ["tabh2o", "corpus-hybrid", "decisions", "decision-engines", "watcher"])
      expect(optional).toContain(id);
    // The core is never optional.
    for (const id of ["llm-key", "model-api", "room-agents", "chronicler", "auto-respawn"])
      expect(optional).not.toContain(id);
    // Back-compatible: the status value keeps its meaning; only the summary moves.
    expect(find("tabh2o").status).toBe("off");
    const counts = readinessCounts(report.checks);
    expect(counts.optional).toBe(
      report.checks.filter((c) => c.optional && c.status !== "ok").length,
    );
    expect(counts.off).toBe(report.checks.filter((c) => c.status === "off" && !c.optional).length);
    const text = renderCommand();
    expect(text).toContain(`${counts.off} off · ${counts.optional} optional`);
    expect(text).toContain("○ TabH2O forecasting");
    expect(text).not.toContain("✗ TabH2O forecasting");
  });

  it("shows the activity metrics as `no agents yet` until an agent exists", () => {
    for (const id of ["demo-pulse", "primitive-evidence"]) {
      expect(find(id)).toMatchObject({
        optional: true,
        detail: expect.stringContaining("no agents yet"),
      });
      expect(find(id).remediation).toBeUndefined();
    }
  });

  it("names a missing provider as the cause of dependent gaps on a local install", () => {
    using _state = scopeProcessState();
    setTrustProfile("local");
    expect(find("auto-respawn").detail).toContain("only because no model provider");
    expect(find("room-agents").remediation).toContain("Configure a model provider first");
    expect(find("llm-key").remediation).toContain("key add <name> <provider> <key>");
    expect(find("llm-key").remediation).toContain("OLLAMA_BASE_URL");
    // Seeded Chronicler: no AGENT_AUTORESPAWN=true advice — local respawns by default.
    db.saveAgentConfig({
      name: "Chronicler",
      model: "marina/default",
      role: "chronicler",
      spawnedBy: "system",
    });
    const chronicler = find("chronicler");
    expect(chronicler.status).toBe("degraded");
    expect(chronicler.remediation).not.toContain("AGENT_AUTORESPAWN=true");
    expect(chronicler.remediation).toContain("respawns on the next boot");
  });

  it("never suggests a watcher role the world does not have", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(db.getRole("watcher")).toBeFalsy();
    expect(find("watcher").remediation).not.toContain(
      "agent spawn Watcher model marina/default role watcher (",
    );
    expect(find("watcher").remediation).toContain("role create watcher");
  });

  it("reports tool-calling probes: absent until one ran, degraded for a prose-only model", () => {
    resetToolProbeForTests();
    try {
      expect(computeReadiness(engine).checks.find((c) => c.id === "tool-calling")).toBeUndefined();
      recordToolProbeResultForTests({
        model: "openrouter/a/tools",
        outcome: "tools",
        detail: "ok",
        at: 1,
      });
      expect(find("tool-calling").status).toBe("ok");
      recordToolProbeResultForTests({
        model: "openrouter/b/prose",
        outcome: "no-tool-call",
        detail: "no tool call (stop=stop, 40 output tokens)",
        at: 2,
      });
      expect(find("tool-calling").status).toBe("degraded");
      expect(find("tool-calling").detail).toContain("openrouter/b/prose");
    } finally {
      resetToolProbeForTests();
    }
  });

  it("flips llm-key and room-agents to ok when a provider key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(find("llm-key").status).toBe("ok");
    expect(find("room-agents").status).toBe("ok");
  });

  it("uses actual provider selection for keyless local runtimes and ignores unrelated credentials", () => {
    process.env.LLAMA_BASE_URL = "http://127.0.0.1:8080/v1";
    expect(find("llm-key").status).toBe("ok");
    expect(find("llm-key").detail).toContain("verify connectivity");
    delete process.env.LLAMA_BASE_URL;
    db.saveApiKey({
      name: "unrelated",
      provider: "unrelated",
      encryptedValue: "fixture-only",
      setBy: "test",
    });
    expect(find("llm-key").status).toBe("off");
  });

  it("auto-respawn turns ok when AGENT_AUTORESPAWN=true", () => {
    process.env.AGENT_AUTORESPAWN = "true";
    expect(find("auto-respawn").status).toBe("ok");
  });

  it("auto-respawn defaults on only for a local install with a provider", () => {
    using _state = scopeProcessState();
    setTrustProfile("local");
    // Local, no provider: every call would fail, so agents stay off.
    expect(find("auto-respawn").status).toBe("off");
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    expect(find("auto-respawn").status).toBe("ok");
    expect(find("auto-respawn").detail).toContain("local-install default");
    // An explicit opt-out wins.
    process.env.AGENT_AUTORESPAWN = "false";
    expect(find("auto-respawn").status).toBe("off");
    delete process.env.AGENT_AUTORESPAWN;
    // Shared/public deployments keep agents off unless the operator opts in.
    setTrustProfile("shared");
    expect(find("auto-respawn").status).toBe("off");
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
    using _processState = scopeProcessState();

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
