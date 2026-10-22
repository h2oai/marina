// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One request, one claimant. The model API addresses each `model_request` to
 * one member of the endpoint channel; only that member owes it
 * (`assessPerception`), and a claim with no sign of work lapses and is
 * re-offered (`src/net/model-api/request-claim.ts`). No model calls: the
 * members are simulated residents that run the real attention rule on every
 * perception the engine delivers to them.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { assessPerception, createAttentionState } from "../src/agent/attention";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { OutstandingRequests } from "../src/agent/outstanding-requests";
import { SocialAwareness } from "../src/agent/social";
import type { ChannelManager } from "../src/coordination/channel-manager";
import { Engine } from "../src/engine/engine";
import {
  claimLeaseMs,
  DEFAULT_CLAIM_LEASE_MS,
  isWorkOnRequest,
  RequestClaim,
} from "../src/net/model-api/request-claim";
import { roundRobinCounters, routeToChannel } from "../src/net/model-api/routing";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, type Perception, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

// ─── The claim on its own ───────────────────────────────────────────────────

describe("claimLeaseMs", () => {
  it("defaults, parses, turns off, and ignores junk", () => {
    expect(claimLeaseMs({})).toBe(DEFAULT_CLAIM_LEASE_MS);
    expect(claimLeaseMs({ MARINA_REQUEST_CLAIM_LEASE_MS: "5000" })).toBe(5000);
    expect(claimLeaseMs({ MARINA_REQUEST_CLAIM_LEASE_MS: "0" })).toBe(0);
    expect(claimLeaseMs({ MARINA_REQUEST_CLAIM_LEASE_MS: "off" })).toBe(0);
    expect(claimLeaseMs({ MARINA_REQUEST_CLAIM_LEASE_MS: "soon" })).toBe(DEFAULT_CLAIM_LEASE_MS);
    expect(claimLeaseMs({ MARINA_REQUEST_CLAIM_LEASE_MS: "-1" })).toBe(DEFAULT_CLAIM_LEASE_MS);
  });
});

describe("RequestClaim", () => {
  function claimOver(members: string[], holder: string, load: Record<string, number> = {}) {
    const offers: Array<[string, string]> = [];
    const claim = new RequestClaim({
      holder,
      leaseMs: 0, // expiry driven by hand
      candidates: () => members,
      load: (m) => load[m] ?? 0,
      reoffer: (next, previous) => offers.push([next, previous]),
    });
    return { claim, offers };
  }

  it("re-offers to an untried member, the least loaded first", () => {
    const { claim, offers } = claimOver(["a", "b", "c"], "a", { b: 2, c: 0 });
    claim.expire();
    expect(claim.holder).toBe("c");
    expect(offers).toEqual([["c", "a"]]);
    claim.expire();
    expect(claim.holder).toBe("b");
    expect(claim.reoffers).toBe(2);
  });

  it("once every member has held it, goes to the one that held it longest ago", () => {
    const { claim } = claimOver(["a", "b", "c"], "a");
    claim.expire(); // b (untried, channel order)
    claim.expire(); // c
    claim.expire(); // a held it longest ago
    expect(claim.holder).toBe("a");
    claim.expire();
    expect(claim.holder).toBe("b");
  });

  it("a lone member keeps its request (never re-offered to itself)", () => {
    const { claim, offers } = claimOver(["a"], "a");
    claim.expire();
    expect(claim.holder).toBe("a");
    expect(offers).toEqual([]);
  });

  it("a stopped claim never re-offers", () => {
    const { claim, offers } = claimOver(["a", "b"], "a");
    claim.stop();
    claim.expire();
    expect(offers).toEqual([]);
    expect(claim.holder).toBe("a");
  });

  it("the lease timer re-offers; renewing starts it over", async () => {
    const offers: string[] = [];
    const claim = new RequestClaim({
      holder: "a",
      leaseMs: 60,
      candidates: () => ["a", "b"],
      reoffer: (next) => offers.push(next),
    });
    claim.start();
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(30);
      claim.renew();
    }
    expect(offers).toEqual([]);
    await until(() => offers.length === 1, { timeoutMs: 2_000 });
    expect(claim.holder).toBe("b");
    claim.stop();
  });
});

