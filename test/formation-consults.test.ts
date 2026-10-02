// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChannelManager } from "../src/coordination/channel-manager";
import {
  type Consultant,
  pickConsultants,
  REQUEST_PROTOCOL_FORMATIONS,
  requestProtocolLine,
} from "../src/coordination/crew-formations";
import { Engine } from "../src/engine/engine";
import { handleModelApi, pendingRequests, roundRobinCounters } from "../src/net/model-api";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const ROSTER: Consultant[] = [
  { name: "Skeptic", role: "skeptic", model: "openrouter/anthropic/claude-opus-5.5" },
  { name: "Skeptic2", role: "skeptic", model: "openrouter/qwen/qwen3.8-max" },
  { name: "Mathematician", role: "mathematician", model: "openrouter/openai/gpt-6.1-sol" },
  { name: "Historian", role: "historian", model: "openrouter/anthropic/claude-sonnet-5.5" },
  { name: "Scholar", role: "scholar", model: "openrouter/moonshotai/kimi-k3" },
];

describe("request protocols", () => {
  it("verification picks the formation's roles in order, one per role", () => {
    const picked = pickConsultants("verification", ROSTER, "openrouter/google/gemini-3.8-flash");
    expect(picked.map((c) => c.name)).toEqual(["Skeptic", "Mathematician"]);
  });

  it("prefers a consultant whose vendor differs from the responder's", () => {
    // The responder runs on Anthropic: the qwen-backed skeptic is the independent mind.
    const picked = pickConsultants("verification", ROSTER, "openrouter/anthropic/claude-opus-5.5");
    expect(picked[0]?.name).toBe("Skeptic2");
  });

  it("skips missing roles and returns nothing for formations without a protocol", () => {
    const onlyScholar = ROSTER.filter((c) => c.role === "scholar");
    expect(pickConsultants("verification", onlyScholar).map((c) => c.name)).toEqual(["Scholar"]);
    expect(pickConsultants("freeform", ROSTER)).toEqual([]);
    expect(requestProtocolLine("freeform", ROSTER)).toBeUndefined();
    expect(requestProtocolLine("verification", [])).toBeUndefined();
  });

  it("names consultants, aspects and a bounded wait", () => {
    const line = requestProtocolLine("verification", ROSTER.slice(0, 1), 25_000)!;
    expect(line).toStartWith("[protocol:verification]");
    expect(line).toContain("Skeptic (counter-argument)");
    expect(line).toContain("timeoutMs:25000");
    expect(line).toContain("Timeout: keep your draft");
    // Fits easily ahead of the request content in the clamped perception line.
    expect(line.length).toBeLessThan(400);
    for (const f of REQUEST_PROTOCOL_FORMATIONS) {
      expect(requestProtocolLine(f, ROSTER.slice(0, 2))).toContain(`[protocol:${f}]`);
    }
  });
});

const TEST_DB = "test_formation_consults.db";

describe("serving crew routing", () => {
  let db: MarinaDB;
  let engine: Engine;
  let cm: ChannelManager;

  const spawn = (connId: string, name: string, role: string, model: string): EntityId => {
    const conn = new MockConnection(connId);
    engine.addConnection(conn);
    engine.spawnEntity(connId, name);
    db.saveAgentConfig({ name, model, role, spawnedBy: "system" });
    const entity = engine.entities.all().find((e) => e.name === name)!;
    entity.kind = "agent";
    return entity.id;
  };

  beforeEach(() => {
    process.env.MARINA_OPEN_API = "true";
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    cm = engine.channelManager!;
    roundRobinCounters.clear();
    pendingRequests.clear();
  });

  afterEach(() => {
    delete process.env.MARINA_OPEN_API;
    db.close();
    cleanupDb(TEST_DB);
  });

  async function ask(formation: "verification" | "freeform") {
    const lead = spawn("c1", "Answerer", "answerer", "openrouter/anthropic/claude-opus-5.5");
    const helper = spawn("c2", "Translator", "translator", "openrouter/deepseek/deepseek-v4");
    spawn("c3", "Skeptic", "skeptic", "openrouter/qwen/qwen3.8-max");
    const channel = cm.createChannel({ type: "model", name: "model-answerer" });
    // The Translator joined the endpoint channel on its own (drift).
    cm.addMember(channel.id, lead);
    cm.addMember(channel.id, helper);
    engine.crewManager!.create({
      name: "answerer",
      goal: "serve marina:answerer",
      formation,
      lifetime: "persisted",
      owner: lead,
      members: [
        { agentName: "Answerer", role: "lead" },
        { agentName: "Translator", role: "specialist" },
      ],
    });
    const seen: { target: string; protocol?: string }[] = [];
    cm.onMessage((channelId, senderId, _name, content) => {
      if (senderId !== "__model_api__") return;
      const parsed = JSON.parse(content);
      if (parsed.type !== "model_request" || parsed.reminder) return;
      seen.push({ target: parsed.target, protocol: parsed.protocol });
      cm.send(
        channelId,
        parsed.target,
        "x",
        JSON.stringify({ type: "model_response", id: parsed.id, content: "ok" }),
      );
    });
    for (let i = 0; i < 3; i++) {
      const req = new Request("http://localhost:3300/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "marina:answerer",
          messages: [{ role: "user", content: `question ${i}` }],
        }),
      });
      const resp = await handleModelApi(new URL(req.url), "POST", req, engine);
      expect(resp?.status).toBe(200);
    }
    return { seen, lead };
  }

  it("routes every request to the crew's outward face, never a drifted specialist", async () => {
    const { seen, lead } = await ask("freeform");
    expect(seen.map((s) => s.target)).toEqual([lead, lead, lead]);
    expect(seen.every((s) => s.protocol === undefined)).toBe(true);
  });

  it("a verification crew's request names an online specialist to consult", async () => {
    const { seen } = await ask("verification");
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.protocol).toStartWith("[protocol:verification]");
      expect(s.protocol).toContain("Skeptic (counter-argument)");
      // A crew member that is not a consult role (Translator) is not named.
      expect(s.protocol).not.toContain("Translator");
    }
  });
});
