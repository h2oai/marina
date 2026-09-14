// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFromLedger, record as recordStanding } from "../src/agent/standing";
import { poolCommand } from "../src/engine/commands/pool";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import {
  checkRatification,
  INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP,
  INSTITUTIONAL_RATIFY_MIN_STANDING,
  institutionalSpaceFor,
  isInstitutionalPoolName,
} from "../src/memory/institutional";
import { findDurableTwin } from "../src/memory/legacy-bridge";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryCitation } from "../src/sdk/memory-answer";
import { MarinaMemoryAssistance } from "../src/sdk/memory-assistance-client";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import type { MemoryRecord } from "../src/sdk/memory-types";
import { type Entity, entityId } from "../src/types";
import { seedGuidePool } from "../src/world/seed-guide";

let directory: string, db: MarinaDB, service: MemoryService;
let workerId: string, worker: MarinaMemoryClient;

/** A durable world account (human principal == users.id) with a memory client. */
function user(name: string, rank = 0) {
  const id = `u_${name}`;
  db.createUser({ id, name, rank });
  const credential = db.issueMemoryCredential(id);
  const client = new MarinaMemoryClient("http://test", credential.token, 35000, (r) =>
    handleMemoryServiceApi(r, service),
  );
  return { id, name, client, help: MarinaMemoryAssistance.http(client) };
}
const actor = (name: string, rank = 0): Entity => ({
  id: entityId(`e_${name}`),
  kind: "agent",
  name,
  short: name,
  long: name,
  room: "r_test" as never,
  properties: { rank },
  inventory: [],
  createdAt: Date.now(),
});
function pool(entities: Entity[]) {
  const sent: string[] = [];
  const command = poolCommand({
    getEntity: (id) => entities.find((e) => String(e.id) === String(id)),
    db,
  });
  const run = (who: Entity, args: string) => {
    command.handler(
      { send: (_id: unknown, text: string) => sent.push(text) } as never,
      {
        raw: `pool ${args}`,
        verb: "pool",
        args,
        tokens: args.split(/\s+/),
        entity: who.id,
        room: "r_test",
      } as never,
    );
    return sent.at(-1) ?? "";
  };
  return { run, sent };
}
/** Owner asks the service helper; helper answers with one record citation. */
async function answered(requester: ReturnType<typeof user>) {
  const space =
    (await requester.client.spaces()).spaces.find((s) => s.name === "own")?.id ??
    (await requester.client.createSpace("own")).id;
  const saved = await requester.client.remember(space, {
    content: "Always run `readiness` first.",
  });
  const job = await requester.help.create(space, {
    worker_id: workerId,
    role: "reflector",
    task: "Propose the onboarding lesson",
  });
  const helper = MarinaMemoryAssistance.http(worker);
  const lease = await helper.claim(job.id);
  await helper.read(job.id, lease.lease_token, { operation: "get", id: saved.id });
  const citation: MemoryCitation = {
    kind: "record",
    space_id: space,
    id: saved.id,
    version: 1,
    quote: "readiness",
  };
  await helper.finish(job.id, lease.lease_token, {
    status: "answered",
    answer: "New arrivals should run `readiness` before spawning helpers.",
    citations: [citation],
  });
  return { job, space, saved };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-institutional-"));
  db = new MarinaDB(join(directory, "world.db"));
  service = new MemoryService(db);
  const principal = db.ensurePrincipal({ type: "service", displayName: "reflector" });
  const credential = db.issueMemoryCredential(principal.principal_id);
  workerId = principal.principal_id;
  worker = new MarinaMemoryClient("http://test", credential.token, 35000, (r) =>
    handleMemoryServiceApi(r, service),
  );
  seedGuidePool(db, []);
});
afterEach(() => {
  resetTrustProfileForTests();
  db.close();
  rmSync(directory, { recursive: true });
});

