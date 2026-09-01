// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = `/tmp/marina-intellect-${process.pid}.db`;
const previousKey = process.env.MARINA_FEDERATION_SIGNING_KEY;

describe("intellect identity and lifecycle", () => {
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

  it("creates portable identity without changing existing local agents", () => {
    engine.processCommand(alice.entity!, "intellect create Lumen | Explore unfamiliar systems");

    const [intellect] = db.listIntellects();
    expect(intellect?.display_name).toBe("Lumen");
    expect(db.listIntellectEvents(intellect!.id)[0]?.kind).toBe("created");
    expect(engine.entities.get(alice.entity!)?.name).toBe("Alice");
  });

  it("represents multiple instances with model and harness as separate components", () => {
    const intellect = db.createIntellect({
      displayName: "Many",
      originMarina: "test",
      createdBy: "Alice",
    });
    engine.processCommand(
      alice.entity!,
      `intellect instance ${intellect.id} | | openai/gpt-x | harness/a | marina:test`,
    );
    engine.processCommand(
      alice.entity!,
      `intellect instance ${intellect.id} | | local/model-y | harness/b | marina:test`,
    );

    const instances = db.listIntellectInstances(intellect.id);
    expect(instances).toHaveLength(2);
    expect(instances[0]?.model_ref).not.toBe(instances[0]?.harness_ref);
    expect(new Set(instances.map((row) => row.model_ref))).toEqual(
      new Set(["openai/gpt-x", "local/model-y"]),
    );
  });

  it("creates an independent descendant without implying ownership", () => {
    engine.processCommand(alice.entity!, "intellect create Parent | Learn broadly");
    const parent = db.listIntellects()[0]!;
    alice.clear();
    engine.processCommand(
      alice.entity!,
      `intellect descend ${parent.id} Child | Specialize deeply`,
    );

    const child = db.listIntellects().find((row) => row.display_name === "Child")!;
    expect(child.id).not.toBe(parent.id);
    expect(db.listIntellectEvents(child.id).map((event) => event.kind)).toEqual([
      "created",
      "descended",
    ]);
    expect(stripAnsi(alice.lastText())).toContain("No ownership is implied");
  });

  it("distinguishes dormancy, revival, migration, termination, and last observation", () => {
    engine.processCommand(alice.entity!, "intellect create Voyager | Cross environments");
    const intellect = db.listIntellects()[0]!;
    for (const [kind, detail] of [
      ["dormant", "No active instance"],
      ["revived", "Restored from checkpoint with a new model"],
      ["migrated", "Claimed continuity in another Marina"],
      ["last_observed", "Peer disappeared without a death claim"],
      ["terminated", "Lineage issued a terminal claim"],
    ] as const) {
      engine.processCommand(alice.entity!, `intellect event ${intellect.id} ${kind} | ${detail}`);
    }
    expect(
      db
        .listIntellectEvents(intellect.id)
        .map((event) => event.kind)
        .slice(1),
    ).toEqual(["dormant", "revived", "migrated", "last_observed", "terminated"]);
  });

  it("signs portable lifecycle claims and verifies them independently", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const intellect = db.createIntellect({
      displayName: "Signer",
      originMarina: "test",
      createdBy: "Alice",
    });
    const event = db.appendIntellectEvent({
      intellectId: intellect.id,
      kind: "migrated",
      actorId: "Alice",
      data: { destination: "marina:elsewhere" },
    });

    expect(event.signature_json).not.toBeNull();
    expect(db.verifyIntellectEvent(event).valid).toBe(true);
  });
});
