// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Contradiction resolution (Phase 2.4–2.5): typed write-time operators over
 * the review queue. Two durable users; competing assertions on one
 * subject/predicate with overlapping validity; every policy exercised through
 * the HTTP handler; audit rows, idempotency, authorization, helper-lease
 * refusal and forgetting behavior asserted. */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMemoryServiceCommand } from "../src/memory/human-interface";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { closedValidity } from "../src/persistence/db-memory-resolve";
import { MarinaMemoryAssistance } from "../src/sdk/memory-assistance-client";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { MEMORY_OPERATIONS } from "../src/sdk/memory-operations";

let directory: string, db: MarinaDB, service: MemoryService, space: string;
let owner: MarinaMemoryClient, other: MarinaMemoryClient;
let ownerToken: string, ownerPrincipal: string, otherPrincipal: string;
let now: number;
let clock: ReturnType<typeof spyOn>;

const make = (name: string) => {
  const principal = db.ensurePrincipal({ type: "service", displayName: name });
  const credential = db.issueMemoryCredential(principal.principal_id);
  const client = new MarinaMemoryClient("http://test", credential.token, 35000, (r) =>
    handleMemoryServiceApi(r, service),
  );
  return { client, ...credential };
};
const raw = () => new Database(join(directory, "world.db"));

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-resolve-"));
  db = new MarinaDB(join(directory, "world.db"));
  service = new MemoryService(db);
  const a = make("owner"),
    b = make("other");
  owner = a.client;
  other = b.client;
  ownerToken = a.token;
  ownerPrincipal = a.principalId;
  otherPrincipal = b.principalId;
  now = 1_000_000;
  clock = spyOn(Date, "now").mockImplementation(() => now);
  space = (await owner.createSpace("beliefs")).id;
});
afterEach(() => {
  clock.mockRestore();
  db.close();
  rmSync(directory, { recursive: true });
});

const claim = (value: string) => ({
  subject: "office",
  predicate: "location",
  object: { kind: "literal" as const, value },
});
/** Two competing assertions: the older one is unbounded, the newer starts later
 * and overlaps it. `tick` moves the clock so "most recently revised" is exact. */
async function seedCompeting(extra: { a?: object; b?: object } = {}) {
  now += 1000;
  const a = await owner.remember(space, {
    content: "The office is in Berlin",
    claim: claim("berlin"),
    valid_time: { from: 0, until: null },
    ...extra.a,
  });
  now += 1000;
  const b = await owner.remember(space, {
    content: "The office is in Paris",
    claim: claim("paris"),
    valid_time: { from: 100, until: null },
    ...extra.b,
  });
  now += 1000;
  return { a, b };
}
const resolutions = () =>
  raw().query("SELECT * FROM memory_resolutions ORDER BY created_at").all() as Record<
    string,
    unknown
  >[];
const ids = (page: { items: { record: { id: string } }[] }) =>
  page.items.map((item) => item.record.id).sort();

