import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { createEvolutionProtocol } from "../src/engine/evolution-protocol";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

describe("native evolution read API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let dbPath: string;
  let previousFlag: string | undefined;
  let previousOpenApi: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.MARINA_EVOLUTION_PROTOCOLS;
    previousOpenApi = process.env.MARINA_OPEN_API;
    process.env.MARINA_OPEN_API = "true";
    dbPath = `/tmp/marina-evolution-api-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), db, tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.MARINA_EVOLUTION_PROTOCOLS;
    else process.env.MARINA_EVOLUTION_PROTOCOLS = previousFlag;
    if (previousOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = previousOpenApi;
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  async function request(): Promise<Response> {
    const url = new URL("http://localhost/api/evolution-sessions");
    return (await handleDashboardApi(new Request(url), url, "GET", engine, db))!;
  }

  it("does not surface an inactive feature", async () => {
    delete process.env.MARINA_EVOLUTION_PROTOCOLS;
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns protocol, budget, lineage, and attributed runs read-only", async () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    const experimentId = db.createExperiment({ name: "api-loop", creatorName: "Alice" });
    const sessionId = db.createEvolutionSession({
      experimentId,
      objective: "observable evidence",
      createdBy: "Alice",
      protocol: createEvolutionProtocol({ options: ["max-runs=2"] }),
    });
    db.updateEvolutionSessionStatus(sessionId, "active");
    db.addParticipant(experimentId, "Alice");
    db.recordPrimitiveUsage({
      actorName: "Alice",
      actorKind: "agent",
      source: "agent_tool",
      primitive: "marina_evolve",
      action: "propose",
      safeLabel: "marina_evolve",
      toolName: "marina_evolve",
      success: true,
      meaningful: true,
      latencyMs: 42,
    });
    db.createEvolutionRun({
      sessionId,
      hypothesis: "one",
      candidateRef: "note:1",
      proposedBy: "Alice",
    });

    const response = await request();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.experiment_name).toBe("api-loop");
    expect(body[0]?.budget).toMatchObject({ runsRemaining: 1, exhausted: false });
    expect(body[0]?.protocol).toMatchObject({
      automaticContinuation: false,
      automaticPromotion: false,
    });
    expect(body[0]?.runs).toBeArrayOfSize(1);
    expect(body[0]?.activity).toMatchObject({
      participants: ["Alice"],
      activeParticipants: 1,
      toolCalls: 1,
      marinaToolCalls: 1,
      averageToolLatencyMs: 42,
      inputTokens: null,
      costUsd: null,
    });
  });
});
