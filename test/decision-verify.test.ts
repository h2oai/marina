// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { decideVerify } from "../src/decisions/policy";
import { TASK_VERIFY_QUESTIONS } from "../src/decisions/verify";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

describe("verify policy with a named support question", () => {
  it("uses `delivered` for task submissions", () => {
    const v = decideVerify(
      { quality: { type: "score", score: 0.9 }, delivered: { type: "noul", noul: 0.2 } },
      1,
      undefined,
      "delivered",
    );
    expect(v.action).toBe("retry");
    expect(v.signals).toEqual({ quality: 0.9, delivered: 0.2 });
    expect(v.reason).toContain("delivered 0.20");
  });
});

describe("task submit verifier", () => {
  const DB = `test_decision_verify_${process.pid}.db`;
  const keys = [
    "MARINA_DECISIONS",
    "MARINA_DECISION_BASE_URL",
    "MARINA_DECISION_MODEL",
    "MARINA_DECISION_VERIFY",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let backend: ReturnType<typeof Bun.serve>;
  let quality = 0.5;
  let failing = false;
  const asked: Array<{ state: { submission: string }; questions: Record<string, unknown> }> = [];
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let events: EngineEvent[];

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      async fetch(req) {
        asked.push((await req.json()) as (typeof asked)[number]);
        if (failing) return new Response("backend down", { status: 503 });
        return Response.json({
          answers: {
            quality: { type: "score", score: quality, confidence: 0.9 },
            delivered: { type: "noul", noul: quality > 1 ? 0.9 : 0.2 },
          },
        });
      },
    });
  });
  afterAll(() => backend.stop(true));

  beforeEach(() => {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
    process.env.MARINA_DECISION_VERIFY = "on";
    failing = false;
    asked.length = 0;
    db = new MarinaDB(DB);
    events = [];
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.addEventListener((e) => events.push(e));
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c1");
    bob = new MockConnection("c2");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function claimTask(): string {
    engine.processCommand(alice.entity!, "task create Map the grid | Document every sector exit");
    const id = stripAnsi(alice.lastText()).match(/#(\d+)/)![1]!;
    engine.processCommand(bob.entity!, `task claim ${id}`);
    bob.clear();
    return id;
  }
  const claimStatus = (id: string) => engine.taskManager!.getClaim(Number(id), bob.entity!)?.status;

  it("bounces a below-the-bar first submission once, then records the second as is", async () => {
    quality = 0.5;
    const id = claimTask();
    engine.processCommand(bob.entity!, `task submit ${id} I will start mapping tomorrow`);
    await until(() => bob.allText().some((t) => t.includes("Not submitted yet")));
    expect(claimStatus(id)).toBe("claimed");
    expect(asked[0]!.questions).toEqual(TASK_VERIFY_QUESTIONS);
    expect(asked[0]!.state.submission).toBe("I will start mapping tomorrow");
    expect(events.find((e) => e.type === "agent_decision")).toMatchObject({
      name: "Bob",
      stage: "verify",
      verdict: "retry",
      subject: `task #${id}`,
    });

    bob.clear();
    engine.processCommand(bob.entity!, `task submit ${id} Still planning`);
    await until(() => bob.allText().some((t) => t.includes("Submitted work")));
    expect(claimStatus(id)).toBe("submitted");
    expect(asked).toHaveLength(2);
  });

  it("records a good submission immediately", async () => {
    quality = 1.9;
    const id = claimTask();
    engine.processCommand(
      bob.entity!,
      `task submit ${id} Mapped all 25 sectors; exits in board grid-map`,
    );
    await until(() => bob.allText().some((t) => t.includes("Submitted work")));
    expect(claimStatus(id)).toBe("submitted");
  });

  it("never spends a judge call on a submit that cannot succeed, and is inert when off", async () => {
    engine.processCommand(bob.entity!, "task submit 9999 anything");
    await until(() => bob.allText().some((t) => t.includes("Cannot submit")));
    expect(asked).toHaveLength(0);

    process.env.MARINA_DECISION_VERIFY = "off";
    quality = 0.1;
    const id = claimTask();
    engine.processCommand(bob.entity!, `task submit ${id} I will start tomorrow`);
    expect(claimStatus(id)).toBe("submitted");
    expect(asked).toHaveLength(0);
  });

  // `observe`: a local Decisions API stands in for any backend (a local OpenJev,
  // Jev on OpenRouter, TypeSafe) — the judge's opinion is recorded, never acted on.
  it("observe records the judge's opinion without bouncing, and agreement follows the creator's verdict", async () => {
    process.env.MARINA_DECISION_VERIFY = "observe";
    const judged = () => db.listJudgeObservations().length;

    quality = 0.5; // the judge will say "fail"…
    const weak = claimTask();
    engine.processCommand(bob.entity!, `task submit ${weak} Rough notes for the east sectors`);
    expect(claimStatus(weak)).toBe("submitted"); // …but nothing is bounced
    await until(() => judged() === 1);

    quality = 1.9; // "pass"
    const good = claimTask();
    engine.processCommand(bob.entity!, `task submit ${good} Mapped all 25 sectors`);
    await until(() => judged() === 2);

    failing = true; // an outage is "no opinion", never a pass
    const down = claimTask();
    engine.processCommand(bob.entity!, `task submit ${down} Mapped the north wing`);
    await until(() => judged() === 3);

    const [rowDown] = db.listJudgeObservations();
    expect(rowDown).toMatchObject({
      opinion: "none",
      evaluator: "decisions-api:stub-jev",
      mode: "observe",
    });

    // The creator approves both real submissions: one agreement, one false fail.
    engine.processCommand(alice.entity!, `task approve ${weak} Bob`);
    engine.processCommand(alice.entity!, `task approve ${good} Bob`);
    alice.clear();
    engine.processCommand(alice.entity!, "decision agreement");
    const text = stripAnsi(alice.lastText());
    expect(text).toContain("decisions-api:stub-jev");
    expect(text).toContain("agreed 50% of 2");
    expect(text).toContain("failed-but-approved 1");
    expect(text).toContain("no opinion 1");
    expect(events.some((e) => e.type === "agent_decision" && e.verdict === "observed")).toBe(true);
  });

  it("agreement says plainly when there is no backend and no data", () => {
    delete process.env.MARINA_DECISIONS;
    engine.processCommand(alice.entity!, "decision agreement");
    const text = stripAnsi(alice.lastText());
    expect(text).toContain("No decision backend is configured");
    expect(text).toContain("OpenJev");
    expect(text).toContain("MARINA_DECISION_VERIFY=observe");
  });
});
