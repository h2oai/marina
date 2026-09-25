// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decisions as a tool agents reach for (`decision check` / `decision choose`)
 * and in-world evidence (`note:N`, `task:N`, `chronicle:N`) for the verifier's
 * `grounded` question — advisory everywhere, access scoped to the citer.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { parseEvidenceRefs, resolveEvidence } from "../src/decisions/evidence";
import { decideVerify } from "../src/decisions/policy";
import { clearSubmissionAttempts } from "../src/decisions/verify";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

describe("evidence refs", () => {
  it("parses distinct kind:N refs in order, capped at 8", () => {
    expect(parseEvidenceRefs("see note:3, task:4 and note:3 again; chronicle:9")).toEqual([
      { kind: "note", id: 3 },
      { kind: "task", id: 4 },
      { kind: "chronicle", id: 9 },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => `note:${i + 1}`).join(" ");
    expect(parseEvidenceRefs(many)).toHaveLength(8);
    expect(parseEvidenceRefs("denote:3 feed:1 note:x")).toEqual([]);
  });
});

describe("verify policy with several or no support questions", () => {
  const a = (quality: number, delivered: number, grounded: number) => ({
    quality: { type: "score" as const, score: quality, confidence: 0.9 },
    delivered: { type: "noul" as const, noul: delivered },
    grounded: { type: "noul" as const, noul: grounded },
  });
  it("requires every named support question to clear the bar", () => {
    expect(decideVerify(a(1.9, 0.9, 0.9), 1, undefined, ["delivered", "grounded"]).action).toBe(
      "accept",
    );
    const v = decideVerify(a(1.9, 0.9, 0.2), 1, undefined, ["delivered", "grounded"]);
    expect(v.action).toBe("retry");
    expect(v.reason).toContain("grounded 0.20");
    // Out of attempts still accepts (advisory, never loops).
    expect(decideVerify(a(1.9, 0.9, 0.2), 2, undefined, ["delivered", "grounded"]).action).toBe(
      "accept",
    );
  });
  it("an unsure QUALITY judge never waives a failed support question", () => {
    const measured = {
      quality: { type: "score" as const, score: 0.52, confidence: 0.22 },
      grounded: { type: "noul" as const, noul: 0.02 },
    };
    expect(decideVerify(measured, 1).action).toBe("retry");
    // …but still waives a weak quality score on its own.
    const unsure = { ...measured, grounded: { type: "noul" as const, noul: 0.9 } };
    expect(decideVerify(unsure, 1).action).toBe("accept");
  });
  it("scores quality alone with no support keys", () => {
    expect(decideVerify(a(1.9, 0, 0), 1, undefined, []).action).toBe("accept");
    expect(decideVerify(a(0.4, 1, 1), 1, undefined, []).action).toBe("retry");
  });
});

describe("decision tools in the world", () => {
  const DB = `test_agent_decisions_${process.pid}.db`;
  const keys = [
    "MARINA_DECISIONS",
    "MARINA_DECISION_BASE_URL",
    "MARINA_DECISION_MODEL",
    "MARINA_DECISION_VERIFY",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  type Asked = { state: Record<string, unknown>; questions: Record<string, unknown> };
  const asked: Asked[] = [];
  let grounded = 0.9;
  let backend: ReturnType<typeof Bun.serve>;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let events: EngineEvent[];

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Asked;
        asked.push(body);
        if (body.questions.pick) {
          return Response.json({
            answers: { pick: { type: "choice", choice: "o2", confidence: 0.81 } },
          });
        }
        return Response.json({
          answers: {
            quality: { type: "score", score: 1.8, confidence: 0.9 },
            delivered: { type: "noul", noul: 0.9 },
            grounded: { type: "noul", noul: grounded },
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
    delete process.env.MARINA_DECISION_VERIFY;
    asked.length = 0;
    grounded = 0.9;
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

  it("resolves only evidence the citer may read, masked", () => {
    const mine = db.createNote("Bob", "Sector 7 has an exit north. Contact bob@example.com");
    const theirs = db.createNote("Alice", "Alice's private plan");
    const chron = db.appendChronicle({
      kind: "event",
      source: "engine",
      title: "Grid mapped",
      body: "25 sectors",
    });
    const evidence = resolveEvidence(
      db,
      { name: "Bob", id: bob.entity! },
      `done: note:${mine} note:${theirs} chronicle:${chron}`,
    );
    expect(evidence.map((e) => e.ref)).toEqual([`note:${mine}`, `chronicle:${chron}`]);
    expect(evidence[0]!.text).toContain("<email>");
    expect(evidence[0]!.text).not.toContain("bob@example.com");
  });

  it("decision check scores a draft against cited evidence and only advises", async () => {
    const note = db.createNote("Bob", "Sector 7 has an exit north.");
    engine.processCommand(
      bob.entity!,
      `decision check Map the grid | Sector 7 exits north (note:${note})`,
    );
    await until(() => bob.allText().some((t) => t.includes("Meets the bar")));
    expect(asked[0]!.state).toMatchObject({
      request: "Map the grid",
      answer: `Sector 7 exits north (note:${note})`,
      evidence: [{ ref: `note:${note}`, text: "Sector 7 has an exit north." }],
    });
    expect(Object.keys(asked[0]!.questions).sort()).toEqual(["grounded", "quality"]);
    expect(stripAnsi(bob.lastText())).toContain(`grounding checked against note:${note}`);
    expect(events.find((e) => e.type === "agent_decision")).toMatchObject({
      name: "Bob",
      stage: "check",
      verdict: "meets",
    });

    bob.clear();
    grounded = 0.1;
    engine.processCommand(bob.entity!, `decision check Sector 7 exits south (note:${note})`);
    await until(() => bob.allText().some((t) => t.includes("Below the bar")));
    expect(stripAnsi(bob.allText().join("\n"))).toContain("up to you");
  });

  it("decision check without citations asks about quality only", async () => {
    engine.processCommand(bob.entity!, "decision check All sectors documented");
    await until(() => bob.allText().some((t) => t.includes("the bar")));
    expect(Object.keys(asked[0]!.questions)).toEqual(["quality"]);
    expect(asked[0]!.state.evidence).toBeUndefined();
    expect(stripAnsi(bob.lastText())).toContain("no evidence cited");
  });

  it("decision choose returns the pick for the agent to act on", async () => {
    engine.processCommand(
      bob.entity!,
      "decision choose Which task first? | Map the grid | Fix the flaky tests | Write the digest",
    );
    await until(() => bob.allText().some((t) => t.includes("Pick:")));
    expect(stripAnsi(bob.lastText())).toContain("Pick: Fix the flaky tests (confidence 0.81)");
    expect(asked[0]!.questions.pick).toMatchObject({
      type: "choice",
      criteria: { o1: "Map the grid", o2: "Fix the flaky tests", o3: "Write the digest" },
    });
  });

  it("says so when the world has no decision backend", () => {
    delete process.env.MARINA_DECISIONS;
    delete process.env.MARINA_DECISION_BASE_URL;
    engine.processCommand(bob.entity!, "decision check anything");
    expect(stripAnsi(bob.lastText())).toContain("No decision backend");
    expect(asked).toHaveLength(0);
  });

  it("a task submission that cites evidence is also checked for grounding", async () => {
    process.env.MARINA_DECISION_VERIFY = "on";
    engine.processCommand(alice.entity!, "task create Map the grid | Document every sector exit");
    const id = stripAnsi(alice.lastText()).match(/#(\d+)/)![1]!;
    engine.processCommand(bob.entity!, `task claim ${id}`);
    const note = db.createNote("Bob", "Sector 7 has an exit north.");
    grounded = 0.1;
    bob.clear();
    engine.processCommand(bob.entity!, `task submit ${id} Mapped sector 7, see note:${note}`);
    await until(() => bob.allText().some((t) => t.includes("Not submitted yet")));
    expect(asked[0]!.questions.grounded).toBeDefined();
    expect(asked[0]!.state.evidence).toEqual([
      { ref: `note:${note}`, text: "Sector 7 has an exit north." },
    ]);
    expect(stripAnsi(bob.lastText())).toContain("grounded 0.10");
    // The one-bounce counter is process-wide; leave no attempt behind for other files.
    clearSubmissionAttempts(Number(id), bob.entity!);
  });
});
