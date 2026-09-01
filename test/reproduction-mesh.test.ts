// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const DB_A = `/tmp/marina-reproduction-a-${process.pid}.db`;
const DB_B = `/tmp/marina-reproduction-b-${process.pid}.db`;
const previousKey = process.env.MARINA_FEDERATION_SIGNING_KEY;

describe("cognitive and Marina reproduction", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(DB_A);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    alice = new MockConnection("alice");
    engine.addConnection(alice);
    engine.spawnEntity("alice", "Alice");
    alice.clear();
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(DB_A);
    cleanupDb(DB_B);
    if (previousKey === undefined) delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    else process.env.MARINA_FEDERATION_SIGNING_KEY = previousKey;
  });

  it("creates an independently usable intellect from selectively attributed components", () => {
    const parent = db.createIntellect({
      displayName: "Parent",
      originMarina: "test",
      createdBy: "Alice",
    });
    engine.processCommand(
      alice.entity!,
      `reproduce intellect ${parent.id} | Specialist | Test a cheaper divergent self | [{"kind":"model","ref":"local/small","disposition":"introduced"},{"kind":"memory","ref":"pool:tradition","disposition":"inherited"},{"kind":"personality","ref":"skeptical","disposition":"mutated","sourceRef":"curious"}] | Alice | experiment:7`,
    );
    const reproduction = db.listCognitiveReproductions()[0]!;
    const child = db.getIntellect(reproduction.descendant_intellect_id)!;
    expect(child.display_name).toBe("Specialist");
    expect(child.id).not.toBe(parent.id);
    expect(db.listReproductionComponents(reproduction.id)).toHaveLength(3);
    expect(db.listIntellectInstances(child.id)[0]?.model_ref).toBe("local/small");
  });

  it("content-addresses identical genomes and records selective sovereign descent", () => {
    const manifest = { worldTemplate: "research", components: ["role:critic", "score:debate"] };
    const first = db.createMarinaGenome({ manifest, createdBy: "Alice" });
    const second = db.createMarinaGenome({ manifest, createdBy: "Bob" });
    expect(second.hash).toBe(first.hash);
    const descendant = db.createMarinaDescendant({
      name: "Odd-Lab",
      genomeHash: first.hash,
      parentWorldIds: [db.getOrCreateWorldId(), "world:other"],
      mode: "recombination",
      excludedComponents: ["market:default"],
      mutations: ["memory:graph"],
      createdBy: "Alice",
    });
    expect(descendant.genome_hash).toBe(first.hash);
    expect(JSON.parse(descendant.parent_world_ids_json)).toHaveLength(2);
  });
});

