// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFederation } from "../src/memory/federation";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryAssistance } from "../src/sdk/memory-assistance-client";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import type { MemoryRetrievalResult } from "../src/sdk/memory-types";

let directory: string,
  db: MarinaDB,
  service: MemoryService,
  client: MarinaMemoryClient,
  space: string,
  principal: string;
let federation: MemoryFederation;
const make = (name: string) => {
  const id = db.ensurePrincipal({ type: "service", displayName: name }).principal_id;
  const credential = db.issueMemoryCredential(id);
  const client = new MarinaMemoryClient(`http://${name}.test`, credential.token, 35000, (request) =>
    handleMemoryServiceApi(request, service),
  );
  return { id, client, credential };
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marina-composition-"));
  db = new MarinaDB(join(directory, "test.db"));
  federation = new MemoryFederation();
  service = new MemoryService(db, undefined, undefined, federation);
  const owner = make("owner");
  client = owner.client;
  principal = owner.id;
  space = (await client.createSpace("corpus")).id;
});
afterEach(() => {
  service.stopWorker();
  db.close();
  rmSync(directory, { recursive: true });
});

it("selects explicit alternatives, original passages and exact claims with honest structural coverage", async () => {
  await client.capture(space, "Zephyr launch at first light");
  const claim = await client.remember(space, {
    content: "launch at dawn",
    claim: { subject: "zephyr", predicate: "launch", object: { kind: "literal", value: "dawn" } },
  });
  const conflicting = await client.remember(space, {
    content: "launch at noon",
    claim: { subject: "zephyr", predicate: "launch", object: { kind: "literal", value: "noon" } },
  });
  const result = await client.retrieve(space, {
    task: "deployment dawn",
    selection: "balanced",
    expansion: { policy: "caller-vocabulary-v1", queries: ["Zephyr launch"] },
    steps: [
      { operation: "source_search", input: { query: "deployment dawn" } },
      { operation: "query", input: { subject: "zephyr", predicate: "launch" } },
    ],
    requirements: [
      { kind: "claim", subject: "zephyr", predicate: "launch" },
      { kind: "claim", subject: "absent", predicate: "launch" },
    ],
  });
  expect(result.evidence[0]?.kind).toBe("record");
  expect(result.evidence.some((item) => item.kind === "source")).toBe(true);
  expect(result.coverage?.map((row) => row.covered)).toEqual([true, false]);
  expect(result.known_conflicts?.[0]?.records.sort()).toEqual([claim.id, conflicting.id].sort());
  expect(result.answer_sufficiency).toBe("not_assessed");
});

it("charges delegated constituent reads on every attempt and excludes assistance requests from evidence", async () => {
  await client.capture(space, "Zephyr deployment uses 8123");
  const worker = make("helper");
  const requester = MarinaMemoryAssistance.http(client),
    helper = MarinaMemoryAssistance.http(worker.client);
  const job = await requester.create(space, {
    worker_id: worker.id,
    role: "librarian",
    task: "Zephyr deployment: secret-question-word",
    max_operations: 12,
  });
  const lease = await helper.claim(job.id);
  const request = { operation: "retrieve" as const, input: { task: "Zephyr deployment" } };
  const result = (await helper.read(
    job.id,
    lease.lease_token,
    request,
    "read-1",
  )) as MemoryRetrievalResult;
  const jobState = await requester.get(job.id);
  expect(result.evidence.some((item) => item.id === jobState.input_source_id)).toBe(false);
  const remaining = (await requester.get(job.id)).remaining_operations;
  expect(remaining).toBeLessThan(10);
  await helper.read(job.id, lease.lease_token, request, "read-1");
  expect((await requester.get(job.id)).remaining_operations).toBeLessThan(remaining);
  await requester.cancel(job.id);
  await expect(helper.read(job.id, lease.lease_token, request)).rejects.toBeDefined();
});