describe("isWorkOnRequest", () => {
  const turn = (extra: Record<string, unknown>) =>
    ({ type: "agent_turn_start", name: "Ann", timestamp: 1, ...extra }) as EngineEvent;
  it("counts the holder's traced work, or a span that links the request", () => {
    expect(isWorkOnRequest(turn({ traceId: "req-1" }), "Ann", "req-1")).toBe(true);
    expect(
      isWorkOnRequest(
        turn({ traceId: "other", links: [{ traceId: "req-1", spanId: "s" }] }),
        "Ann",
        "req-1",
      ),
    ).toBe(true);
    expect(isWorkOnRequest(turn({ traceId: "req-1" }), "Bo", "req-1")).toBe(false);
    // Events carry the config name, the holder is the sanitized entity name.
    const hyphen = { type: "agent_turn_end", name: "Answerer-2", traceId: "req-1", timestamp: 1 };
    expect(isWorkOnRequest(hyphen as EngineEvent, "Answerer2", "req-1")).toBe(true);
    expect(isWorkOnRequest(hyphen as EngineEvent, "Answerer3", "req-1")).toBe(false);
    expect(isWorkOnRequest(turn({ traceId: "req-2" }), "Ann", "req-1")).toBe(false);
    expect(
      isWorkOnRequest(
        { type: "agent_error", name: "Ann", error: "x", timestamp: 1 } as EngineEvent,
        "Ann",
        "req-1",
      ),
    ).toBe(false);
  });
});

// ─── The attention rule ─────────────────────────────────────────────────────

describe("attention: one member owes each endpoint request", () => {
  const social = new SocialAwareness();
  function channelPerception(content: string, senderName = "model-api"): Perception {
    return {
      kind: "message",
      timestamp: Date.now(),
      tag: "model-crewx",
      data: {
        text: `[model-crewx] ${senderName}: ${content}`,
        channel: "model-crewx",
        senderName,
        content,
      },
    };
  }
  function decide(p: Perception, selfName: string, selfId?: string, owed: string[] = []) {
    return assessPerception(
      {
        perception: p,
        text: String(p.data.text),
        selfName,
        events: social.handlePerception(p),
        scorer: social,
        nudgeMode: "all",
        ...(selfId ? { selfId } : {}),
        owedModelRequests: new Set(owed),
      },
      { mode: "balanced", threshold: 50 },
      createAttentionState(),
    );
  }
  const request = (target?: string, id = "req-1") =>
    channelPerception(
      JSON.stringify({ type: "model_request", id, content: "q?", ...(target ? { target } : {}) }),
    );

  it("the addressee owes it", () => {
    const d = decide(request("e_ann"), "Ann", "e_ann");
    expect(d.keep).toBe(true);
    expect(d.owed).toBe(true);
    expect(d.wake).toBe("now");
  });

  it("every other member drops it: not owed, no wake", () => {
    const d = decide(request("e_ann"), "Bo", "e_bo");
    expect(d.keep).toBe(false);
    expect(d.reason).toBe("addressed-elsewhere");
    expect(d.owed).toBe(false);
    expect(d.wake).toBe("drop");
    expect(d.release).toBeUndefined();
  });

  it("a request without a target is still everyone's", () => {
    expect(decide(request(), "Bo", "e_bo").owed).toBe(true);
  });

  it("without its own id a resident cannot tell, so it keeps the request", () => {
    expect(decide(request("e_ann"), "Bo").owed).toBe(true);
  });

  it("a target naming the resident by name is its own", () => {
    expect(decide(request("bo"), "Bo", "e_bo").owed).toBe(true);
    // The entity name ("Answerer2") names the resident whose config name is "Answerer-2".
    expect(decide(request("Answerer2"), "Answerer-2", "e_2").owed).toBe(true);
    expect(decide(request("Answerer3"), "Answerer-2", "e_2").keep).toBe(false);
  });

  it("the resident's own model_response, under its entity name, is not a peer's", () => {
    const own = channelPerception(
      JSON.stringify({ type: "model_response", id: "req-1", content: "42" }),
      "Answerer2",
    );
    const d = decide(own, "Answerer-2", "e_2", ["req-1"]);
    expect(d.reason).not.toBe("answered-elsewhere");
    expect(d.release).toBeUndefined();
  });

  it("a re-offer addressed elsewhere releases the request the resident held", () => {
    const d = decide(request("e_ann"), "Bo", "e_bo", ["req-1"]);
    expect(d.keep).toBe(false);
    expect(d.release).toBe("req-1");
  });

  it("a peer's model_response is dropped, and releases the request when it was owed", () => {
    const reply = channelPerception(
      JSON.stringify({ type: "model_response", id: "req-1", content: "42" }),
      "Ann",
    );
    const owed = decide(reply, "Bo", "e_bo", ["req-1"]);
    expect(owed.keep).toBe(false);
    expect(owed.reason).toBe("answered-elsewhere");
    expect(owed.release).toBe("req-1");
    const notOwed = decide(reply, "Bo", "e_bo");
    expect(notOwed.keep).toBe(false);
    expect(notOwed.release).toBeUndefined();
  });
});

