// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = `/tmp/marina-association-${process.pid}.db`;
const previousKey = process.env.MARINA_FEDERATION_SIGNING_KEY;

describe("generalized association", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("alice");
    engine.addConnection(alice);
    engine.spawnEntity("alice", "Alice");
    alice.clear();
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
    if (previousKey === undefined) delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    else process.env.MARINA_FEDERATION_SIGNING_KEY = previousKey;
  });

  it("accepts unexpected subject kinds and arbitrary relationship semantics", () => {
    engine.processCommand(
      alice.entity!,
      "association create Strange Loop | Discover useful, spurious connections",
    );
    const association = db.listAssociations()[0]!;
    engine.processCommand(
      alice.entity!,
      `association join ${association.id} | dream-cartographer:delta | maps intuitions`,
    );
    engine.processCommand(
      alice.entity!,
      `association relate ${association.id} | dream-cartographer:delta | directed | translates dreams into market counterfactuals | market:weather-2040 | {"cadence":"whenever useful"}`,
    );

    const projection = db.projectAssociation(association.id);
    expect(projection.participants[0]).toMatchObject({
      kind: "dream-cartographer",
      ref: "delta",
      active: true,
      role: "maps intuitions",
    });
    expect(projection.relations[0]).toMatchObject({
      semantics: "translates dreams into market counterfactuals",
      direction: "directed",
    });
    expect(JSON.parse(projection.relations[0]!.terms_json)).toEqual({
      cadence: "whenever useful",
    });
  });

  it("allows departure and dissolution without erasing history", () => {
    engine.processCommand(
      alice.entity!,
      "association create Temporary Constellation | Learn briefly",
    );
    const association = db.listAssociations()[0]!;
    engine.processCommand(
      alice.entity!,
      `association join ${association.id} | intellect:lumen | divergent critic`,
    );
    engine.processCommand(
      alice.entity!,
      `association leave ${association.id} | intellect:lumen | work complete`,
    );
    engine.processCommand(
      alice.entity!,
      `association event ${association.id} dissolved | participants chose separate paths`,
    );

    const events = db.listAssociationEvents(association.id);
    expect(events.map((event) => event.kind)).toEqual(["created", "joined", "left", "dissolved"]);
    expect(db.projectAssociation(association.id)).toMatchObject({
      active: false,
      participants: [{ kind: "intellect", ref: "lumen", active: false }],
    });
  });

  it("links canonical Marina primitives without replacing them", () => {
    engine.processCommand(alice.entity!, "association create Assembly | Coordinate existing work");
    const association = db.listAssociations()[0]!;
    for (const ref of [
      "channel:research",
      "group:observers",
      "crew:red-team",
      "project:alpha",
      "score:deliberation",
      "market:forecast-1",
    ]) {
      engine.processCommand(
        alice.entity!,
        `association link ${association.id} | ${ref} | remains canonical execution surface`,
      );
    }
    expect(db.listAssociationLinks(association.id).map((row) => row.kind)).toEqual([
      "channel",
      "group",
      "crew",
      "project",
      "score",
      "market",
    ]);
  });

  it("supersedes relation claims without mutating the original", () => {
    engine.processCommand(alice.entity!, "association create Mutable Terms | Let structure evolve");
    const association = db.listAssociations()[0]!;
    engine.processCommand(
      alice.entity!,
      `association relate ${association.id} | human:alice | directed | mentors | intellect:lumen`,
    );
    const original = db.listAssociationRelations(association.id)[0]!;
    engine.processCommand(
      alice.entity!,
      `association revise ${association.id} | ${original.id} | human:alice | reciprocal | learns beside | intellect:lumen`,
    );

    const history = db.listAssociationRelations(association.id);
    expect(history).toHaveLength(2);
    expect(history[1]?.supersedes_id).toBe(original.id);
    expect(db.projectAssociation(association.id).relations.map((row) => row.semantics)).toEqual([
      "learns beside",
    ]);
  });

  it("signs and independently verifies events, relations, and links", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const association = db.createAssociation({
      name: "Witnessed",
      createdBy: "Alice",
    });
    const relation = db.declareAssociationRelation({
      associationId: association.id,
      sourceKind: "marina",
      sourceRef: "one",
      targetKind: "mesh",
      targetRef: "many",
      semantics: "witnesses without governing",
      direction: "directed",
      actorId: "Alice",
    });
    const link = db.linkAssociation({
      associationId: association.id,
      kind: "project",
      ref: "phase-7",
      relationship: "tests",
      actorId: "Alice",
    });

    expect(db.verifyAssociationEvent(db.listAssociationEvents(association.id)[0]!).valid).toBe(
      true,
    );
    expect(db.verifyAssociationRelation(relation).valid).toBe(true);
    expect(db.verifyAssociationLink(link).valid).toBe(true);
  });

  it("keeps discovery readable for the simplest user", () => {
    engine.processCommand(alice.entity!, "association create Garden | Shared observation");
    const association = db.listAssociations()[0]!;
    alice.clear();
    engine.processCommand(alice.entity!, `association show ${association.id}`);
    const output = stripAnsi(alice.lastText());
    expect(output).toContain("Association: Garden");
    expect(output).toContain("No participation claims");
    expect(output).toContain("No relation declarations");
  });
});
