// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The learning loop closes, end to end, in one booted world with a stubbed
 * provider (fake lesson writer and judge; any network call fails the test):
 *
 *   1. live work: tasks claimed by world agents and approved or rejected by a
 *      PERSON through the real commands, and a Code Mode check;
 *   2. each verdict is one outcome row tagged `family:` and `method:`;
 *   3. delivery turns an outcome into a judged lesson, trusted;
 *   4. an agent's own `lessons` recall (the path its continuation prompt
 *      uses) serves that lesson;
 *   5. the competence map ranks the models from the same outcomes;
 *   6. a spawn-time route ACTUALLY CHANGES on that evidence
 *      (`MARINA_ROUTE_EVIDENCE=on`; the default `observe` records the pick).
 *
 * Every hop is asserted; a hop with no production path is a `test.todo`
 * naming the gap.
 */

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { resolveRouteModel } from "../src/agent/agent-runtime";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import type { DecisionProvider } from "../src/decisions/types";
import { competenceMap, rankMethods } from "../src/forecast/competence";
import { outcomeRefs } from "../src/forecast/routing-refs";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  recallLessons,
} from "../src/learning/service";
import { deliverOutcomes } from "../src/outcomes/deliver";
import { recordVerification } from "../src/outcomes/live";
import { settleDelivery } from "../src/outcomes/record";
import type { MarinaClient } from "../src/sdk/client";
import type { EngineEvent, EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

const RULE = "Confirm every listed deliverable is present before submitting a task.";
const FAST = "vendor/fast-coder";
const STRONG = "vendor/strong-coder";
/** Tasks per agent; also the route evidence's minimum n. */
const N = 10;

/** The stub decision backend: every judge question answered 0.9 (confident yes). */
const judge = (): DecisionProvider =>
  ({
    kind: "test",
    model: "test/jev",
    calibrated: true,
    async ask(request: { questions: Record<string, unknown> }) {
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => [k, { type: "noul", noul: 0.9 }]),
        ),
        model: "test/jev",
        provider: "test",
        latencyMs: 1,
        calibrated: true,
      };
    },
  }) as unknown as DecisionProvider;