it("last_writer_wins closes the loser at the winner's valid_from, keeps history, and stops flagging the pair", async () => {
  const { a, b } = await seedCompeting();
  expect(ids(await owner.review(space, { kind: "competing" }))).toEqual([a.id, b.id].sort());
  const result = await owner.resolve(
    space,
    b.id,
    { policy: "last_writer_wins", competing: [a.id], rationale: "Paris move confirmed by HR" },
    "lww-1",
  );
  expect(result).toMatchObject({
    policy: "last_writer_wins",
    status: "applied",
    winner: b.id,
    superseded: [{ id: a.id, version: 2, valid_time: { from: 0, until: 100 } }],
    record_id: b.id,
  });
  expect(result.seq).toBeNumber();
  // History intact: version 1 still carries the open interval; version 2 closes it.
  const loserNow = await owner.get(space, a.id);
  expect(loserNow.version).toBe(2);
  expect(loserNow.valid_time).toEqual({ from: 0, until: 100 });
  expect(loserNow.metadata.resolution).toMatchObject({
    id: result.id,
    status: "superseded",
    winner: b.id,
  });
  expect((await owner.get(space, a.id, 1)).valid_time).toEqual({ from: 0, until: null });
  const winner = await owner.get(space, b.id);
  expect(winner.version).toBe(2);
  expect(winner.metadata.resolution).toMatchObject({
    id: result.id,
    policy: "last_writer_wins",
    status: "winner",
    competitors: [a.id],
  });
  // Bi-temporal: "what was true at T" is answered by valid_at; nothing is deleted.
  expect(
    (await owner.query(space, { subject: "office", valid_at: 50 })).results.map((r) => r.id),
  ).toEqual([a.id]);
  expect(
    (await owner.query(space, { subject: "office", valid_at: 150 })).results.map((r) => r.id),
  ).toEqual([b.id]);
  // Review no longer lists the pair under any kind.
  expect((await owner.review(space, { kind: "competing" })).items).toEqual([]);
  expect((await owner.review(space, { kind: "all" })).items).toEqual([]);
  // Audit row: who, when, policy, inputs, outputs, rationale.
  const [audit] = resolutions();
  expect(audit).toMatchObject({
    id: result.id,
    space_id: space,
    record_id: b.id,
    policy: "last_writer_wins",
    status: "applied",
    actor_id: ownerPrincipal,
    request_key: "lww-1",
    rationale: "Paris move confirmed by HR",
    created_at: now,
  });
  expect(JSON.parse(audit!.input as string)).toEqual({
    id: b.id,
    policy: "last_writer_wins",
    competing: [a.id],
    rationale: "Paris move confirmed by HR",
  });
  expect(JSON.parse(audit!.output as string)).toEqual(result);
  // Idempotent per key: replay returns the same receipt without a second row;
  // the same key with a different decision is refused.
  expect(
    await owner.resolve(
      space,
      b.id,
      { policy: "last_writer_wins", competing: [a.id], rationale: "Paris move confirmed by HR" },
      "lww-1",
    ),
  ).toEqual(result);
  expect(resolutions()).toHaveLength(1);
  expect((await owner.get(space, a.id)).version).toBe(2);
  await expect(
    owner.resolve(
      space,
      b.id,
      { policy: "keep_both", competing: [a.id], rationale: "changed my mind" },
      "lww-1",
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
});

it("evidence_weighted counts independent sources only and never produces an empty interval", async () => {
  // Older Berlin assertion backed by two distinct sources; newer Paris assertion
  // backed by one real source plus a legacy-note twin, which is not evidence.
  const s1 = await owner.capture(space, { doc: "lease agreement, Berlin" });
  const s2 = await owner.capture(space, { doc: "payroll registration, Berlin" });
  const s3 = await owner.capture(space, { doc: "slack rumor about Paris" });
  const twin = await owner.capture(space, "The office is in Paris", "legacy-notes");
  const { a, b } = await seedCompeting({
    a: { source_ids: [s1.id, s2.id] },
    b: { source_ids: [s3.id, twin.id] },
  });
  const result = await owner.resolve(
    space,
    a.id,
    { policy: "evidence_weighted", competing: [b.id], rationale: "weigh the paperwork" },
    "ew-1",
  );
  expect(result.winner).toBe(a.id);
  expect(result.evidence_counts).toEqual({ [a.id]: 2, [b.id]: 1 });
  // Winner's valid_from is 0 but the loser starts at 100: close to the minimal
  // nonempty interval rather than an inverted one.
  expect(result.superseded).toEqual([
    { id: b.id, version: 2, valid_time: { from: 100, until: 101 } },
  ]);
  expect((await owner.get(space, a.id)).metadata.resolution).toMatchObject({
    policy: "evidence_weighted",
    evidence_counts: { [a.id]: 2, [b.id]: 1 },
  });
  expect((await owner.review(space, { kind: "competing" })).items).toEqual([]);
  // The superseded loser stays readable and dated; it is not resurrected by a
  // later query at a time it used to cover.
  expect(
    (await owner.query(space, { subject: "office", valid_at: 500 })).results.map((r) => r.id),
  ).toEqual([a.id]);
  expect(closedValidity({ from: 100, until: null }, 0)).toEqual({ from: 100, until: 101 });
  expect(closedValidity({ from: 0, until: 50 }, 100)).toBeUndefined();
  expect(closedValidity(null, 100)).toEqual({ from: null, until: 100 });
});

it("await_confirmation lists the set under kind pending until a later reaffirm or resolve", async () => {
  const { a, b } = await seedCompeting();
  const result = await owner.resolve(
    space,
    a.id,
    {
      policy: "await_confirmation",
      competing: [b.id],
      rationale: "ask facilities",
      deadline_ms: 3_600_000,
    },
    "wait-1",
  );
  expect(result).toMatchObject({
    status: "pending",
    pending: [a.id, b.id],
    deadline: now + 3_600_000,
    winner: null,
  });
  // Nothing changed: same versions, pair still competing, but now also pending.
  expect((await owner.get(space, a.id)).version).toBe(1);
  expect((await owner.get(space, b.id)).version).toBe(1);
  const pending = await owner.review(space, { kind: "pending" });
  expect(ids(pending)).toEqual([a.id, b.id].sort());
  expect(pending.items[0]?.resolution).toMatchObject({
    id: result.id,
    policy: "await_confirmation",
    status: "pending",
    role: "pending",
    deadline: now + 3_600_000,
  });
  expect(ids(await owner.review(space, { kind: "competing" }))).toEqual([a.id, b.id].sort());
  expect(ids(await owner.review(space, { kind: "all" }))).toEqual([a.id, b.id].sort());
  expect(resolutions()[0]).toMatchObject({ status: "pending", deadline: now + 3_600_000 });
  // A reviewed reaffirmation confirms the set.
  await owner.reaffirm(space, a.id, 1, {});
  expect((await owner.review(space, { kind: "pending" })).items).toEqual([]);
  expect(resolutions()[0]).toMatchObject({ status: "confirmed" });
  // A new pending set can then be superseded by an applied decision.
  await owner.resolve(
    space,
    a.id,
    { policy: "await_confirmation", competing: [b.id], rationale: "still unsure" },
    "wait-2",
  );
  expect(ids(await owner.review(space, { kind: "pending" }))).toEqual([a.id, b.id].sort());
  await owner.resolve(
    space,
    b.id,
    { policy: "last_writer_wins", competing: [a.id], rationale: "facilities confirmed Paris" },
    "lww-after-wait",
  );
  expect((await owner.review(space, { kind: "pending" })).items).toEqual([]);
  expect(resolutions().map((row) => row.status)).toEqual(["confirmed", "superseded", "applied"]);
  await expect(
    owner.resolve(
      space,
      a.id,
      { policy: "last_writer_wins", competing: [b.id], rationale: "x", deadline_ms: 5000 },
      "bad-deadline",
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it("keep_both records an irreducible conflict: both stay current and qualified, review stops flagging", async () => {
  const { a, b } = await seedCompeting();
  const result = await owner.resolve(
    space,
    a.id,
    { policy: "keep_both", competing: [b.id], rationale: "two offices, one predicate" },
    "keep-1",
  );
  expect(result).toMatchObject({ status: "applied", peers: [a.id, b.id], winner: null });
  for (const [self, peer] of [
    [a.id, b.id],
    [b.id, a.id],
  ]) {
    const record = await owner.get(space, self!);
    expect(record.version).toBe(2);
    expect(record.valid_time?.until).toBeNull();
    expect(record.metadata.qualified_by).toEqual({
      resolution: result.id,
      records: [peer],
      rationale: "two offices, one predicate",
    });
  }
  expect(
    (await owner.query(space, { subject: "office", valid_at: 500 })).results
      .map((r) => r.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
  expect((await owner.review(space, { kind: "competing" })).items).toEqual([]);
  expect((await owner.review(space, { kind: "all" })).items).toEqual([]);
  // A third rival is still a contradiction with both kept peers.
  now += 1000;
  const c = await owner.remember(space, {
    content: "The office is in Lisbon",
    claim: claim("lisbon"),
    valid_time: { from: 200, until: null },
  });
  expect(ids(await owner.review(space, { kind: "competing" }))).toEqual([a.id, b.id, c.id].sort());
});

it("requires a live space writer: strangers and readers get 404, read-only scopes 403, writers succeed", async () => {
  const { a, b } = await seedCompeting();
  const input = { policy: "keep_both" as const, competing: [b.id], rationale: "not mine" };
  await expect(other.resolve(space, a.id, input, "k")).rejects.toMatchObject({ status: 404 });
  await owner.grant(space, otherPrincipal, "reader");
  await expect(other.resolve(space, a.id, input, "k")).rejects.toMatchObject({ status: 404 });
  const readonly = db.issueMemoryCredential(ownerPrincipal, ["memory:read"]);
  const limited = new MarinaMemoryClient("http://test", readonly.token, 35000, (r) =>
    handleMemoryServiceApi(r, service),
  );
  await expect(limited.resolve(space, a.id, input, "k")).rejects.toMatchObject({
    status: 403,
    code: "scope_required",
  });
  await owner.grant(space, otherPrincipal, "writer");
  const result = await other.resolve(space, a.id, input, "k");
  expect(resolutions()[0]).toMatchObject({ id: result.id, actor_id: otherPrincipal });
  // Invalid shapes are rejected before any write.
  await expect(
    owner.resolve(space, a.id, { ...input, policy: "coin_flip" as never }, "bad"),
  ).rejects.toMatchObject({ code: "invalid_policy" });
  await expect(
    owner.resolve(space, a.id, { ...input, competing: [a.id] }, "self"),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    owner.resolve(space, a.id, { ...input, competing: ["missing"] }, "missing"),
  ).rejects.toMatchObject({ code: "memory_not_found" });
  const unrelated = await owner.remember(space, {
    content: "Budget is 10",
    claim: { subject: "office", predicate: "budget", object: { kind: "literal", value: 10 } },
  });
  await expect(
    owner.resolve(space, a.id, { ...input, competing: [unrelated.id] }, "unrelated"),
  ).rejects.toMatchObject({ code: "not_competing", status: 409 });
});

it("refuses resolution under an assistance lease: helpers read and propose, they never decide", async () => {
  const { a, b } = await seedCompeting();
  const helper = make("helper");
  const requester = MarinaMemoryAssistance.http(owner);
  const worker = MarinaMemoryAssistance.http(helper.client);
  const job = await requester.create(space, {
    worker_id: helper.principalId,
    role: "evaluator",
    task: "Which office assertion is better supported?",
  });
  const lease = await worker.claim(job.id);
  await expect(
    worker.read(job.id, lease.lease_token, {
      operation: "resolve",
      id: a.id,
      input: { policy: "last_writer_wins", competing: [b.id], rationale: "helper says so" },
    } as never),
  ).rejects.toMatchObject({ code: "assistance_read_only" });
  // Review stays readable to the helper through the lease; the pair is still open.
  const review = (await worker.read(job.id, lease.lease_token, {
    operation: "review",
    input: { kind: "competing" },
  })) as { items: unknown[] };
  expect(review.items).toHaveLength(2);
  // The helper's own credential has no standing on the space either.
  await expect(
    helper.client.resolve(
      space,
      a.id,
      { policy: "last_writer_wins", competing: [b.id], rationale: "direct" },
      "direct",
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(resolutions()).toEqual([]);
  expect((await owner.get(space, a.id)).version).toBe(1);
});

it("forgetting retires pending sets and never resurrects a superseded loser", async () => {
  const { a, b } = await seedCompeting();
  await owner.resolve(
    space,
    b.id,
    { policy: "last_writer_wins", competing: [a.id], rationale: "Paris" },
    "lww",
  );
  await owner.forget(space, { record_ids: [b.id] }, "forget-winner");
  await expect(owner.get(space, b.id)).rejects.toMatchObject({ status: 404 });
  const loser = await owner.get(space, a.id);
  expect(loser.valid_time).toEqual({ from: 0, until: 100 });
  expect((await owner.review(space, { kind: "competing" })).items).toEqual([]);
  expect(
    (await owner.query(space, { subject: "office", valid_at: 500 })).results.map((r) => r.id),
  ).toEqual([]);
  expect(resolutions()[0]).toMatchObject({ status: "applied" });
  // A pending set with a forgotten member is retired, not left dangling.
  now += 1000;
  const c = await owner.remember(space, {
    content: "The office is in Lisbon",
    claim: claim("lisbon"),
    valid_time: { from: 0, until: null },
  });
  await owner.resolve(
    space,
    c.id,
    { policy: "await_confirmation", competing: [a.id], rationale: "wait" },
    "wait",
  );
  expect(ids(await owner.review(space, { kind: "pending" }))).toEqual([a.id, c.id].sort());
  await owner.forget(space, { record_ids: [c.id] }, "forget-pending");
  expect((await owner.review(space, { kind: "pending" })).items).toEqual([]);
  expect(resolutions()[1]).toMatchObject({ status: "retired" });
  // Storage accounting stays consistent with the rebuildable projection.
  const sqlite = raw();
  expect(
    sqlite
      .query("SELECT * FROM memory_storage_items EXCEPT SELECT * FROM memory_storage_projection")
      .all(),
  ).toEqual([]);
  expect(
    sqlite
      .query("SELECT * FROM memory_storage_projection EXCEPT SELECT * FROM memory_storage_items")
      .all(),
  ).toEqual([]);
  sqlite.close();
});

it("is reachable from every interface: HTTP route, operation vocabulary, world command, capabilities", async () => {
  const { a, b } = await seedCompeting();
  expect(MEMORY_OPERATIONS).toContain("resolve");
  const parsed = parseMemoryServiceCommand(
    `resolve ${a.id} keep_both {"competing":["${b.id}"],"rationale":"both offices"}`,
  );
  expect(parsed).toEqual({
    operation: "resolve",
    id: a.id,
    input: { competing: [b.id], rationale: "both offices", policy: "keep_both" },
  });
  expect(() => parseMemoryServiceCommand(`resolve ${a.id} coin_flip {}`)).toThrow();
  const response = await handleMemoryServiceApi(
    new Request(`http://memory.invalid/v1/memory/spaces/${space}/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "http-1",
      },
      body: JSON.stringify({ id: a.id, ...parsed!.input }),
    }),
    service,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ policy: "keep_both", peers: [a.id, b.id] });
  const missingKey = await handleMemoryServiceApi(
    new Request(`http://memory.invalid/v1/memory/spaces/${space}/resolve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, ...parsed!.input }),
    }),
    service,
  );
  expect(missingKey.status).toBe(400);
  expect(service.capabilities().contradiction_resolution.policies).toEqual([
    "last_writer_wins",
    "evidence_weighted",
    "await_confirmation",
    "keep_both",
  ]);
  expect(service.capabilities().review_queue).toBe("stale-competing-and-pending-assertions");
});
