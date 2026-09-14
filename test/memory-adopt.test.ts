// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFromLedger, ledgerFor, STANDING_AMOUNTS } from "../src/agent/standing";
import { parseMemoryServiceCommand } from "../src/memory/human-interface";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryCitation } from "../src/sdk/memory-answer";
import { MarinaMemoryAssistance } from "../src/sdk/memory-assistance-client";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { MEMORY_OPERATIONS } from "../src/sdk/memory-operations";

let directory: string, db: MarinaDB, service: MemoryService, space: string, path: string;
let owner: MarinaMemoryClient, worker: MarinaMemoryClient, stranger: MarinaMemoryClient;
let requester: MarinaMemoryAssistance,
  helper: MarinaMemoryAssistance,
  second: MarinaMemoryAssistance;
let workerId: string, strangerId: string;

const make = (name: string) => {
  const principal = db.ensurePrincipal({ type: "service", displayName: name });
  const credential = db.issueMemoryCredential(principal.principal_id);
  const client = new MarinaMemoryClient("http://test", credential.token, 35000, (r) =>
    handleMemoryServiceApi(r, service),
  );
  return { client, ...credential };
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-adopt-"));
  path = join(directory, "world.db");
  db = new MarinaDB(path);
  service = new MemoryService(db);
  const a = make("owner"),
    b = make("helper"),
    c = make("stranger");
  owner = a.client;
  worker = b.client;
  stranger = c.client;
  workerId = b.principalId;
  strangerId = c.principalId;
  requester = MarinaMemoryAssistance.http(owner);
  helper = MarinaMemoryAssistance.http(worker);
  second = MarinaMemoryAssistance.http(stranger);
  space = (await owner.createSpace("private")).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

const create = (extra = {}) =>
  requester.create(space, {
    worker_id: workerId,
    role: "librarian",
    task: "Find the deployment instruction",
    ...extra,
  });
const cite = (id: string, quote = "port 7419"): MemoryCitation => ({
  kind: "record",
  space_id: space,
  id,
  version: 1,
  quote,
});
/** Owner remembers evidence, helper claims, reads, answers. Returns the job. */
async function answeredJob(extra: { withSource?: boolean } = {}) {
  const source = extra.withSource
    ? await owner.capture(space, "Deployment notes: the service listens on port 7419.")
    : undefined;
  const saved = await owner.remember(space, {
    content: "Deployment uses port 7419.",
    ...(source ? { source_ids: [source.id] } : {}),
  });
  const job = await create();
  const claim = await helper.claim(job.id);
  await helper.read(job.id, claim.lease_token, { operation: "get", id: saved.id });
  const citations: MemoryCitation[] = [cite(saved.id)];
  if (source) {
    const range = (await helper.read(job.id, claim.lease_token, {
      operation: "source_range",
      id: source.id,
      input: { start: 0, end: 16 },
    })) as { text: string; text_hash: string; start: number; end: number };
    citations.push({
      kind: "source",
      space_id: space,
      id: source.id,
      start: range.start,
      end: range.end,
      text_hash: range.text_hash,
      quote: range.text,
    });
  }
  await helper.finish(job.id, claim.lease_token, {
    status: "answered",
    answer: "Deploy using the documented port.",
    citations,
  });
  return { job, saved, source };
}
const events = (operation: string) => {
  const reader = new Database(path, { readonly: true });
  try {
    return reader
      .query("SELECT reference_id FROM memory_service_events WHERE operation=?")
      .all(operation) as { reference_id: string }[];
  } finally {
    reader.close();
  }
};

it("adopts an answered job as a cited record and credits the helper once", async () => {
  const { job, saved, source } = await answeredJob({ withSource: true });
  const adopted = await owner.adopt(undefined, job.id, { rationale: "confirmed in staging" }, "k1");
  expect(adopted).toMatchObject({
    job_id: job.id,
    space_id: space,
    state: "adopted",
    existing: false,
    ratified_by: null,
    version: 1,
  });
  expect(adopted.credited).toEqual([
    { principal_id: workerId, kind: "assistance_adopted", ref: `assistance:${job.id}`, amount: 1 },
  ]);
  const record = await owner.get(space, adopted.id);
  const proposal = (await requester.get(job.id)).result_record_id;
  expect(record.content).toBe("Deploy using the documented port.");
  expect(record.type).toBe("episode");
  expect(record.tier).toBe("reflection");
  expect(record.metadata).toMatchObject({
    adopted_from_job: job.id,
    helper_id: workerId,
    proposal_record_id: proposal,
    derived_from: [proposal],
    rationale: "confirmed in staging",
    role: "librarian",
  });
  expect(record.depends_on).toEqual([saved.id]);
  expect(record.dependency_versions).toEqual({ [saved.id]: 1 });
  expect(record.source_ids).toEqual([source!.id]);
  expect(computeFromLedger(db, workerId)).toBeCloseTo(STANDING_AMOUNTS.assistance_adopted, 3);
  expect(events("assistance.adopted").map((e) => e.reference_id)).toEqual([job.id]);

  // Same job, any key ⇒ same record; no double credit.
  const again = await owner.adopt(space, job.id, {}, "k2");
  expect(again).toMatchObject({ id: adopted.id, existing: true, credited: [] });
  const replay = await owner.adopt(undefined, job.id, { rationale: "confirmed in staging" }, "k1");
  expect(replay.id).toBe(adopted.id);
  expect(computeFromLedger(db, workerId)).toBeCloseTo(1, 3);
  expect(ledgerFor(db, workerId).filter((e) => e.kind === "assistance_adopted")).toHaveLength(1);
});

it("only the requester adopts into the job's own space; strangers cannot see it", async () => {
  const { job } = await answeredJob();
  await expect(worker.adopt(undefined, job.id, {}, "w1")).rejects.toMatchObject({
    code: "assistance_owner_required",
    status: 403,
  });
  await expect(stranger.adopt(undefined, job.id, {}, "s1")).rejects.toMatchObject({
    status: 404,
  });
  expect(computeFromLedger(db, workerId)).toBe(0);
});

it("refuses unfinished and abstained jobs, and credits a confirmed abstention exactly once", async () => {
  const pending = await create();
  await expect(owner.adopt(undefined, pending.id, {}, "p1")).rejects.toMatchObject({
    code: "assistance_not_adoptable",
  });
  const job = await create({ task: "Find the rollback procedure" });
  const claim = await helper.claim(job.id);
  await helper.finish(job.id, claim.lease_token, {
    status: "abstained",
    reason: "No rollback procedure is recorded",
  });
  await expect(owner.adopt(undefined, job.id, {}, "a1")).rejects.toMatchObject({
    code: "assistance_not_adoptable",
    message: expect.stringContaining("confirm_abstention"),
  });
  // The worker cannot confirm their own abstention.
  await expect(
    worker.adopt(space, job.id, { confirm_abstention: true }, "a2"),
  ).rejects.toMatchObject({ code: "assistance_owner_required" });
  const confirmed = await owner.adopt(undefined, job.id, { confirm_abstention: true }, "a3");
  expect(confirmed).toMatchObject({ state: "abstention_confirmed", existing: false });
  expect(confirmed.credited).toEqual([
    {
      principal_id: workerId,
      kind: "assistance_abstained_confirmed",
      ref: `assistance:${job.id}:abstention`,
      amount: 0.25,
    },
  ]);
  const twice = await owner.adopt(undefined, job.id, { confirm_abstention: true }, "a4");
  expect(twice).toMatchObject({ state: "abstention_confirmed", existing: true, credited: [] });
  expect(computeFromLedger(db, workerId)).toBeCloseTo(0.25, 3);
  expect(events("assistance.abstention_confirmed")).toHaveLength(1);
});

it("splits a delegated tree's credit 0.6 to the root worker and 0.4 across answered contributors", async () => {
  const saved = await owner.remember(space, { content: "Deployment uses port 7419." });
  const root = await create();
  const lease = await helper.claim(root.id);
  const child = await helper.delegate(root.id, lease.lease_token, {
    worker_id: strangerId,
    role: "evaluator",
    task: "Check the supporting evidence",
  });
  const childLease = await second.claim(child.id);
  await second.read(child.id, childLease.lease_token, { operation: "get", id: saved.id });
  await second.finish(child.id, childLease.lease_token, {
    status: "answered",
    answer: "The evidence supports port 7419.",
    citations: [cite(saved.id)],
  });
  await helper.read(root.id, lease.lease_token, { operation: "get", id: saved.id });
  await helper.finish(root.id, lease.lease_token, {
    status: "answered",
    answer: "Deploy on port 7419 (evaluator concurs).",
    citations: [cite(saved.id)],
  });
  const adopted = await owner.adopt(undefined, root.id, {}, "tree-1");
  const byPrincipal = Object.fromEntries(adopted.credited.map((c) => [c.principal_id, c.amount]));
  expect(byPrincipal).toEqual({ [workerId]: 0.6, [strangerId]: 0.4 });
  expect(computeFromLedger(db, workerId)).toBeCloseTo(0.6, 3);
  expect(computeFromLedger(db, strangerId)).toBeCloseTo(0.4, 3);
  expect(service.repository.adopt.contributionShares(child.id)).toEqual(
    new Map([
      [workerId, 0.6],
      [strangerId, 0.4],
    ]),
  );
});

it("debits the helpers when an adopted record is superseded by resolve (idempotently)", async () => {
  const { job } = await answeredJob();
  const adopted = await owner.adopt(undefined, job.id, {}, "d1");
  expect(computeFromLedger(db, workerId)).toBeCloseTo(1, 3);
  // Give the adopted record a claim so it can compete, then out-vote it.
  await owner.revise(space, adopted.id, 1, {
    content: "Deploy using the documented port.",
    metadata: { adopted_from_job: job.id },
    claim: { subject: "deploy:amber", predicate: "port", object: { kind: "literal", value: 7419 } },
  });
  const winner = await owner.remember(space, {
    content: "Deployment moved to port 8520.",
    claim: { subject: "deploy:amber", predicate: "port", object: { kind: "literal", value: 8520 } },
  });
  const resolution = await owner.resolve(
    space,
    winner.id,
    { policy: "last_writer_wins", competing: [adopted.id], rationale: "ops confirmed the move" },
    "res-1",
  );
  expect(resolution.superseded.map((s) => s.id)).toEqual([adopted.id]);
  expect(computeFromLedger(db, workerId)).toBeCloseTo(0.5, 3);
  const debit = ledgerFor(db, workerId).find((e) => e.kind === "assistance_superseded");
  expect(debit).toMatchObject({
    ref: `assistance:${job.id}:superseded:${adopted.id}`,
    amount: -0.5,
  });
  // Direct hook re-run is a no-op; unrelated records debit nobody.
  expect(service.repository.adopt.debitSuperseded(adopted.id)).toEqual([]);
  expect(service.repository.adopt.debitSuperseded(winner.id)).toEqual([]);
  expect(computeFromLedger(db, workerId)).toBeCloseTo(0.5, 3);
});

it("exposes adopt on the operation vocabulary and the world command grammar", () => {
  expect(MEMORY_OPERATIONS).toContain("adopt");
  expect(parseMemoryServiceCommand("adopt job-1")).toEqual({
    operation: "adopt",
    id: "job-1",
    input: {},
  });
  expect(parseMemoryServiceCommand('adopt job-1 space sp-9 {"rationale":"why"}')).toEqual({
    operation: "adopt",
    id: "job-1",
    space_id: "sp-9",
    input: { rationale: "why" },
  });
  expect(parseMemoryServiceCommand("adopt job-1 confirm-abstention")).toEqual({
    operation: "adopt",
    id: "job-1",
    input: { confirm_abstention: true },
  });
  expect(() => parseMemoryServiceCommand("adopt")).toThrow();
});
