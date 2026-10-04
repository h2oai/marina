// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runHLE } from "../benchmarks/adapters/hle";
import { fileToLedger, ledgerFileBody } from "../benchmarks/ledger-file";
import { resolveTier0Target, tier0Filing, tier0HarnessArgs } from "../benchmarks/tier0";
import type { BenchmarkConfig, BenchmarkResult } from "../benchmarks/types";
import { attributeRequest, resolveParticipants } from "../src/engine/benchmark-participants";
import { Engine } from "../src/engine/engine";
import { handleBenchmarkFile } from "../src/net/benchmarks-api";
import type { PassthruAuthResult } from "../src/net/model-api/shared";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const T0 = 1_800_000_000_000;

function lifecycle(
  traceId: string,
  phase: "received" | "routed" | "completed",
  at: number,
  extra: Record<string, unknown> = {},
): EngineEvent {
  return {
    type: "model_request_lifecycle",
    phase,
    requestId: traceId,
    runId: traceId,
    traceId,
    spanId: `span-${traceId}`,
    model: "marina:answerer",
    timestamp: at,
    ...extra,
  } as EngineEvent;
}

function turn(name: string, at: number, extra: Record<string, unknown> = {}): EngineEvent {
  return {
    type: "agent_turn_end",
    name,
    hadToolCalls: true,
    toolCount: 1,
    model: `model-of-${name}`,
    costUsd: 0.01,
    timestamp: at,
    ...extra,
  } as EngineEvent;
}

/** One crew request: received at `from`, answered by Answerer at `to`. */
function request(id: string, from: number, to: number): EngineEvent[] {
  return [
    lifecycle(id, "received", from),
    lifecycle(id, "routed", from + 1, { target: "Answerer", routeKind: "agent" }),
    turn("Answerer", to - 10, { traceId: id, runId: id, spanId: `turn-${id}` }),
    lifecycle(id, "completed", to, { target: "Answerer" }),
  ];
}

const crew = ["Answerer", "Mathematician", "Reflector"];
const crewOf = (a: string) => (crew.includes(a) ? crew : undefined);

describe("benchmark participants — attribution", () => {
  it("names the traced answering agent with its model and cost", () => {
    const events = request("req-a", T0, T0 + 1000);
    const a = attributeRequest({
      traceId: "req-a",
      traceEvents: events,
      windowTurns: [],
      nearbyRequests: [],
      crewOf,
    });
    expect(a.attribution).toBe("trace");
    expect(a.participants).toEqual([
      { agent: "Answerer", model: "model-of-Answerer", via: "trace", turns: 1, costUsd: 0.01 },
    ]);
    expect(a.costUsd).toBeCloseTo(0.01);
  });

  it("adds crew-mates' untraced turns inside an exclusive window", () => {
    const events = request("req-a", T0, T0 + 1000);
    const a = attributeRequest({
      traceId: "req-a",
      traceEvents: events,
      windowTurns: [
        turn("Mathematician", T0 + 500),
        turn("Outsider", T0 + 500), // not in the crew
        turn("Reflector", T0 + 5000), // outside the window
        turn("Reflector", T0 + 600, { traceId: "req-other" }), // its own trace
      ],
      nearbyRequests: [],
      crewOf,
    });
    expect(a.attribution).toBe("trace+window");
    expect(a.participants.map((p) => [p.agent, p.via])).toEqual([
      ["Answerer", "trace"],
      ["Mathematician", "window"],
    ]);
    expect(a.overlapping).toBe(0);
    expect(a.costUsd).toBeCloseTo(0.02);
  });

  it("marks window evidence shared — and does not charge it — when another request overlaps", () => {
    const events = request("req-a", T0, T0 + 1000);
    const a = attributeRequest({
      traceId: "req-a",
      traceEvents: events,
      windowTurns: [turn("Mathematician", T0 + 500)],
      // Started before and ended after req-a: no event inside the window, still an overlap.
      nearbyRequests: [
        lifecycle("req-b", "routed", T0 - 100, { target: "Answerer" }),
        lifecycle("req-b", "completed", T0 + 2000, { target: "Answerer" }),
      ],
      crewOf,
    });
    expect(a.overlapping).toBe(1);
    const math = a.participants.find((p) => p.agent === "Mathematician");
    expect(math).toMatchObject({ via: "window", shared: true });
    expect(a.costUsd).toBeCloseTo(0.01); // the traced turn only
  });

  it("credits the upstream model for a passthru request", () => {
    const a = attributeRequest({
      traceId: "req-p",
      traceEvents: [
        lifecycle("req-p", "received", T0, { model: "openrouter/v/m" }),
        lifecycle("req-p", "completed", T0 + 50, {
          target: "openrouter/v/m",
          routeKind: "passthru",
        }),
      ],
      windowTurns: [],
      nearbyRequests: [],
      crewOf,
    });
    expect(a.attribution).toBe("trace");
    expect(a.participants).toEqual([{ model: "openrouter/v/m", via: "trace", turns: 1 }]);
  });

  it("is honest when the request left no events", () => {
    const a = attributeRequest({
      traceId: "req-gone",
      traceEvents: [],
      windowTurns: [],
      nearbyRequests: [],
      crewOf,
    });
    expect(a).toEqual({ attribution: "none", participants: [], costUsd: null, overlapping: 0 });
  });
});

