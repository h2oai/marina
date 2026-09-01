// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = `/tmp/marina-final-phases-${process.pid}.db`;
const previousKey = process.env.MARINA_FEDERATION_SIGNING_KEY;
describe("phases 11-13", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
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
    cleanupDb(TEST_DB);
    if (previousKey === undefined) delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    else process.env.MARINA_FEDERATION_SIGNING_KEY = previousKey;
  });
  it("records signed asset-neutral settlement with causal contribution and dispute history", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    engine.processCommand(
      alice.entity!,
      `economy adapter usdc-base | stablecoin | base | reference | https://explorer.example | secret:external`,
    );
    engine.processCommand(
      alice.entity!,
      `economy contract journey:1 | {"deliverable":"report"} | two independent verifiers | arbitration:mesh | usdc-base | asset:USDC`,
    );
    const contract = db.listEconomicContracts()[0]!;
    engine.processCommand(
      alice.entity!,
      `economy event ${contract.id} contribution | intellect:lumen | artifact:report |  |  |  | trace:7,note:3 | {"provider":"model:x"}`,
    );
    engine.processCommand(
      alice.entity!,
      `economy event ${contract.id} dispute | human:bob | artifact:report |  |  | case:44 | economic_event:first | {"reason":"prior art"}`,
    );
    engine.processCommand(
      alice.entity!,
      `economy event ${contract.id} settlement | escrow:base | human:alice | 25.00 | asset:USDC | base:0xabc | artifact:report | {"observed":true}`,
    );
    const events = db.listEconomicEvents(contract.id);
    expect(events.map((e) => e.kind)).toEqual(["offer", "contribution", "dispute", "settlement"]);
    expect(events[3]?.external_ref).toBe("base:0xabc");
    expect(db.verifyEconomicEvent(events[0]!).valid).toBe(true);
    expect(db.verifyEconomicEvent(events[3]!).valid).toBe(true);
    expect(db.listEconomicAdapters()[0]?.configuration_ref).toBe("secret:external");
  });
  it("remains useful without an asset or adapter", () => {
    engine.processCommand(
      alice.entity!,
      `economy contract journey:local | {"deliverable":"shared note"} | peer review | conversation`,
    );
    expect(db.listEconomicContracts()[0]).toMatchObject({
      asset_ref: null,
      settlement_adapter: null,
    });
    alice.clear();
    engine.processCommand(alice.entity!, "economy list");
    expect(stripAnsi(alice.lastText())).toContain("unfunded");
  });
  it("rolls back a contract when its configured signature cannot be created", () => {
    process.env.MARINA_FEDERATION_SIGNING_KEY = "not-a-private-key";
    expect(() =>
      db.createEconomicContract({
        id: "contract_atomic",
        goalRef: "journey:atomic",
        terms: { deliverable: "proof" },
        verificationMethod: "review",
        disputeMethod: "appeal",
        createdBy: "alice",
      }),
    ).toThrow();
    expect(db.getEconomicContract("contract_atomic")).toBeUndefined();
  });
  it("distinguishes replay levels, forks counterfactuals, and builds inspectable comparison datasets", () => {
    engine.processCommand(
      alice.entity!,
      `lab manifest {"world":"research","population":["intellect:a"],"links":["experiment:1","trace:seed"]}`,
    );
    const manifest = db.listSimulationManifests()[0]!;
    engine.processCommand(
      alice.entity!,
      `lab run ${manifest.hash} | recorded | recorded-response | seed-a | {"memory":"graph"}`,
    );
    const parent = db.listSimulationRuns()[0]!;
    engine.processCommand(
      alice.entity!,
      `lab event ${parent.id} observation | trace:7 | {"result":"baseline"}`,
    );
    engine.processCommand(
      alice.entity!,
      `lab fork ${parent.id} | event:decision-2 | {"memory":"private"} | seed-b`,
    );
    engine.processCommand(
      alice.entity!,
      `lab replicate ${manifest.hash} | synthetic | statistical | 3 | sweep | {"population":20}`,
    );
    const runs = db.listSimulationRuns();
    expect(runs).toHaveLength(5);
    const child = runs.find((r) => r.parent_run_id === parent.id)!;
    expect(child.fork_point_ref).toBe("event:decision-2");
    engine.processCommand(
      alice.entity!,
      `lab compare ${parent.id},${child.id} | did memory alter diffusion | {"diffusion":"observed"} | conditional difference only`,
    );
    const comparison = db.listSimulationComparisons()[0]!;
    // The dataset references runs by id (v2) — runs/events stay in their own
    // append-only tables rather than being embedded per comparison.
    const dataset = JSON.parse(comparison.dataset_json);
    expect(dataset.schema).toBe("marina.simulation.comparison.v2");
    expect(dataset.runRefs).toHaveLength(2);
    expect(JSON.parse(comparison.run_ids_json)).toHaveLength(2);
    expect(new Set(runs.map((r) => r.reproducibility))).toEqual(
      new Set(["recorded-response", "statistical"]),
    );
  });
  it("rejects incoherent simulation ancestry and comparison membership at the persistence boundary", () => {
    const first = db.createSimulationManifest({ manifest: { world: "first" }, createdBy: "alice" });
    const second = db.createSimulationManifest({
      manifest: { world: "second" },
      createdBy: "alice",
    });
    const parent = db.createSimulationRun({
      manifestHash: first.hash,
      mode: "synthetic",
      reproducibility: "statistical",
      createdBy: "alice",
    });
    expect(() =>
      db.createSimulationRun({
        manifestHash: second.hash,
        mode: "synthetic",
        reproducibility: "statistical",
        parentRunId: parent.id,
        forkPointRef: "event:1",
        createdBy: "alice",
      }),
    ).toThrow("retain its parent's manifest");
    expect(() =>
      db.createSimulationRun({
        manifestHash: first.hash,
        mode: "synthetic",
        reproducibility: "statistical",
        parentRunId: parent.id,
        createdBy: "alice",
      }),
    ).toThrow("fork-point");
    expect(() =>
      db.createSimulationComparison({
        runIds: [parent.id, "simulation_missing"],
        questions: [],
        measures: {},
        interpretation: "invalid fixture",
        dataset: {},
        createdBy: "alice",
      }),
    ).toThrow("does not exist");
  });
  it("records mutations in open domains and recursively derives a new genome", () => {
    const parent = db.createMarinaGenome({
      manifest: { worldTemplate: "default", reproduction: { method: "fork" } },
      createdBy: "Alice",
    });
    engine.processCommand(
      alice.entity!,
      `mutation record association association:odd | adopted | participants invented symbiosis | {"semantics":"mutual-dreaming"} |  | observation:9 | association:new`,
    );
    engine.processCommand(
      alice.entity!,
      `mutation genome ${parent.hash} | reproduction now permits recombination | {"reproduction":{"method":"recombination"}} | experiment:12`,
    );
    const rows = db.listCivilizationMutations();
    expect(rows).toHaveLength(2);
    const genomeMutation = rows.find((r) => r.domain === "reproduction")!;
    expect(genomeMutation.descendant_ref).toStartWith("genome:sha256:");
    const childHash = genomeMutation.descendant_ref!.slice("genome:".length);
    expect(JSON.parse(db.getMarinaGenome(childHash)!.manifest_json).reproduction).toEqual({
      method: "recombination",
    });
    expect(db.getMarinaGenome(parent.hash)).toBeDefined();
  });
  it("requires mutation ancestry to identify existing, distinct parents", () => {
    const parent = db.appendCivilizationMutation({
      id: "mutation_parent",
      domain: "charter",
      targetRef: "charter:local",
      summary: "initial proposal",
      patch: { value: 1 },
      disposition: "proposed",
      createdBy: "alice",
    });
    expect(() =>
      db.appendCivilizationMutation({
        domain: "charter",
        targetRef: "charter:local",
        summary: "missing ancestry",
        patch: {},
        parentIds: ["mutation_missing"],
        disposition: "adopted",
        createdBy: "alice",
      }),
    ).toThrow("does not exist");
    expect(() =>
      db.appendCivilizationMutation({
        domain: "charter",
        targetRef: "charter:local",
        summary: "duplicate ancestry",
        patch: {},
        parentIds: [parent.id, parent.id],
        disposition: "adopted",
        createdBy: "alice",
      }),
    ).toThrow("must be unique");
    expect(() =>
      db.appendCivilizationMutation({
        id: "mutation_self",
        domain: "charter",
        targetRef: "charter:local",
        summary: "cyclic ancestry",
        patch: {},
        parentIds: ["mutation_self"],
        disposition: "adopted",
        createdBy: "alice",
      }),
    ).toThrow("own parent");
  });
});
