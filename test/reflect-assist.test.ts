// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerFor } from "../src/agent/standing";
import {
  REFLECTOR_ROLE,
  type ReflectAgentView,
  reflectCommand,
  type SpawnedHelper,
} from "../src/engine/commands/reflect";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import {
  assistanceAdoptionUrl,
  awaitPendingBridges,
  findDurableTwin,
  findLegacyNotesForRecord,
} from "../src/memory/legacy-bridge";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryAssistanceJob, MemoryAssistancePage } from "../src/sdk/memory-assistance";
import type { MemoryRecord } from "../src/sdk/memory-types";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("reflect as a thin verb over the memory-reflector helper", () => {
  let directory: string;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let helper: MockConnection;

  const durable = (name: string, request: Parameters<typeof residentMemoryOperation>[2]) =>
    residentMemoryOperation(db, name, request);
  const run = async (connection: MockConnection, text: string) => {
    connection.clear();
    await engine.processCommand(connection.entity as EntityId, text);
    // `note` bridges its durable twin in the background; sequence on it.
    await awaitPendingBridges();
    return stripAnsi(connection.allTextJoined());
  };
  const reflectionNotes = (name: string) =>
    db.getNotesByEntity(name, 100).filter((n) => n.tier === "reflection");
  const ownJobs = async () =>
    (
      (await durable("Alice", { operation: "assist_jobs", input: {} }))
        .result as MemoryAssistancePage
    ).jobs;

  /** The helper's side of the protocol, driven through the same resident binding it would use. */
  async function answerJob(
    jobId: string,
    citedRecordId: string,
    answer: string,
    quote: string,
  ): Promise<MemoryAssistanceJob> {
    const job = (await durable("Reflector", { operation: "assist_get", id: jobId }))
      .result as MemoryAssistanceJob;
    const claim = (
      await durable("Reflector", { operation: "assist_claim", id: jobId, key: `claim-${jobId}` })
    ).result as { lease_token: string };
    const read = (
      await durable("Reflector", {
        operation: "assist_read",
        id: jobId,
        key: `read-${jobId}`,
        input: {
          lease_token: claim.lease_token,
          request: { operation: "get", id: citedRecordId },
        },
      })
    ).result as MemoryRecord;
    await durable("Reflector", {
      operation: "assist_finish",
      id: jobId,
      key: `finish-${jobId}`,
      input: {
        lease_token: claim.lease_token,
        completion: {
          status: "answered",
          answer,
          citations: [
            {
              kind: "record",
              space_id: job.space_id,
              id: citedRecordId,
              version: read.version,
              quote,
            },
          ],
        },
      },
    });
    return (await durable("Alice", { operation: "assist_get", id: jobId }))
      .result as MemoryAssistanceJob;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-reflect-assist-"));
    db = new MarinaDB(join(directory, "world.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("alice");
    helper = new MockConnection("reflector");
    for (const [connection, name] of [
      [alice, "Alice"],
      [helper, "Reflector"],
    ] as const) {
      db.createUser({ id: crypto.randomUUID(), name });
      engine.addConnection(connection);
      engine.spawnEntity(connection.id, name);
    }
  });

  afterEach(() => {
    resetTrustProfileForTests();
    delete process.env.MARINA_AUTONOMY;
    db.close();
    rmSync(directory, { recursive: true });
  });

  /** Re-register `reflect` with a fake runtime seam (no real LLM, no real spawn). */
  function wireReflect(deps: {
    listAgents?: () => ReflectAgentView[];
    helpersAvailable?: () => boolean;
    spawnHelper?: (role: string, requestedBy: string) => Promise<SpawnedHelper | undefined>;
  }) {
    engine.commands.registerBuiltin(
      reflectCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db,
        logEvent: (event) => engine.logEvent(event),
        ...deps,
      }),
    );
  }
  /** A fake spawn: the helper "joins" by getting a world account, as the runtime's login would. */
  function fakeSpawner(name = "AutoReflector") {
    const calls: { role: string; requestedBy: string }[] = [];
    const spawnHelper = async (role: string, requestedBy: string): Promise<SpawnedHelper> => {
      calls.push({ role, requestedBy });
      const principalId = crypto.randomUUID();
      if (!db.getUserByName(name)) db.createUser({ id: principalId, name });
      return { name, principalId: db.getUserByName(name)!.id };
    };
    return { calls, spawnHelper };
  }

  it("falls back to the deterministic template with a spawn hint when no reflector exists", async () => {
    for (let i = 0; i < 3; i++) await run(alice, `note Amber deploy observation ${i} !8`);
    const reply = await run(alice, "reflect");
    expect(reply).toContain("Reflection Created");
    expect(reply).toContain("memory-reflector");
    expect(reflectionNotes("Alice")).toHaveLength(1);
    expect(await ownJobs()).toEqual([]);
  });

  it("`reflect --template` and `reflect template` are always the legacy synthesis, without the hint", async () => {
    for (let i = 0; i < 3; i++) await run(alice, `note Copper wiring lesson ${i} !8`);
    // Even with a helper available, template is explicit and deterministic.
    db.saveAgentConfig({
      name: "Reflector",
      model: "marina/default",
      role: "memory-reflector",
      spawnedBy: "Alice",
    });
    const flagged = await run(alice, "reflect --template copper");
    expect(flagged).toContain("Reflection Created");
    expect(flagged).toContain('Synthesis on "copper"');
    expect(flagged).not.toContain("memory-reflector");
    const worded = await run(alice, "reflect template");
    expect(worded).toContain("Reflection Created");
    expect(worded).not.toContain("memory-reflector");
    expect(await ownJobs()).toEqual([]);
    expect(reflectionNotes("Alice")).toHaveLength(2);
  });

  it("keeps `reflect failure <description>` working", async () => {
    await run(alice, "note The relay dropped packets under load !7");
    const reply = await run(alice, "reflect failure relay timed out during load test");
    expect(reply).toContain("Failure Reflection Created");
    const [note] = reflectionNotes("Alice");
    expect(note?.content).toContain("[Failure Analysis] relay timed out during load test");
  });

  it("files a reflector job against the caller's space, then adopts the cited answer into both silos idempotently", async () => {
    await run(alice, "note Amber deploys on port 7419 importance 8 type fact");
    await run(alice, "note Amber rollbacks need the previous manifest importance 7 type fact");
    const [manifestNote, portNote] = db.getNotesByEntity("Alice", 2);
    const portTwin = findDurableTwin(db, portNote!.id)!;
    expect(portTwin).toBeDefined();

    // Requester files the job explicitly by helper name.
    const requested = await run(alice, "reflect via Reflector amber");
    expect(requested).toContain("Reflection Requested");
    expect(requested).toContain("Reflector");
    const jobId = requested.match(/Job (\S+)/)![1]!;
    expect(requested).toContain(`reflect adopt ${jobId}`);
    const [job] = await ownJobs();
    expect(job).toMatchObject({
      id: jobId,
      role: "reflector",
      state: "pending",
      worker_id: db.getUserByName("Reflector")!.id,
      requester_id: db.getUserByName("Alice")!.id,
      remaining_operations: 32,
    });
    expect(job!.deadline - job!.created_at).toBe(10 * 60 * 1000);
    // The task text lives on the durable request source; the list view omits it.
    const detail = (await durable("Alice", { operation: "assist_get", id: jobId }))
      .result as MemoryAssistanceJob;
    expect(detail.task).toContain("Reflect on amber: propose one reusable lesson with citations.");
    expect(detail.task).toContain(`legacy note #${portNote!.id}`);
    expect(detail.task).toContain(`durable record ${portTwin.recordId}`);
    expect(detail.task).toContain("not authority");

    // Adopting before an answer exists changes nothing.
    const early = await run(alice, `reflect adopt ${jobId}`);
    expect(early).toContain("pending");
    expect(reflectionNotes("Alice")).toHaveLength(0);

    // `reflect jobs` is the requester's queue.
    const queued = await run(alice, "reflect jobs");
    expect(queued).toContain(jobId);
    expect(queued).toContain("pending");

    // Helper reads the twin record and answers with a witnessed citation.
    const answer = "Lesson: pin Amber to port 7419 in the manifest so rollbacks stay reachable.";
    const answered = await answerJob(jobId, portTwin.recordId, answer, "port 7419");
    expect(answered.state).toBe("answered");
    const listed = await run(alice, "reflect jobs");
    expect(listed).toContain("answered");
    expect(listed).toContain(`reflect adopt ${jobId}`);

    // Adoption writes the durable record and the legacy reflection, linked both ways.
    const adopted = await run(alice, `reflect adopt ${jobId}`);
    expect(adopted).toContain("Reflection Adopted");
    const reflections = reflectionNotes("Alice");
    expect(reflections).toHaveLength(1);
    const reflection = reflections[0]!;
    expect(reflection.content).toBe(answer);
    expect(reflection.note_type).toBe("episode");
    expect(reflection.importance).toBe(8);
    expect(adopted).toContain(`#${reflection.id}`);

    const partOf = db
      .getNoteLinks(reflection.id)
      .filter((l) => l.relationship === "part_of" && l.target_id === reflection.id)
      .map((l) => l.source_id);
    expect(partOf).toEqual([portNote!.id]);
    expect(partOf).not.toContain(manifestNote!.id);

    const twin = findDurableTwin(db, reflection.id)!;
    expect(twin).toBeDefined();
    expect(adopted).toContain(twin.recordId);
    expect(db.getNoteSources(reflection.id).map((s) => s.url)).toContain(
      assistanceAdoptionUrl(jobId),
    );
    expect(findLegacyNotesForRecord(db, "Alice", twin.recordId).map((n) => n.id)).toEqual([
      reflection.id,
    ]);

    const durableRecord = (await durable("Alice", { operation: "get", id: twin.recordId }))
      .result as MemoryRecord;
    expect(durableRecord.content).toBe(answer);
    expect(durableRecord.tier).toBe("reflection");
    expect(durableRecord.type).toBe("episode");
    expect(durableRecord.metadata).toMatchObject({
      adopted_from_job: jobId,
      helper_id: db.getUserByName("Reflector")!.id,
      proposal_record_id: answered.result_record_id,
    });
    expect(durableRecord.depends_on).toEqual([portTwin.recordId]);
    expect(durableRecord.dependency_versions).toEqual({ [portTwin.recordId]: 1 });
    expect(durableRecord.freshness).toBe("current");
    expect(durableRecord.id).not.toBe(answered.result_record_id);

    // Idempotent: a second adoption returns the same ids and writes nothing new.
    const again = await run(alice, `reflect adopt ${jobId}`);
    expect(again).toContain("already adopted");
    expect(again).toContain(`#${reflection.id}`);
    expect(again).toContain(twin.recordId);
    expect(reflectionNotes("Alice")).toHaveLength(1);
    const records = (await durable("Alice", { operation: "query", input: {} })).result as {
      results: MemoryRecord[];
    };
    expect(records.results.filter((r) => r.content === answer)).toHaveLength(1);
    expect(await run(alice, "reflect jobs")).toContain("adopted");
  });

  it("template reflections inherit the LOWEST authority of their inputs and `--share <pool>` deposits a reflection-tier pool note that pays the author when someone else recalls it", async () => {
    db.createMemoryPool("pool_wisdom", "wisdom", "Alice");
    const bob = new MockConnection("bob");
    db.createUser({ id: crypto.randomUUID(), name: "Bob" });
    engine.addConnection(bob);
    engine.spawnEntity(bob.id, "Bob");

    await run(alice, "note claim Amber deploys need port 7419 open confidence 0.3");
    await run(alice, "note Amber deploys use manifest v2 !8");
    const inputs = db.getNotesByEntity("Alice", 2);
    expect(inputs.map((n) => n.confidence).sort()).toEqual([0.3, 0.5]);

    // Unknown pool: reflection still created, share refused, nothing invented.
    const refused = await run(alice, "reflect --template amber --share nowhere");
    expect(refused).toContain("Reflection Created");
    expect(refused).toContain('Not shared: pool "nowhere" does not exist.');
    expect(db.getPoolNotes("pool_wisdom")).toHaveLength(0);

    const reply = await run(alice, "reflect --template amber --share wisdom");
    expect(reply).toContain("Reflection Created");
    expect(reply).toContain("Authority: confidence=0.30 unverified");
    expect(reply).toContain('Shared to pool "wisdom"');
    const reflection = reflectionNotes("Alice").find((n) => !n.pool_id)!;
    // TMA-NM: min(0.3, 0.5) and unverified because an input is unverified.
    expect(reflection.confidence).toBeCloseTo(0.3, 9);
    expect(reflection.verification_status).toBe("unverified");

    const [shared] = db.getPoolNotes("pool_wisdom");
    expect(shared).toMatchObject({
      entity_name: "Alice",
      tier: "reflection",
      note_type: "episode",
      verification_status: "unverified",
    });
    expect(shared!.confidence).toBeCloseTo(0.3, 9);
    expect(shared!.content).toBe(reflection.content);

    // Generational loop: Bob recalling the shared lesson credits Alice's durable key.
    const aliceKey = db.getUserByName("Alice")!.id;
    expect(ledgerFor(db, aliceKey).filter((r) => r.kind === "reflection_recalled")).toEqual([]);
    const recalled = await run(bob, "pool wisdom recall amber synthesis");
    expect(recalled).toContain("Synthesis");
    expect(ledgerFor(db, aliceKey).filter((r) => r.kind === "reflection_recalled")).toEqual([
      expect.objectContaining({ ref: `reflection:${shared!.id}`, amount: 0.5 }),
    ]);
    // Alice recalling herself earns nothing more.
    await run(alice, "pool wisdom recall amber synthesis");
    expect(ledgerFor(db, aliceKey).filter((r) => r.kind === "reflection_recalled")).toHaveLength(1);
  });

  it("`reflect adopt <job> --share <pool>` inherits the cited twins' lowest authority and shares the lesson", async () => {
    db.createMemoryPool("pool_wisdom", "wisdom", "Alice");
    await run(alice, "note claim Amber deploys on port 7419 confidence 0.4");
    const [portNote] = db.getNotesByEntity("Alice", 1);
    expect(portNote!.confidence).toBeCloseTo(0.4, 9);
    const portTwin = findDurableTwin(db, portNote!.id)!;
    expect(portTwin).toBeDefined();

    const requested = await run(alice, "reflect via Reflector amber --share wisdom");
    expect(requested).toContain("Reflection Requested");
    const jobId = requested.match(/Job (\S+)/)![1]!;
    // The share intent is carried forward in the adopt hint.
    expect(requested).toContain(`reflect adopt ${jobId} --share wisdom`);

    const answer = "Lesson: keep port 7419 pinned in the Amber manifest.";
    await answerJob(jobId, portTwin.recordId, answer, "port 7419");
    const adopted = await run(alice, `reflect adopt ${jobId} --share wisdom`);
    expect(adopted).toContain("Reflection Adopted");
    expect(adopted).toContain("Authority: confidence=0.40 unverified");
    expect(adopted).toContain('Shared to pool "wisdom"');

    const reflection = reflectionNotes("Alice").find((n) => !n.pool_id)!;
    expect(reflection.content).toBe(answer);
    expect(reflection.confidence).toBeCloseTo(0.4, 9);
    expect(reflection.verification_status).toBe("unverified");
    const [shared] = db.getPoolNotes("pool_wisdom");
    expect(shared).toMatchObject({ entity_name: "Alice", tier: "reflection", content: answer });
    expect(shared!.confidence).toBeCloseTo(0.4, 9);

    // Idempotent adoption does not re-share.
    await run(alice, `reflect adopt ${jobId} --share wisdom`);
    expect(db.getPoolNotes("pool_wisdom")).toHaveLength(1);
  });

  it("discovers a live reflector from the runtime roster and from persisted agent configs", async () => {
    await run(alice, "note Grid survey finding one !7");
    await run(alice, "note Grid survey finding two !7");

    // Persisted config fallback (no live roster wired).
    db.saveAgentConfig({
      name: "Reflector",
      model: "marina/default",
      role: "memory-reflector",
      spawnedBy: "Alice",
    });
    const viaConfig = await run(alice, "reflect grid");
    expect(viaConfig).toContain("Reflection Requested");
    expect(viaConfig).not.toContain("Reflection Created");
    expect(await ownJobs()).toHaveLength(1);
    db.deleteAgentConfig("Reflector");

    // Live roster wins when the registry wires `listAgents` (the seam the runtime fills).
    engine.commands.registerBuiltin(
      reflectCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db,
        logEvent: (event) => engine.logEvent(event),
        listAgents: () => [
          { name: "Stopped", role: "memory-reflector", state: "stopped" },
          { name: "Reflector", role: "memory-reflector", state: "autonomous" },
        ],
      }),
    );
    const viaRoster = await run(alice, "reflect grid");
    expect(viaRoster).toContain("Reflection Requested");
    expect(await ownJobs()).toHaveLength(2);
    expect(reflectionNotes("Alice")).toHaveLength(0);
  });

  it("refuses helpers without a durable account and self-reflection, without touching legacy notes", async () => {
    await run(alice, "note Solo observation !8");
    const unknown = await run(alice, "reflect via Nobody solo");
    expect(unknown).toContain("no durable world account");
    const self = await run(alice, "reflect via Alice solo");
    expect(self).toContain("cannot witness yourself");
    expect(await ownJobs()).toEqual([]);
    expect(reflectionNotes("Alice")).toHaveLength(0);
    expect(await run(alice, "reflect adopt")).toContain("Usage: reflect adopt");
    expect(await run(alice, "reflect adopt nope")).toContain("Could not read job nope");
    expect(await run(alice, "reflect jobs")).toContain("No reflector jobs");
  });

  it("template reflections (fallback and --template) get durable twins like `note`", async () => {
    for (let i = 0; i < 3; i++) await run(alice, `note Lantern maintenance observation ${i} !8`);
    await run(alice, "reflect");
    await run(alice, "reflect --template lantern");
    const reflections = reflectionNotes("Alice");
    expect(reflections).toHaveLength(2);
    for (const reflection of reflections) {
      const twin = findDurableTwin(db, reflection.id);
      expect(twin).toBeDefined();
      expect(twin!.version).toBe(1);
      const source = db.getNoteSources(reflection.id).find((s) => s.url === twin!.url)!;
      expect(source.credibility).toBe(0);
      const durableRecord = (await durable("Alice", { operation: "get", id: twin!.recordId }))
        .result as MemoryRecord;
      expect(durableRecord.content).toBe(reflection.content);
      expect(durableRecord.tier).toBe("reflection");
      expect(durableRecord.type).toBe("episode");
      expect(durableRecord.metadata).toMatchObject({ legacy_note_id: reflection.id });
    }
    // Same-key idempotency: bridging again does not create a second record.
    const records = (await durable("Alice", { operation: "query", input: { tier: "reflection" } }))
      .result as { results: MemoryRecord[] };
    expect(records.results).toHaveLength(2);
  });

  it("`reflect failure` gets a durable twin", async () => {
    await run(alice, "note The relay dropped packets under load !7");
    await run(alice, "reflect failure relay timed out during load test");
    const [note] = reflectionNotes("Alice");
    const twin = findDurableTwin(db, note!.id);
    expect(twin).toBeDefined();
    const durableRecord = (await durable("Alice", { operation: "get", id: twin!.recordId }))
      .result as MemoryRecord;
    expect(durableRecord.content).toContain("[Failure Analysis] relay timed out during load test");
    expect(durableRecord.tier).toBe("reflection");
  });

  it("LOCAL ungated: auto-spawns a memory-reflector when none runs and files the job against it", async () => {
    setTrustProfile("local");
    for (let i = 0; i < 2; i++) await run(alice, `note Signal tower reading ${i} !8`);
    const { calls, spawnHelper } = fakeSpawner();
    wireReflect({ listAgents: () => [], helpersAvailable: () => true, spawnHelper });

    const reply = await run(alice, "reflect signal");
    expect(calls).toEqual([{ role: REFLECTOR_ROLE, requestedBy: "Alice" }]);
    expect(reply).toContain("Spawned AutoReflector");
    expect(reply).toContain("Reflection Requested");
    expect(reply).not.toContain("Reflection Created");
    expect(reflectionNotes("Alice")).toHaveLength(0);
    const [job] = await ownJobs();
    expect(job).toMatchObject({
      role: "reflector",
      state: "pending",
      worker_id: db.getUserByName("AutoReflector")!.id,
    });
  });

  it("LOCAL ungated without a serving runtime (no keys) keeps the synchronous template + hint", async () => {
    setTrustProfile("local");
    for (let i = 0; i < 2; i++) await run(alice, `note Signal tower reading ${i} !8`);
    const { calls, spawnHelper } = fakeSpawner();
    wireReflect({ listAgents: () => [], helpersAvailable: () => false, spawnHelper });
    const reply = await run(alice, "reflect signal");
    expect(calls).toEqual([]);
    expect(reply).toContain("Reflection Created");
    expect(reply).toContain("agent spawn Reflector");
    expect(await ownJobs()).toEqual([]);
  });

  it("LOCAL with MARINA_AUTONOMY=guarded, and shared/public, never auto-spawn", async () => {
    for (let i = 0; i < 2; i++) await run(alice, `note Signal tower reading ${i} !8`);
    const { calls, spawnHelper } = fakeSpawner();
    wireReflect({ listAgents: () => [], helpersAvailable: () => true, spawnHelper });

    // Process default in tests is `shared`.
    const shared = await run(alice, "reflect signal");
    expect(shared).toContain("Reflection Created");
    expect(shared).toContain("memory-reflector");

    setTrustProfile("local");
    process.env.MARINA_AUTONOMY = "guarded";
    const guarded = await run(alice, "reflect signal");
    expect(guarded).toContain("Reflection Created");
    expect(calls).toEqual([]);
    expect(await ownJobs()).toEqual([]);
  });

  it("LOCAL ungated: a failed auto-spawn degrades to the template with the hint", async () => {
    setTrustProfile("local");
    for (let i = 0; i < 2; i++) await run(alice, `note Signal tower reading ${i} !8`);
    wireReflect({
      listAgents: () => [],
      helpersAvailable: () => true,
      spawnHelper: async () => undefined,
    });
    const reply = await run(alice, "reflect signal");
    expect(reply).toContain("Could not auto-spawn");
    expect(reply).toContain("Reflection Created");
    expect(reply).toContain("agent spawn Reflector");
    expect(await ownJobs()).toEqual([]);
  });
});