describe("POST /v1/benchmarks/runs — auto-filing", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-autofile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "Lobby", long: "Lobby." }));
    db.saveCrew({
      id: "crew_1",
      name: "answerer",
      goal: "bench",
      formation: "freeform",
      ownerId: "e_1",
      state: "active",
      createdAt: T0,
      lastActivityAt: T0,
    });
    for (const m of crew) db.addCrewMember("crew_1", m, "member", T0);
    // Two sequential requests; Mathematician helps on the first only.
    for (const e of [
      ...request("req-1", T0, T0 + 1000),
      turn("Mathematician", T0 + 400),
      ...request("req-2", T0 + 5000, T0 + 6000),
    ]) {
      db.logEvent(e);
    }
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  const keyed: PassthruAuthResult = {
    matchedKey: "k",
    internal: false,
    openMode: false,
  } as PassthruAuthResult;

  function file(
    label: string,
    pattern: boolean[],
    auth: PassthruAuthResult = keyed,
    extra: { replicateGroup?: string; timestamp?: number } = {},
  ) {
    const body = {
      targetKind: "crew",
      target: { crew: "answerer", formation: label },
      label,
      judge: "judge/model",
      ...(extra.replicateGroup ? { replicateGroup: extra.replicateGroup } : {}),
      result: {
        config: { dataset: "synthetic-set", seed: 1, apiKey: "sk-never" },
        timestamp: extra.timestamp ?? T0 + 7000,
        duration_ms: 7000,
        items: pattern.map((correct, i) => ({
          id: `item-${i}`,
          correct,
          traceId: `req-${i + 1}`,
          question: "secret question text",
          rawResponse: "secret response text",
        })),
      },
    };
    return handleBenchmarkFile(
      new Request("http://local/v1/benchmarks/runs", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      engine,
      auth,
    );
  }

  function run(cmd: string): string {
    const conn = new MockConnection(`c-${Math.random()}`);
    engine.addConnection(conn);
    engine.login(conn.id, `Viewer${Math.floor(Math.random() * 1e6)}`);
    conn.clear();
    engine.processCommand(conn.entity!, cmd);
    return stripAnsi(conn.allTextJoined());
  }

  it("files a run with participants resolved from its traces, and never stores text", async () => {
    const res = await file("crew-a", [true, false]);
    expect(res.status).toBe(201);
    const out = (await res.json()) as {
      runId: string;
      n: number;
      attribution: Record<string, number>;
    };
    expect(out.n).toBe(2);
    expect(out.attribution).toMatchObject({ "trace+window": 1, trace: 1, none: 0 });

    const items = db.getBenchmarkItems(out.runId);
    const first = items.find((i) => i.item_id === "item-0");
    expect(
      JSON.parse(first?.participants_json ?? "[]").map((p: { agent: string }) => p.agent),
    ).toEqual(["Answerer", "Mathematician"]);
    expect(first?.trace_id).toBe("req-1");
    expect(first?.cost_usd).toBeCloseTo(0.02);
    const row = db.getBenchmarkRun(out.runId);
    const stored = JSON.stringify({ row, items });
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("sk-never");

    // Re-filing the same document is a no-op.
    const again = await file("crew-a", [true, false]);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);
  });

  it("a re-file at another time is the same run, and the reply reports the STORED run", async () => {
    const first = (await (
      await file("crew-g", [true, true], keyed, { replicateGroup: "group-one" })
    ).json()) as { runId: string };
    // A resumed harness re-files with a new wall-clock timestamp and another group label.
    const res = await file("crew-g", [true, true], keyed, {
      replicateGroup: "group-two",
      timestamp: T0 + 99_000,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { runId: string; created: boolean; replicateGroup: string };
    expect(out).toMatchObject({ runId: first.runId, created: false, replicateGroup: "group-one" });
    expect(db.queryBenchmarkRuns({ benchmark: "synthetic-set" })).toHaveLength(1);
  });

  it("feeds benchmark participants and benchmark compare", async () => {
    const a = (await (await file("crew-a", [true, false])).json()) as { runId: string };
    const b = (await (await file("crew-b", [true, true])).json()) as { runId: string };
    const parts = run("benchmark participants synthetic-set");
    expect(parts).toContain("Answerer");
    expect(parts).toContain("Mathematician");
    expect(parts).toContain("model-of-Answerer");
    const cmp = run(`benchmark compare ${a.runId} ${b.runId}`);
    expect(cmp).toContain("2");
    expect(cmp).not.toContain("different judges");
  });

  it("refuses the open-API sentinel outside the local profile", async () => {
    const sentinel = { internal: false, openMode: true } as PassthruAuthResult;
    const res = await file("crew-a", [true], sentinel);
    expect(res.status).toBe(403);
    expect(db.queryBenchmarkRuns({}).length).toBe(0);
  });

  it("resolves a batch against the live store", () => {
    const resolved = resolveParticipants(db, ["req-1", "req-2", "req-missing"]);
    expect(resolved.get("req-1")?.attribution).toBe("trace+window");
    expect(resolved.get("req-2")?.attribution).toBe("trace");
    expect(resolved.get("req-missing")?.attribution).toBe("none");
  });
});