it("seeds a world-readable institutional guide space owned by the guide system principal", async () => {
  const guide = institutionalSpaceFor(db, "guide");
  expect(guide).toBeDefined();
  expect(guide!.metadata).toMatchObject({ institutional: true, read_public: true, pool: "guide" });
  expect(db.getPrincipal("system", "guide")?.principal_id).toBe(guide!.owner_id);
  seedGuidePool(db, []); // idempotent
  expect(institutionalSpaceFor(db, "guide")!.id).toBe(guide!.id);
  const alice = user("alice");
  // Every credential can read and list it; nobody but the owner writes.
  expect((await alice.client.spaces()).spaces.map((s) => s.id)).toContain(guide!.id);
  expect((await alice.client.request<{ id: string }>(`/spaces/${guide!.id}`)).id).toBe(guide!.id);
  await expect(
    alice.client.remember(guide!.id, { content: "sneaking canon in" }),
  ).rejects.toMatchObject({ code: "space_not_found" });
  expect(isInstitutionalPoolName("guide")).toBe(true);
  expect(isInstitutionalPoolName("orchestration:pipeline")).toBe(true);
  expect(isInstitutionalPoolName("scratch")).toBe(false);
});

it("refuses a low-standing ratification naming the threshold and the caller's standing", async () => {
  const alice = user("alice");
  const { job } = await answered(alice);
  const guide = institutionalSpaceFor(db, "guide")!;
  await expect(alice.client.adopt(guide.id, job.id, {}, "r1")).rejects.toMatchObject({
    status: 403,
    code: "ratification_required",
    message: expect.stringContaining(`standing ≥ ${INSTITUTIONAL_RATIFY_MIN_STANDING}`),
  });
  await expect(alice.client.adopt(guide.id, job.id, {}, "r1")).rejects.toMatchObject({
    message: expect.stringContaining("your standing is 0.0"),
  });
  expect(checkRatification(db, alice.id)).toMatchObject({ ok: false, standing: 0, threshold: 15 });
  expect(computeFromLedger(db, workerId)).toBe(0);
});

it("ratifies with standing, as a sovereign, or as the ungated local operator — stamping ratified_by", async () => {
  const guide = institutionalSpaceFor(db, "guide")!;
  // Standing path.
  const alice = user("alice");
  recordStanding(db, alice.id, "alice", "task_complete", "task:1", 20);
  const first = await answered(alice);
  const adopted = await alice.client.adopt(
    guide.id,
    first.job.id,
    { rationale: "matches the docs" },
    "s1",
  );
  expect(adopted).toMatchObject({ space_id: guide.id, state: "adopted", existing: false });
  expect(adopted.ratified_by).toMatchObject({
    principal_id: alice.id,
    name: "alice",
    basis: "standing",
    rationale: "matches the docs",
  });
  expect(adopted.ratified_by!.standing).toBeGreaterThanOrEqual(15);
  const record = await alice.client.get(guide.id, adopted.id);
  expect(record.metadata).toMatchObject({
    adopted_from_job: first.job.id,
    ratified_by: { principal_id: alice.id, basis: "standing" },
    source_space_id: first.space,
  });
  // Cross-space: citations stay descriptive, never pinned into a foreign space.
  expect(record.depends_on).toEqual([]);
  expect((record.metadata.citations as unknown[]).length).toBe(1);
  expect(computeFromLedger(db, workerId)).toBeCloseTo(1, 3);
  // Re-adoption by another ratifier converges on the same record.
  const bob = user("bob", 9);
  expect(checkRatification(db, bob.id)).toMatchObject({ ok: true, basis: "sovereign" });
  // Sovereign path (0 standing, rank 9).
  const secondJob = await answered(bob);
  const byBob = await bob.client.adopt(guide.id, secondJob.job.id, {}, "s2");
  expect(byBob.ratified_by).toMatchObject({ principal_id: bob.id, basis: "sovereign" });
  // Ungated local operator path (0 standing, rank 0).
  setTrustProfile("local");
  const carol = user("carol");
  const third = await answered(carol);
  const byCarol = await carol.client.adopt(guide.id, third.job.id, {}, "s3");
  expect(byCarol.ratified_by).toMatchObject({ principal_id: carol.id, basis: "local-ungated" });
  resetTrustProfileForTests();
  // Everyone reads the canon; the guide principal authored the rows.
  const query = await carol.client.request<{ results: MemoryRecord[] }>(
    `/spaces/${guide.id}/query`,
    "POST",
    {},
  );
  expect(query.results.map((r) => r.id).sort()).toEqual([adopted.id, byBob.id, byCarol.id].sort());
});