// ─── The lean adapter applies it ────────────────────────────────────────────

describe("lean adapter: endpoint requests addressed to another member", () => {
  type Internals = {
    client: { emit(event: "perception", p: Perception): void };
    gameState: { setSession(entityId: string, name: string, token: string): void };
    platformMemory: PlatformMemoryBackend;
    outstandingRequests: OutstandingRequests;
    pendingPerceptions: Array<{ text: string; requestId?: string }>;
    autonomousMode: boolean;
  };
  function resident(name: string, entityId: string) {
    const i = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null) as unknown as Internals;
    i.autonomousMode = true;
    i.gameState.setSession(entityId, name, "token");
    const completed: string[][] = [];
    i.platformMemory.saveOutstandingRequests = async () => {};
    i.platformMemory.completeOutstandingRequests = async (ids) => {
      completed.push([...ids]);
    };
    return { i, completed };
  }
  const posted = (target: string, id = "req-1"): Perception => {
    const content = JSON.stringify({ type: "model_request", id, content: "q?", target });
    return {
      kind: "message",
      timestamp: Date.now(),
      tag: "model-answerer",
      data: {
        text: `[model-answerer] model-api: ${content}`,
        channel: "model-answerer",
        senderName: "model-api",
        content,
      },
    };
  };

  it("owes only its own requests, and drops a request re-offered away from it", async () => {
    const { i, completed } = resident("Answerer-2", "e_2");
    i.client.emit("perception", posted("e_1", "req-a"));
    expect(i.outstandingRequests.size).toBe(0);
    expect(i.pendingPerceptions).toHaveLength(0);

    i.client.emit("perception", posted("e_2", "req-b"));
    expect(i.outstandingRequests.modelRequestIds()).toEqual(new Set(["req-b"]));
    expect(i.pendingPerceptions.some((p) => p.text.includes("req-b"))).toBe(true);

    // The claim lapsed: the model API re-offers req-b to Answerer-3.
    i.client.emit("perception", posted("e_3", "req-b"));
    expect(i.outstandingRequests.size).toBe(0);
    expect(i.pendingPerceptions.some((p) => p.text.includes("req-b"))).toBe(false);
    await until(() => completed.length === 1, { timeoutMs: 2_000 });
    expect(completed[0]![0]).toContain("req-b");
  });
});

// ─── Routed requests across a crew of simulated residents ────────────────────

/**
 * A simulated endpoint member: every perception the engine delivers goes
 * through the real attention rule and the real reply ledger. An owed
 * `model_request` is a claim; the member answers it after `delayMs` unless
 * it is `silent`, and while working it reports traced turns (`workEveryMs`).
 */
interface Member {
  /** The config name: what the resident calls itself and its events carry ("Answerer-2"). */
  name: string;
  /** The live entity's sanitized name, as the channel names it ("Answerer2"). */
  entityName: string;
  id: string;
  claims: string[];
  released: string[];
  ledger: OutstandingRequests;
}