describe("transparent multi-mesh federation", () => {
  afterEach(() => {
    cleanupDb(DB_A);
    cleanupDb(DB_B);
    if (previousKey === undefined) delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    else process.env.MARINA_FEDERATION_SIGNING_KEY = previousKey;
  });

  it("replicates a signed event between sovereign Marinas and retains an independent witness", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const a = new MarinaDB(DB_A);
    const b = new MarinaDB(DB_B);
    a.createMesh({
      id: "mesh:open-science",
      name: "Open Science",
      charterRef: "charter:v1",
      protocol: "transparent.v1",
      createdBy: "world-a",
    });
    b.createMesh({
      id: "mesh:open-science",
      name: "Open Science",
      charterRef: "charter:v1",
      protocol: "transparent.v1",
      createdBy: "world-b",
    });
    a.appendMeshMembershipEvent({
      meshId: "mesh:open-science",
      worldId: "world-a",
      kind: "joined",
      actorId: "world-a",
    });
    b.appendMeshMembershipEvent({
      meshId: "mesh:open-science",
      worldId: "world-b",
      kind: "joined",
      actorId: "world-b",
    });
    const original = a.appendMeshEvent({
      meshId: "mesh:open-science",
      originWorldId: "world-a",
      kind: "result",
      payload: { claim: "unexpected" },
    });
    const replica = b.importMeshEvent(a.exportMeshEvent(original));
    b.witnessMeshEvent({
      meshId: replica.mesh_id,
      eventId: replica.id,
      witnessWorldId: "world-b",
      observation: "replicated",
    });
    expect(b.verifyMeshEvent(replica).valid).toBe(true);
    expect(b.listMeshWitnesses("mesh:open-science")[0]).toMatchObject({
      event_id: original.id,
      witness_world_id: "world-b",
      observation: "replicated",
    });
    a.appendMeshMembershipEvent({
      meshId: "mesh:open-science",
      worldId: "world-a",
      kind: "left",
      actorId: "world-a",
    });
    expect(b.listMeshEvents("mesh:open-science")).toHaveLength(1);
    a.close();
    b.close();
  });

  it("refuses unsigned replication by default and leaves no row behind", () => {
    delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    const a = new MarinaDB(DB_A);
    const b = new MarinaDB(DB_B);
    a.createMesh({
      id: "mesh:quiet",
      name: "Quiet",
      charterRef: "charter:v1",
      protocol: "transparent.v1",
      createdBy: "world-a",
    });
    b.createMesh({
      id: "mesh:quiet",
      name: "Quiet",
      charterRef: "charter:v1",
      protocol: "transparent.v1",
      createdBy: "world-b",
    });
    const original = a.appendMeshEvent({
      meshId: "mesh:quiet",
      originWorldId: "world-a",
      kind: "result",
      payload: { claim: "unsigned" },
    });
    const token = a.exportMeshEvent(original);
    expect(() => b.importMeshEvent(token)).toThrow(/unsigned/i);
    expect(b.listMeshEvents("mesh:quiet")).toHaveLength(0);
    // Explicit opt-in accepts unsigned events.
    process.env.MARINA_FEDERATION_ALLOW_UNSIGNED = "true";
    try {
      expect(b.importMeshEvent(token).id).toBe(original.id);
    } finally {
      delete process.env.MARINA_FEDERATION_ALLOW_UNSIGNED;
    }
    a.close();
    b.close();
  });

  it("refuses replication into the wrong mesh before any row is written", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const a = new MarinaDB(DB_A);
    a.createMesh({
      id: "mesh:alpha",
      name: "Alpha",
      charterRef: "c",
      protocol: "p",
      createdBy: "x",
    });
    const original = a.appendMeshEvent({
      meshId: "mesh:alpha",
      originWorldId: "world-a",
      kind: "result",
      payload: { claim: "x" },
    });
    const token = a.exportMeshEvent(original);
    const b = new MarinaDB(DB_B);
    b.createMesh({ id: "mesh:beta", name: "Beta", charterRef: "c", protocol: "p", createdBy: "y" });
    expect(() => b.importMeshEvent(token, { expectedMeshId: "mesh:beta" })).toThrow(
      /another mesh/i,
    );
    expect(b.listMeshEvents("mesh:alpha")).toHaveLength(0);
    expect(b.listMeshEvents("mesh:beta")).toHaveLength(0);
    a.close();
    b.close();
  });

  it("enforces the operator trust anchor: blocked origins and pinned-key mismatches are refused", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const a = new MarinaDB(DB_A);
    a.createMesh({ id: "mesh:t", name: "T", charterRef: "c", protocol: "p", createdBy: "x" });
    const original = a.appendMeshEvent({
      meshId: "mesh:t",
      originWorldId: "world-a",
      kind: "result",
      payload: { claim: "x" },
    });
    const token = a.exportMeshEvent(original);
    const b = new MarinaDB(DB_B);
    b.createMesh({ id: "mesh:t", name: "T", charterRef: "c", protocol: "p", createdBy: "y" });

    // Blocked peer is refused regardless of a valid signature.
    b.upsertFederationPeer({
      worldId: "world-a",
      name: "World A",
      baseUrl: "https://a.example",
      manifest: {},
    });
    b.setFederationTrust("world-a", "blocked");
    expect(() => b.importMeshEvent(token)).toThrow(/blocked/i);

    // A pinned key that doesn't match the signing key is refused.
    const otherKey = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    b.setFederationTrust("world-a", "unverified");
    b.upsertFederationPeer({
      worldId: "world-a",
      name: "World A",
      baseUrl: "https://a.example",
      publicKey: otherKey,
      manifest: {},
    });
    expect(() => b.importMeshEvent(token)).toThrow(/does not verify/i);
    expect(b.listMeshEvents("mesh:t")).toHaveLength(0);
    a.close();
    b.close();
  });

  it("supports overlapping meshes and explicit translators without merging governance", () => {
    const db = new MarinaDB(DB_A);
    db.createMesh({ id: "mesh:a", name: "A", charterRef: "a", protocol: "alpha", createdBy: "x" });
    db.createMesh({ id: "mesh:b", name: "B", charterRef: "b", protocol: "beta", createdBy: "x" });
    db.appendMeshMembershipEvent({
      meshId: "mesh:a",
      worldId: "world:x",
      kind: "joined",
      actorId: "x",
    });
    db.appendMeshMembershipEvent({
      meshId: "mesh:b",
      worldId: "world:x",
      kind: "joined",
      actorId: "x",
    });
    const translation = db.createMeshTranslation({
      sourceMeshId: "mesh:a",
      targetMeshId: "mesh:b",
      translatorRef: "intellect:polyglot",
      protocolMap: { result: "finding" },
      actorId: "x",
    });
    expect(db.listMeshes()).toHaveLength(2);
    expect(translation.protocol_map_json).toBe('{"result":"finding"}');
    db.close();
  });
});