it("caps `pool guide add` as a proposal on a shared instance and leaves it alone locally", () => {
  const alice = actor("alice");
  db.createUser({ id: "u_alice", name: "alice" });
  const { run } = pool([alice]);
  const shared = run(alice, "guide add Run readiness before spawning helpers importance 9");
  expect(shared).toContain("proposal");
  expect(shared).toContain("pool guide ratify");
  const sharedId = Number(shared.match(/#(\d+)/)![1]);
  const capped = db.getNote(sharedId)!;
  expect(capped.importance).toBe(INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP);
  expect(capped.verification_status).toBe("unverified");
  // Non-institutional pools are untouched.
  run(alice, "create scratch");
  const scratch = run(alice, "scratch add Random thought importance 9");
  expect(db.getNote(Number(scratch.match(/#(\d+)/)![1]))!.importance).toBe(9);
  // Local operator: exactly as before.
  setTrustProfile("local");
  const local = run(alice, "guide add Another local canon line importance 9");
  expect(local).not.toContain("proposal");
  expect(db.getNote(Number(local.match(/#(\d+)/)![1]))!.importance).toBe(9);
  // Legacy recall is unchanged.
  const guidePool = db.getMemoryPool("guide")!;
  expect(db.recallPoolNotes(guidePool.id, "readiness").map((n) => n.id)).toContain(sharedId);
});

it("`pool guide ratify` lifts the cap, verifies, and mirrors into the institutional space once", async () => {
  const alice = actor("alice");
  const dave = actor("dave");
  db.createUser({ id: "u_alice", name: "alice" });
  db.createUser({ id: "u_dave", name: "dave" });
  const { run } = pool([alice, dave]);
  const added = run(dave, "guide add Prefer tellAndAwait for crew round trips importance 8");
  const noteId = Number(added.match(/#(\d+)/)![1]);
  // Low standing: refused, threshold named.
  const refused = run(dave, `guide ratify ${noteId}`);
  expect(refused).toContain("Cannot ratify");
  expect(refused).toContain("standing ≥ 15");
  expect(db.getNote(noteId)!.importance).toBe(INSTITUTIONAL_PROPOSAL_IMPORTANCE_CAP);
  // Non-institutional pool: not applicable.
  run(alice, "create scratch");
  expect(run(alice, "scratch ratify 1")).toContain("not institutional");
  // Standing ≥ 15: ratified.
  recordStanding(db, "u_alice", "alice", "task_complete", "task:1", 20);
  const ok = run(alice, `guide ratify ${noteId} importance 8 checked against the SDK`);
  expect(ok).toContain("Ratified");
  const note = db.getNote(noteId)!;
  expect(note.importance).toBe(8);
  expect(note.verification_status).toBe("verified");
  const twin = findDurableTwin(db, noteId);
  expect(twin).toBeDefined();
  const guide = institutionalSpaceFor(db, "guide")!;
  expect(twin!.spaceId).toBe(guide.id);
  const reader = user("erin");
  const record = await reader.client.get(guide.id, twin!.recordId);
  expect(record.content).toBe("Prefer tellAndAwait for crew round trips");
  expect(record.importance).toBe(8);
  expect(record.metadata).toMatchObject({
    format: "marina.memory.pool-ratification.v1",
    pool: "guide",
    note_id: noteId,
    author: "dave",
    ratified_by: {
      principal_id: "u_alice",
      name: "alice",
      basis: "standing",
      rationale: "checked against the SDK",
    },
  });
  // Idempotent: a second ratification mirrors nothing new.
  const again = run(alice, `guide ratify ${noteId}`);
  expect(again).toContain("already mirrored");
  const all = await reader.client.request<{ results: MemoryRecord[] }>(
    `/spaces/${guide.id}/query`,
    "POST",
    {},
  );
  expect(all.results.filter((r) => r.metadata.note_id === noteId)).toHaveLength(1);
});