describe("routed requests: exactly one claim per request", () => {
  const TEST_DB = `/tmp/marina-crew-claim-${process.pid}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let cm: ChannelManager;
  let channelId: string;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    cm = engine.channelManager!;
    channelId = cm.createChannel({ type: "model", name: "model-crewx", retentionHours: 24 }).id;
    roundRobinCounters.clear();
  });

  afterEach(() => {
    for (const t of timers.splice(0)) clearTimeout(t);
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  function addMember(
    name: string,
    behaviour: { delayMs?: number; silent?: boolean; workEveryMs?: number } = {},
  ): Member {
    const conn = new MockConnection(`c-${name}`);
    engine.addConnection(conn);
    const entity = engine.spawnEntity(conn.id, name)!;
    cm.addMember(channelId, entity.id);
    const member: Member = {
      name,
      entityName: entity.name,
      id: entity.id,
      claims: [],
      released: [],
      ledger: new OutstandingRequests(),
    };
    const social = new SocialAwareness();
    const state = createAttentionState();
    let sequence = 0;
    const deliver = conn.send.bind(conn);
    conn.send = (p: Perception) => {
      deliver(p);
      if (p.data?.channel !== "model-crewx") return;
      const text = stripAnsi(String(p.data.text ?? ""));
      const decision = assessPerception(
        {
          perception: p,
          text,
          selfName: name,
          events: social.handlePerception(p),
          scorer: social,
          selfId: entity.id,
          owedModelRequests: member.ledger.modelRequestIds(),
        },
        { mode: "balanced", threshold: 50 },
        state,
      );
      if (decision.release) {
        member.released.push(decision.release);
        member.ledger.complete(member.ledger.idsForModelRequest(decision.release));
      }
      if (!decision.keep || !decision.owed) return;
      const tracked = member.ledger.track(p, ++sequence, text);
      if (!tracked?.isNew) return; // reminders and repeats are not new claims
      const envelope = JSON.parse(String(p.data.content)) as { id: string };
      member.claims.push(envelope.id);
      if (behaviour.silent) return;
      const reply = () => {
        if (!member.ledger.idsForModelRequest(envelope.id).length) return; // released
        member.ledger.complete(member.ledger.idsForModelRequest(envelope.id));
        cm.send(
          channelId,
          entity.id,
          entity.name, // the channel names the sender by its entity name
          JSON.stringify({
            type: "model_response",
            id: envelope.id,
            content: `${name}:${envelope.id}`,
          }),
        );
      };
      if (behaviour.workEveryMs) {
        const beat = setInterval(() => {
          engine.logEvent({
            type: "agent_turn_start",
            name,
            traceId: envelope.id,
            timestamp: Date.now(),
          });
        }, behaviour.workEveryMs);
        timers.push(beat as unknown as ReturnType<typeof setTimeout>);
        timers.push(
          setTimeout(() => {
            clearInterval(beat);
            reply();
          }, behaviour.delayMs ?? 10),
        );
      } else {
        timers.push(setTimeout(reply, behaviour.delayMs ?? 10));
      }
    };
    return member;
  }

  const lifecycle = (phase: string) =>
    engine
      .getEventLog()
      .filter(
        (e): e is Extract<EngineEvent, { type: "model_request_lifecycle" }> =>
          e.type === "model_request_lifecycle" && e.phase === phase,
      );

  it("N concurrent requests across M members: N claims, N answers, spread evenly", async () => {
    using _state = scopeProcessState({ env: { MODEL_REQUEST_REMINDERS: "0" } });
    const members = ["Ann", "Bo", "Cy", "Di"].map((n) => addMember(n, { delayMs: 15 }));
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => routeToChannel(engine, "marina:crewx", `question ${i}`)),
    );

    const claims = members.flatMap((m) => m.claims);
    expect(claims).toHaveLength(N);
    expect(new Set(claims).size).toBe(N);
    // Round-robin over 4 members: 3 each, and every answer is its claimant's.
    for (const m of members) expect(m.claims).toHaveLength(N / members.length);
    const ids = new Set(results.map((r) => r.requestId));
    expect(ids.size).toBe(N);
    for (const r of results) {
      const claimant = members.find((m) => m.claims.includes(r.requestId))!;
      expect(r.content).toBe(`${claimant.name}:${r.requestId}`);
      expect(r.respondent?.name).toBe(claimant.name);
      expect(r.budgetForced).toBeUndefined();
    }
    expect(lifecycle("completed")).toHaveLength(N);
    expect(lifecycle("routed")).toHaveLength(N); // no re-offers
    // No member is left owing anything.
    for (const m of members) expect(m.ledger.size).toBe(0);
  });

  it("a claim with no sign of work lapses and is re-offered to another member", async () => {
    using _state = scopeProcessState({
      env: { MODEL_REQUEST_REMINDERS: "0", MARINA_REQUEST_CLAIM_LEASE_MS: "80" },
    });
    const stuck = addMember("Ann", { silent: true }); // round-robin picks Ann first
    const live = addMember("Bo", { delayMs: 10 });

    const result = await routeToChannel(engine, "marina:crewx", "q?", { deadlineMs: 10_000 });

    expect(stuck.claims).toEqual([result.requestId]);
    expect(live.claims).toEqual([result.requestId]);
    expect(stuck.released).toEqual([result.requestId]); // the re-offer took it away
    expect(stuck.ledger.size).toBe(0);
    expect(result.content).toBe(`Bo:${result.requestId}`);
    expect(result.respondent?.name).toBe("Bo");
    const reoffer = lifecycle("routed").find((e) => e.routeReason === "reoffered:claim-lapsed");
    expect(reoffer?.target).toBe(live.id);
    const completed = lifecycle("completed").find((e) => e.requestId === result.requestId);
    expect(completed?.target).toBe(live.id);
    expect(completed?.routeReason).toContain("reoffered:1");
  });

  it("a holder that keeps working keeps its claim", async () => {
    using _state = scopeProcessState({
      env: { MODEL_REQUEST_REMINDERS: "0", MARINA_REQUEST_CLAIM_LEASE_MS: "80" },
    });
    const slow = addMember("Ann", { delayMs: 300, workEveryMs: 25 });
    const other = addMember("Bo", { delayMs: 10 });

    const result = await routeToChannel(engine, "marina:crewx", "q?", { deadlineMs: 10_000 });

    expect(result.content).toBe(`Ann:${result.requestId}`);
    expect(slow.claims).toEqual([result.requestId]);
    expect(other.claims).toEqual([]);
    expect(lifecycle("routed").some((e) => e.routeReason === "reoffered:claim-lapsed")).toBe(false);
  });

  it("hyphenated config names: every working holder keeps its claim (no re-offer)", async () => {
    using _state = scopeProcessState({
      env: { MODEL_REQUEST_REMINDERS: "0", MARINA_REQUEST_CLAIM_LEASE_MS: "80" },
    });
    // Agent events say "Answerer-2"; the entities are "Answerer2" (sanitized at spawn).
    const members = ["Answerer", "Answerer-2", "Answerer-3", "Answerer-4"].map((n) =>
      addMember(n, { delayMs: 300, workEveryMs: 25 }),
    );
    expect(members.map((m) => m.entityName)).toEqual([
      "Answerer",
      "Answerer2",
      "Answerer3",
      "Answerer4",
    ]);

    const results = await Promise.all(
      members.map((_, i) =>
        routeToChannel(engine, "marina:crewx", `question ${i}`, { deadlineMs: 10_000 }),
      ),
    );

    expect(lifecycle("routed").some((e) => e.routeReason === "reoffered:claim-lapsed")).toBe(false);
    for (const m of members) {
      expect(m.claims).toHaveLength(1); // its own request, held for the whole 300 ms
      expect(m.released).toEqual([]);
      const r = results.find((x) => x.requestId === m.claims[0])!;
      expect(r.content).toBe(`${m.name}:${r.requestId}`);
      expect(r.respondent?.name).toBe(m.entityName);
    }
  });

  it("hyphenated config names: a silent holder still lapses and is re-offered", async () => {
    using _state = scopeProcessState({
      env: { MODEL_REQUEST_REMINDERS: "0", MARINA_REQUEST_CLAIM_LEASE_MS: "80" },
    });
    const stuck = addMember("Answerer-2", { silent: true });
    const live = addMember("Answerer-3", { delayMs: 10 });
    const result = await routeToChannel(engine, "marina:crewx", "q?", { deadlineMs: 10_000 });
    expect(stuck.released).toEqual([result.requestId]);
    expect(result.respondent?.name).toBe(live.entityName);
  });

  it("deliberate fan-out (panel) still reaches every member, once each", async () => {
    using _state = scopeProcessState({ env: { MODEL_REQUEST_REMINDERS: "0" } });
    const members = ["Ann", "Bo", "Cy"].map((n) => addMember(n, { delayMs: 10 }));
    const { routePanel } = await import("../src/net/model-api/routing");
    const result = await routePanel(engine, "marina:crewx", "q?", undefined, 3, "concat");
    for (const m of members) expect(m.claims).toHaveLength(1);
    expect(result.content).toContain("### Answer 3");
  });
});

describe("RequestDraftCollector: the lead under either spelling", () => {
  it("finds the lead's text and draft whether named by config or entity name", async () => {
    const { RequestDraftCollector } = await import("../src/coordination/request-deadline");
    const text = new RequestDraftCollector("req-1", "Answerer2");
    text.onEvent({
      type: "agent_text_delta",
      name: "Answerer-2",
      delta: "42",
      traceId: "req-1",
      timestamp: 1,
    } as EngineEvent);
    text.onEvent({
      type: "agent_turn_end",
      name: "Answerer-2",
      traceId: "req-1",
      hadToolCalls: false,
      toolCount: 0,
      timestamp: 2,
    } as EngineEvent);
    text.onEvent({
      type: "agent_text_delta",
      name: "Answerer-3",
      delta: "7",
      traceId: "req-1",
      timestamp: 3,
    } as EngineEvent);
    expect(text.best()).toEqual({ text: "42", source: "lead-text" });
    const draft = new RequestDraftCollector("req-1", "Answerer2");
    draft.addExplicit("Answerer2", "draft 42");
    draft.addExplicit("Answerer3", "draft 7");
    expect(draft.best()).toEqual({ text: "draft 42", source: "lead-draft" });
  });
});
