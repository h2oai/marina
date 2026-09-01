// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { desireCommand } from "../src/engine/commands/desire";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, type RoomContext, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = `/tmp/marina-journey-command-${process.pid}.db`;

describe("journey command", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("alice");
    bob = new MockConnection("bob");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("alice", "Alice");
    engine.spawnEntity("bob", "Bob");
    alice.clear();
    bob.clear();
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("preserves the exact desire and starts in expressed state", () => {
    engine.processCommand(alice.entity!, "journey create Understand whether Spain fits my family");

    const journey = db.getLatestJourneyForRequester(alice.entity!);
    expect(journey?.expression).toBe("Understand whether Spain fits my family");
    expect(stripAnsi(alice.lastText())).toContain("Journey expressed");

    alice.clear();
    engine.processCommand(alice.entity!, "journey show latest");
    const output = stripAnsi(alice.lastText());
    expect(output).toContain("State: [expressed]");
    expect(output).toContain("Spain fits my family");
  });

  it("rejects an empty desire", () => {
    engine.processCommand(alice.entity!, "journey create");
    expect(stripAnsi(alice.lastText())).toContain("Usage: journey create <desire>");
    expect(db.listJourneys({ requesterId: alice.entity! })).toHaveLength(0);
  });

  it("correlates existing work without copying it", () => {
    engine.processCommand(alice.entity!, "journey create Investigate a durable question");
    const journey = db.getLatestJourneyForRequester(alice.entity!)!;
    const taskId = db.createTask({
      title: "Inspect the evidence",
      creatorId: alice.entity!,
      creatorName: "Alice",
    });

    alice.clear();
    engine.processCommand(alice.entity!, `journey link latest task ${taskId} pursues`);
    expect(db.getTask(taskId)?.title).toBe("Inspect the evidence");
    expect(db.listJourneyLinks(journey.id)).toHaveLength(1);

    alice.clear();
    engine.processCommand(alice.entity!, "journey show latest");
    const output = stripAnsi(alice.lastText());
    expect(output).toContain("State: [ready]");
    expect(output).toContain(`task:${taskId}`);
  });

  it("makes identical correlations idempotent", () => {
    engine.processCommand(alice.entity!, "journey create Preserve one correlation");
    const journey = db.getLatestJourneyForRequester(alice.entity!)!;

    engine.processCommand(alice.entity!, "journey link latest trace req-1 evidence_for");
    engine.processCommand(alice.entity!, "journey link latest trace req-1 evidence_for");

    expect(db.listJourneyLinks(journey.id)).toHaveLength(1);
  });

  it("projects state from append-only evidence", () => {
    engine.processCommand(alice.entity!, "journey create Compare three directions");

    const transitions = [
      ["grounding", "The criteria are being clarified", "grounding"],
      ["action_started", "A comparison has begun", "active"],
      ["waiting", "The journey needs revenue figures", "waiting"],
      ["challenge", "The market-size assumption is disputed", "challenging"],
      ["result", "A conditional recommendation is available", "useful_result"],
      ["continuation", "Watch the disputed market signal", "continuing"],
      ["dormant", "No further action is justified now", "dormant"],
    ] as const;

    for (const [kind, summary, expected] of transitions) {
      alice.clear();
      engine.processCommand(alice.entity!, `journey record latest ${kind} | ${summary}`);
      expect(stripAnsi(alice.lastText())).toContain(`Current state: ${expected}`);
    }

    const journey = db.getLatestJourneyForRequester(alice.entity!)!;
    expect(db.listJourneyEvents(journey.id)).toHaveLength(transitions.length);
    expect(db.listJourneyEvents(journey.id).map((item) => item.kind)).toEqual(
      transitions.map(([kind]) => kind),
    );
  });

  it("records attributed evidence from another participant", () => {
    engine.processCommand(alice.entity!, "journey create Understand a shared question");
    const journey = db.getLatestJourneyForRequester(alice.entity!)!;

    engine.processCommand(
      bob.entity!,
      `journey record ${journey.id} evidence | Bob found a relevant source | trace:req-7`,
    );

    const events = db.listJourneyEvents(journey.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_name).toBe("Bob");
    expect(events[0]?.ref_kind).toBe("trace");
    expect(events[0]?.ref).toBe("req-7");
    expect(db.listJourneyLinks(journey.id)[0]?.relationship).toBe("evidence_for");
  });

  it("rejects malformed evidence without appending a partial event", () => {
    engine.processCommand(alice.entity!, "journey create Validate evidence input");
    const journey = db.getLatestJourneyForRequester(alice.entity!)!;

    alice.clear();
    engine.processCommand(alice.entity!, "journey record latest evidence extra | malformed");

    expect(stripAnsi(alice.lastText())).toContain("Usage: journey record");
    expect(db.listJourneyEvents(journey.id)).toHaveLength(0);
  });

  it("lists a participant's journeys by default and all journeys explicitly", () => {
    engine.processCommand(alice.entity!, "journey create Alice desire");
    engine.processCommand(bob.entity!, "journey create Bob desire");

    alice.clear();
    engine.processCommand(alice.entity!, "journey list");
    expect(stripAnsi(alice.lastText())).toContain("Alice desire");
    expect(stripAnsi(alice.lastText())).not.toContain("Bob desire");

    alice.clear();
    engine.processCommand(alice.entity!, "journey list all");
    expect(stripAnsi(alice.lastText())).toContain("Alice desire");
    expect(stripAnsi(alice.lastText())).toContain("Bob desire");
  });

  it("begins from one ordinary-language desire without claiming activity", () => {
    engine.processCommand(alice.entity!, "desire Decide whether to relocate next year");

    const journey = db.getLatestJourneyForRequester(alice.entity!)!;
    expect(journey.expression).toBe("Decide whether to relocate next year");
    const output = stripAnsi(alice.lastText());
    expect(output).toContain("Your journey has begun");
    expect(output).toContain("Current state: expressed");
    expect(output).toContain("No autonomous work is claimed");
  });

  it("grounds a desire with an available model and attributes the interpretation", async () => {
    const sent: string[] = [];
    const command = desireCommand({
      db,
      getEntity: (id) => engine.entities.get(id as EntityId),
      captureCognition: true,
      interpretDesire: async (_expression, _context) =>
        "You want a reversible decision. First compare the options against your constraints.",
    });
    await command.handler(
      {
        send: (_target: EntityId, message: string) => sent.push(stripAnsi(message)),
      } as unknown as RoomContext,
      {
        raw: "desire Choose a reversible direction",
        verb: "desire",
        args: "Choose a reversible direction",
        tokens: ["Choose", "a", "reversible", "direction"],
        entity: alice.entity!,
        room: roomId("test/start"),
      },
    );

    const journey = db.getLatestJourneyForRequester(alice.entity!)!;
    const events = db.listJourneyEvents(journey.id);
    expect(events.map((event) => event.kind)).toEqual(["grounding", "result"]);
    expect(events[0]?.actor_name).toBe("Marina model");
    expect(sent.join("\n")).toContain("Marina's initial understanding");
    expect(sent.join("\n")).toContain("First useful result (partial)");
    expect(JSON.parse(events[1]!.data_json)).toMatchObject({ partial: true, initial: true });
    const cognition = db.listCognitiveEvents({ journeyId: journey.id });
    expect(cognition.map((event) => event.kind)).toEqual(["output", "input"]);
    expect(JSON.parse(cognition[0]!.parent_ids_json)).toEqual([cognition[1]!.id]);
  });

  it("waits on one consequential model question instead of inventing a result", async () => {
    const sent: string[] = [];
    const command = desireCommand({
      db,
      getEntity: (id) => engine.entities.get(id as EntityId),
      interpretDesire: async () =>
        JSON.stringify({
          understanding: "You want to choose a place to live.",
          kind: "question",
          text: "Which people must the decision work for?",
        }),
    });
    await command.handler(
      {
        send: (_target: EntityId, message: string) => sent.push(stripAnsi(message)),
      } as unknown as RoomContext,
      {
        raw: "desire Choose where to live",
        verb: "desire",
        args: "Choose where to live",
        tokens: ["Choose", "where", "to", "live"],
        entity: alice.entity!,
        room: roomId("test/start"),
      },
    );

    const journey = db.getLatestJourneyForRequester(alice.entity!)!;
    expect(db.listJourneyEvents(journey.id).map((event) => event.kind)).toEqual([
      "grounding",
      "waiting",
    ]);
    expect(sent.join("\n")).toContain(
      "One material question: Which people must the decision work for?",
    );
  });

  it("records steering without rewriting the original desire", () => {
    engine.processCommand(alice.entity!, "desire Explore a possible relocation");
    const journey = db.getLatestJourneyForRequester(alice.entity!)!;

    engine.processCommand(
      alice.entity!,
      "journey steer latest Prioritize school access over commute time",
    );

    expect(db.getJourney(journey.id)?.expression).toBe("Explore a possible relocation");
    expect(db.listJourneyEvents(journey.id)[0]?.kind).toBe("interpretation");
    expect(stripAnsi(alice.lastText())).toContain("original desire remains unchanged");
  });

  it("projects meaningful progress with attributed evidence", () => {
    engine.processCommand(alice.entity!, "desire Compare two strategies");
    engine.processCommand(
      bob.entity!,
      `journey record ${db.getLatestJourneyForRequester(alice.entity!)!.id} challenge | The cost assumption is disputed`,
    );

    alice.clear();
    engine.processCommand(alice.entity!, "journey progress latest");
    const output = stripAnsi(alice.lastText());
    expect(output).toContain("The cost assumption is disputed");
    expect(output).toContain("Bob · journey_event:");
  });

  it("projects the current result with its canonical record and dissent", () => {
    engine.processCommand(alice.entity!, "desire Reach an evidence-backed recommendation");
    const noteId = db.createNote("Alice", "Choose the reversible path", "test/start", {
      verificationStatus: "verified",
    });
    engine.processCommand(
      alice.entity!,
      `journey record latest result | Choose the reversible path | note:${noteId}`,
    );
    engine.processCommand(
      bob.entity!,
      `journey record ${db.getLatestJourneyForRequester(alice.entity!)!.id} challenge | The evidence covers only one quarter`,
    );

    alice.clear();
    engine.processCommand(alice.entity!, "journey result latest");
    const output = stripAnsi(alice.lastText());
    expect(output).toContain("Result: Choose the reversible path");
    expect(output).toContain(`Canonical record: note:${noteId}`);
    expect(output).toContain("Record status: verified");
    expect(output).toContain("The evidence covers only one quarter");
  });

  it("reports the absence of a result without inventing failure", () => {
    engine.processCommand(alice.entity!, "desire Investigate an unanswered question");
    alice.clear();
    engine.processCommand(alice.entity!, "journey result latest");

    const output = stripAnsi(alice.lastText());
    expect(output).toContain("No result has been recorded or submitted yet");
    expect(output).toContain("not a failure claim");
  });

  it("reports only changes since each participant last looked", () => {
    engine.processCommand(alice.entity!, "desire Track a changing question");
    const journey = db.getLatestJourneyForRequester(alice.entity!)!;
    engine.processCommand(
      bob.entity!,
      `journey record ${journey.id} evidence | The first source arrived`,
    );

    alice.clear();
    engine.processCommand(alice.entity!, "journey changes latest");
    expect(stripAnsi(alice.lastText())).toContain("The first source arrived");

    alice.clear();
    engine.processCommand(alice.entity!, "journey changes latest");
    expect(stripAnsi(alice.lastText())).toContain("Nothing meaningfully changed");

    engine.processCommand(
      bob.entity!,
      `journey record ${journey.id} result | A provisional answer now exists`,
    );
    alice.clear();
    engine.processCommand(alice.entity!, "journey changes latest");
    const output = stripAnsi(alice.lastText());
    expect(output).toContain("A provisional answer now exists");
    expect(output).toContain("Current result: A provisional answer now exists");
  });

  it("exposes cognitive provenance status and chain verification", () => {
    db.appendCognitiveEvent({
      kind: "creation",
      actorId: alice.entity!,
      payload: { ref: "artifact:test" },
    });

    engine.processCommand(alice.entity!, "provenance status");
    expect(stripAnsi(alice.lastText())).toContain("Cognitive provenance");
    expect(stripAnsi(alice.lastText())).toContain("Events: 1");

    alice.clear();
    engine.processCommand(alice.entity!, "provenance verify");
    expect(stripAnsi(alice.lastText())).toContain("Verified 1 cognitive events");
  });

  it("captures canonical command actions only when cognitive provenance is enabled", () => {
    const previous = process.env.MARINA_COGNITIVE_PROVENANCE;
    try {
      delete process.env.MARINA_COGNITIVE_PROVENANCE;
      engine.processCommand(alice.entity!, "look");
      expect(db.listCognitiveEvents()).toHaveLength(0);

      process.env.MARINA_COGNITIVE_PROVENANCE = "true";
      engine.processCommand(alice.entity!, "recall evidence");
      expect(db.listCognitiveEvents().map((event) => event.kind)).toEqual([
        "memory_influence",
        "input",
      ]);
    } finally {
      if (previous === undefined) delete process.env.MARINA_COGNITIVE_PROVENANCE;
      else process.env.MARINA_COGNITIVE_PROVENANCE = previous;
    }
  });
});