describe("harness side — trace ids and filing", () => {
  it("records each item's x-request-id as its traceId", async () => {
    let n = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { choices: [{ message: { content: "Exact Answer: 42" } }] },
          { headers: { "x-request-id": `req-${++n}` } },
        ),
    });
    try {
      const config: BenchmarkConfig = {
        name: "t",
        dataset: "hle-verified-gold",
        adapter: "hle",
        scoring: "accuracy",
        mode: "passthrough",
        model: "marina:answerer",
        endpoint: `http://localhost:${server.port}`,
        concurrency: 1,
      };
      const out = await runHLE(
        [{ id: "a", question: "q", answer: "42", metadata: { answerType: "exactMatch" } }],
        config,
      );
      expect(out[0]?.traceId).toBe("req-1");
    } finally {
      server.stop(true);
    }
  });

  it("a crew target files into its own server; other targets only with --file-to", () => {
    const crewTarget = resolveTier0Target("marina:answerer", { base: "http://localhost:4000" }, {});
    expect(tier0Filing(crewTarget, {})).toEqual({
      fileTo: "http://localhost:4000",
      targetKind: "crew",
      target: JSON.stringify({ crew: "answerer" }),
      label: "marina_answerer",
    });
    expect(tier0Filing(crewTarget, { noFile: true })).toBeUndefined();
    const direct = resolveTier0Target("openrouter/v/m", {}, {});
    expect(tier0Filing(direct, {})).toBeUndefined();
    expect(tier0Filing(direct, { fileTo: "http://localhost:4000" })).toMatchObject({
      targetKind: "model",
      target: "v/m",
    });
    const args = tier0HarnessArgs({ benchmark: "frames", limit: 2 }, crewTarget, {
      seed: 1,
      concurrency: 1,
      filing: tier0Filing(crewTarget, {}),
    });
    expect(args).toContain("--file-to");
    expect(args).toContain("crew");
  });

  it("sends ids and outcomes only — no text, no key", () => {
    const result = {
      config: { dataset: "frames", model: "m", apiKey: "sk-secret", endpoint: "http://x" },
      timestamp: 1,
      duration_ms: 1,
      scores: { overall: 1, breakdown: {} },
      metadata: { total: 1, answered: 1, timeouts: 0, errors: 0, avgLatencyMs: 1 },
      items: [
        {
          id: "i1",
          question: "secret q",
          expected: "secret a",
          actual: "secret r",
          rawResponse: "secret raw",
          correct: true,
          latencyMs: 5,
          traceId: "req-1",
        },
      ],
    } as unknown as BenchmarkResult;
    const body = JSON.stringify(
      ledgerFileBody(result, { fileTo: "http://x", targetKind: "model", target: "m" }),
    );
    expect(body).not.toContain("secret");
    expect(body).toContain("req-1");
  });
});

describe("filing end to end through HTTP", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    dbPath = `/tmp/marina-autofile-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "Lobby", long: "Lobby." }));
    for (const e of request("req-1", T0, T0 + 1000)) db.logEvent(e);
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        handleBenchmarkFile(req, engine, {
          matchedKey: "k",
          internal: false,
          openMode: false,
        } as PassthruAuthResult),
    });
  });

  afterEach(() => {
    server.stop(true);
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("files a harness result and the ledger credits the traced agent", async () => {
    const result = {
      config: { dataset: "frames", model: "marina:answerer", endpoint: "http://x" },
      timestamp: T0 + 2000,
      duration_ms: 2000,
      scores: { overall: 1, breakdown: {} },
      metadata: { total: 1, answered: 1, timeouts: 0, errors: 0, avgLatencyMs: 1 },
      items: [
        {
          id: "i1",
          question: "",
          expected: "",
          actual: "",
          correct: true,
          latencyMs: 5,
          traceId: "req-1",
        },
      ],
    } as unknown as BenchmarkResult;
    const out = await fileToLedger(result, {
      fileTo: `http://localhost:${server.port}`,
      apiKey: "k",
      targetKind: "crew",
      target: { crew: "answerer" },
      label: "e2e",
    });
    expect(out.ok).toBe(true);
    expect(out.attribution?.trace).toBe(1);
    const items = db.getBenchmarkItems(out.runId as string);
    expect(JSON.parse(items[0]?.participants_json ?? "[]")[0]).toMatchObject({
      agent: "Answerer",
      model: "model-of-Answerer",
      via: "trace",
    });
  });

  it("reports a failed filing without throwing", async () => {
    const out = await fileToLedger({} as BenchmarkResult, {
      fileTo: "http://localhost:1",
      targetKind: "model",
      target: "m",
    });
    expect(out.ok).toBe(false);
  });
});