it("refuses delegated retrieval when the root cannot pay for the underlying read program", async () => {
  await client.capture(space, "Zephyr deployment port");
  const worker = make("tiny");
  const requester = MarinaMemoryAssistance.http(client),
    helper = MarinaMemoryAssistance.http(worker.client);
  const job = await requester.create(space, {
    worker_id: worker.id,
    role: "librarian",
    task: "Zephyr",
    max_operations: 2,
  });
  const lease = await helper.claim(job.id);
  await expect(
    helper.read(job.id, lease.lease_token, { operation: "retrieve", input: { task: "Zephyr" } }),
  ).rejects.toMatchObject({ code: "assistance_budget" });
  expect((await requester.get(job.id)).remaining_operations).toBe(0);
});

it("rechecks the helper lease across asynchronous reads", async () => {
  const worker = make("cancelled");
  const requester = MarinaMemoryAssistance.http(client),
    helper = MarinaMemoryAssistance.http(worker.client);
  const job = await requester.create(space, {
    worker_id: worker.id,
    role: "librarian",
    task: "Zephyr",
  });
  const lease = await helper.claim(job.id);
  const original = service.search.bind(service);
  const read = spyOn(service, "search").mockImplementation(async (...args) => {
    const result = await original(...args);
    await requester.cancel(job.id);
    return result;
  });
  try {
    await expect(
      helper.read(job.id, lease.lease_token, { operation: "retrieve", input: { task: "Zephyr" } }),
    ).rejects.toBeDefined();
  } finally {
    read.mockRestore();
  }
});

it("retrieves explicitly selected peers within a total budget and exposes partial availability", async () => {
  const peer = make("peer");
  const remote = (await peer.client.createSpace("remote")).id;
  await peer.client.capture(remote, "Zephyr remote route is amber");
  federation.mount(principal, "remote", peer.client, remote);
  const result = await client.federatedRetrieve(space, ["remote"], {
    task: "Zephyr route",
    max_bytes: 1500,
    max_results: 1,
  });
  expect(result.evidence[0]?.mount).toBe("remote");
  expect(JSON.stringify(result.evidence)).toContain("amber");
  expect(result.bytes).toBeLessThanOrEqual(1500);
  expect(result.consistency).toBe("per-peer");
  db.revokeWorkloadCredential(peer.credential.credentialId);
  await expect(
    client.federatedRetrieve(space, ["remote"], { task: "Zephyr" }),
  ).rejects.toMatchObject({ code: "peer_unavailable" });
  expect(
    (await client.federatedRetrieve(space, ["remote"], { task: "Zephyr" }, true)).peers[0]?.status,
  ).toBe("unavailable");
});

it("reuses only explicit-time retrieval and invalidates on new evidence and remote revocation", async () => {
  await client.capture(space, "Zephyr port 8123");
  const input = {
    retrieval: { task: "Zephyr port", valid_at: 1000 },
    cache: "read_write" as const,
  };
  expect((await client.retrieveCached(space, input)).cache).toMatchObject({
    hit: false,
    stored: true,
  });
  expect((await client.retrieveCached(space, input)).cache.hit).toBe(true);
  await client.capture(space, "Zephyr port changed");
  expect((await client.retrieveCached(space, { ...input, cache: "read" })).cache.hit).toBe(false);
  await expect(
    client.request(`/spaces/${space}/retrieve_cached`, "POST", { retrieval: { task: "Zephyr" } }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const peer = make("cached-peer");
  const remote = (await peer.client.createSpace("remote")).id;
  await peer.client.capture(remote, "Zephyr remote port is 9090");
  federation.mount(principal, "remote", peer.client, remote);
  const across = { ...input, mounts: ["remote"] };
  expect((await client.retrieveCached(space, across)).cache.stored).toBe(true);
  expect((await client.retrieveCached(space, across)).cache.hit).toBe(true);
  db.revokeWorkloadCredential(peer.credential.credentialId);
  await expect(client.retrieveCached(space, across)).rejects.toMatchObject({
    code: "peer_unavailable",
  });
});