describe("the learning loop closes", () => {
  let state: DisposableStack;
  let world: ReturnType<typeof createTestEngine>;
  let realFetch: typeof fetch;
  const network: string[] = [];

  beforeEach(() => {
    state = scopeProcessState({
      rateLimitBypass: true,
      env: {
        // A provider exists (nothing is ever sent to it: fetch is stubbed below).
        OPENROUTER_API_KEY: ["fake", "provider"].join("-"),
        MARINA_LESSONS: undefined,
        MARINA_LESSONS_FROM_WORK: undefined,
        MARINA_OUTCOME_JUDGE: undefined,
        // No live classifier or verifier: the stub judge is the only backend.
        MARINA_DECISIONS: "off",
        MARINA_DECISION_VERIFY: "off",
        MARINA_DAILY_SPEND_CAP_USD: "off",
        // Two route tiers and the evidence bar this test meets.
        MARINA_ROUTES: undefined,
        MARINA_ROUTE_FAST_MODEL: FAST,
        MARINA_ROUTE_POWERFUL_MODEL: STRONG,
        MARINA_ROUTE_EVIDENCE: undefined,
        MARINA_ROUTE_EVIDENCE_LIVE: undefined,
        MARINA_ROUTE_EVIDENCE_FAMILIES: undefined,
        MARINA_ROUTE_EVIDENCE_MIN_N: String(N),
      },
    });
    realFetch = globalThis.fetch;
    network.length = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      network.push(String(input instanceof Request ? input.url : input));
      throw new Error("no network in the learning-loop test");
    }) as unknown as typeof fetch;
    world = createTestEngine();
  });

  afterEach(async () => {
    try {
      await settleDelivery(world.db);
      disableOutcomeLearning(world.db);
      await world.dispose();
    } finally {
      globalThis.fetch = realFetch;
      state.dispose();
    }
  });

  it("live work → tagged outcomes → trusted lesson → served to an agent → competence → a route changes", async () => {
    const { db, engine } = world;
    // The world's learner, armed at boot as `main.ts` does — with stub writer and judge.
    enableOutcomeLearning(db, {
      writer: {
        name: "test/writer",
        complete: async () => JSON.stringify({ category: "task work", rule: RULE }),
      },
      judge: judge(),
    });

    // Two world agents (owner-less, so their work is shared evidence) and a person.
    db.saveAgentConfig({ name: "Swift", model: FAST, role: "coder", spawnedBy: "system" });
    db.saveAgentConfig({ name: "Mighty", model: STRONG, role: "coder", spawnedBy: "system" });
    const alice = world.login("Alice");
    const swift = world.login("Swift");
    const mighty = world.login("Mighty");
    const run = async (
      who: { connection: { clear(): void; allTextJoined(): string }; entityId: EntityId },
      text: string,
    ) => {
      who.connection.clear();
      await engine.processCommand(who.entityId, text);
      return stripAnsi(who.connection.allTextJoined());
    };

    // ── Hop 1: live work, approved or rejected by another account (a person) ──
    let task = 0;
    for (let i = 0; i < N; i++) {
      for (const [worker, approve] of [
        [swift, true],
        [mighty, i < 2],
      ] as const) {
        task++;
        expect(await run(alice, `task create Job ${task} | ship deliverable ${task}`)).toContain(
          `Created task #${task}`,
        );
        expect(await run(worker, `task claim ${task}`)).toContain(`Claimed task #${task}`);
        expect(await run(worker, `task submit ${task} done`)).toContain("Submitted");
        const name = worker === swift ? "Swift" : "Mighty";
        expect(
          await run(alice, `task ${approve ? "approve" : "reject"} ${task} ${name}`),
        ).toContain(approve ? "Approved" : "Rejected");
      }
    }
    // A Code Mode check (the producer `code verify` calls).
    recordVerification(db, {
      artifactId: "loop-a1",
      actor: "Swift",
      passed: true,
      commands: [["bun", "test"]],
      detail: "passed 1 check",
    });

    // ── Hop 2: one outcome per verdict, tagged with family and method ──
    const taskRows = db.listOutcomes({ kind: "task", limit: 100 });
    const verdicts = taskRows.filter((o) => o.source === "task:verdict");
    expect(verdicts).toHaveLength(2 * N);
    const swiftRefs = outcomeRefs(verdicts.find((o) => o.owner === "Swift")!.refs_json);
    expect(swiftRefs).toContain("family:work:task");
    expect(swiftRefs).toContain(`method:model:${FAST}`);
    expect(swiftRefs).toContain("scope:shared");
    expect(verdicts.filter((o) => o.owner === "Mighty" && o.succeeded === 1)).toHaveLength(2);
    const code = db.getOutcomeBySubject("artifact:loop-a1")!;
    expect(outcomeRefs(code.refs_json)).toContain("family:work:code");
    expect(outcomeRefs(code.refs_json)).toContain(`method:model:${FAST}`);

    // ── Hop 3: delivery writes a judged lesson, and the judge trusts it ──
    await settleDelivery(db);
    await deliverOutcomes(db);
    const delivered = verdicts
      .map((o) => db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")?.state)
      .filter((s) => s === "done");
    expect(delivered.length).toBeGreaterThan(0);
    const stored = await recallLessons(
      db,
      "tools",
      "confirm deliverables before submitting a task",
      {
        env: {},
      },
    );
    const lesson = stored.recalled.find((l) => l.rule === RULE);
    expect(lesson?.trust).toBe("trusted");

    // ── Hop 4: an agent's own recall serves it (the continuation prompt's path) ──
    // PlatformMemoryBackend.lessonsFor is what a resident's [Lessons] section
    // and a coder's task lessons call; here its client is Swift's connection.
    const client = {
      command: async (text: string) => {
        swift.connection.clear();
        await engine.processCommand(swift.entityId, text);
        return [...(swift.connection as unknown as { messages: unknown[] }).messages];
      },
    } as unknown as MarinaClient;
    const served = await new PlatformMemoryBackend(client).lessonsFor(
      "confirm deliverables before submitting a task",
    );
    expect(served.lines.join("\n")).toContain(RULE);
    // Unverified lessons are labelled so; a trusted one is served plain.
    expect(served.lines.find((l) => l.includes(RULE))).not.toContain("unverified");

    // ── Hop 5: competence evidence from the same outcomes ──
    const cells = competenceMap(db, { family: "work:task" });
    const model = rankMethods(cells, "work:task").find((r) => r.dimension === "model")!;
    expect(model.ranked.map((c) => c.method)).toEqual([`model:${FAST}`, `model:${STRONG}`]);
    expect(model.verdict).toBe("lead");

    // ── Hop 6: a spawn route changes on that evidence ──
    const events: EngineEvent[] = [];
    const spawn = () =>
      resolveRouteModel({ name: "Next", role: "coder" }, db, (e) => events.push(e));
    // Default (`observe`): the router's pick stands; the evidence pick is recorded.
    expect(await spawn()).toBe(STRONG);
    const observed = events.at(-1) as Extract<EngineEvent, { type: "agent_decision" }>;
    expect(observed.signals?.evidence).toBe("observed");
    expect(observed.signals?.evidence_pick).toBe("fast");
    // `on`: the measured route replaces the router's.
    process.env.MARINA_ROUTE_EVIDENCE = "on";
    expect(await spawn()).toBe(FAST);
    const applied = events.at(-1) as Extract<EngineEvent, { type: "agent_decision" }>;
    expect(applied.signals?.evidence).toBe("applied");

    // Nothing left this process.
    expect(network).toEqual([]);
  });

  test.todo(
    "live work outcomes move a PROMOTED default (`resolveDefault`) — no production path: `fileSlotPromotion` is fed only by benchmark-ledger runs (`benchmark promote`, the forecasting selection CLIs), never by the outcome path",
  );
  test.todo(
    "the route changes under the DEFAULT configuration — `MARINA_ROUTE_EVIDENCE` defaults to `observe`, so live evidence is recorded and the router's pick stands until an operator sets `on`",
  );
});
