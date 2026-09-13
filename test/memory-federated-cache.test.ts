// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import type { MemoryCacheWrite } from "../src/sdk/memory-types";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function setup() {
  const make = async (name: string) => {
    const directory = mkdtempSync(join(tmpdir(), "marina-peer-cache-"));
    const db = new MarinaDB(join(directory, "memory.db"));
    const service = new MemoryService(db);
    const owner = db.ensurePrincipal({ type: "service", displayName: name }).principal_id;
    const credential = db.issueMemoryCredential(owner);
    const client = new MarinaMemoryClient(`http://${name}.test`, credential.token, 35000, (req) =>
      handleMemoryServiceApi(req, service),
    );
    const space = (await client.createSpace(name)).id;
    cleanups.push(() => {
      db.close();
      rmSync(directory, { recursive: true });
    });
    return { db, service, client, owner, credential, space };
  };
  const local = await make("local"),
    peer = await make("peer");
  local.service.federation.mount(local.owner, "peer", peer.client, peer.space);
  const source = await peer.client.capture(peer.space, "original α🙂");
  const record = await peer.client.remember(peer.space, {
    content: "authored answer",
    source_ids: [source.id],
  });
  const basis = await peer.client.sourceRange(peer.space, source.id);
  const input: MemoryCacheWrite = {
    inputs: { question: "answer?" },
    model: "explicit-model",
    policy: "explicit-policy",
    value: { answer: "authored answer" },
    expires_at: Date.now() + 60000,
    federated: [
      { kind: "record", mount: "peer", space_id: peer.space, id: record.id, version: 1 },
      {
        kind: "source",
        mount: "peer",
        space_id: peer.space,
        id: source.id,
        content_hash: basis.content_hash,
      },
    ],
  };
  return { local, peer, input, record, source };
}

it("reuses only validated remote evidence and invalidates it after revisions or forgetting", async () => {
  const { local, peer, input, record, source } = await setup();
  const receipt = await local.client.cachePut(local.space, input, "put");
  const hit = await local.client.cacheGet(local.space, input);
  expect(hit).toMatchObject({ hit: true, value: input.value, federated: input.federated });
  expect(hit).not.toHaveProperty("seals");
  expect(hit).not.toHaveProperty("stamp");
  const actor = local.db.verifyMemoryCredential(local.credential.token)!;
  expect(local.service.repository.cacheGet(actor, local.space, input)).toEqual({
    hit: false,
    reason: "federation_validation_required",
  });
  await peer.client.revise(peer.space, record.id, 1, { content: "corrected answer" });
  expect(await local.client.cacheGet(local.space, input)).toMatchObject({
    hit: false,
    reason: "peer_basis_changed",
  });
  await expect(local.client.cachePut(local.space, input, "stale")).rejects.toMatchObject({
    code: "cache_basis_changed",
  });
  expect(await local.client.cachePut(local.space, input, "put")).toEqual(receipt);
  const sourcesOnly = {
    ...input,
    federated: input.federated!.filter((pin) => pin.kind === "source"),
  };
  await local.client.cachePut(local.space, sourcesOnly, "sources");
  await peer.client.forget(peer.space, { source_ids: [source.id] });
  expect(await local.client.cacheGet(local.space, input)).toMatchObject({ hit: false });
});

it("keeps receipt recovery available during peer outage but never returns its cached value", async () => {
  const { local, peer, input } = await setup();
  const receipt = await local.client.cachePut(local.space, input, "put");
  const offline = new MarinaMemoryClient(peer.client.url, "unused", 100, async () => {
    throw new Error("offline");
  });
  local.service.federation.mount(local.owner, "peer", offline, peer.space);
  expect(await local.client.cachePut(local.space, input, "put")).toEqual(receipt);
  expect(await local.client.cacheGet(local.space, input)).toEqual({
    hit: false,
    reason: "peer_unavailable",
  });
  await expect(local.client.cachePut(local.space, input, "new")).rejects.toMatchObject({
    status: 503,
  });
  local.service.federation.mount(local.owner, "peer", peer.client, peer.space);
  expect(await local.client.cacheGet(local.space, input)).toMatchObject({ hit: true });
  await expect(
    local.client.cachePut(local.space, { ...input, value: "different" }, "put"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
});

it("binds remote principal and endpoint identity and honors peer credential revocation", async () => {
  const { local, peer, input } = await setup();
  await local.client.cachePut(local.space, input);
  const second = peer.db.ensurePrincipal({ type: "service", displayName: "second" }).principal_id;
  await peer.client.grant(peer.space, second, "reader");
  // Capture a fresh seal after the explicit grant changed the peer generation.
  await local.client.cachePut(local.space, input);
  const credential = peer.db.issueMemoryCredential(second);
  const other = new MarinaMemoryClient(peer.client.url, credential.token, 1000, (req) =>
    handleMemoryServiceApi(req, peer.service),
  );
  local.service.federation.mount(local.owner, "peer", other, peer.space);
  expect(await local.client.cacheGet(local.space, input)).toMatchObject({
    hit: false,
    reason: "peer_basis_changed",
  });
  local.service.federation.mount(local.owner, "peer", peer.client, peer.space);
  expect(await local.client.cacheGet(local.space, input)).toMatchObject({ hit: true });
  peer.db.revokeWorkloadCredential(peer.credential.credentialId);
  expect(await local.client.cacheGet(local.space, input)).toMatchObject({ hit: false });
});

it("rechecks mounts, local access, local cache replacement and cancellation after peer waits", async () => {
  const { local, peer, input } = await setup();
  await local.client.cachePut(local.space, input);
  let trigger: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    trigger = resolve;
  });
  let held = false;
  const delayed = new MarinaMemoryClient(
    peer.client.url,
    peer.credential.token,
    1000,
    async (req) => {
      if (!held) {
        held = true;
        ready?.();
        await pause;
      }
      return handleMemoryServiceApi(req, peer.service);
    },
  );
  local.service.federation.mount(local.owner, "peer", delayed, peer.space);
  const pending = local.client.cacheGet(local.space, input);
  await waiting;
  local.service.federation.unmount(local.owner, "peer");
  trigger?.();
  expect(await pending).toMatchObject({ hit: false });

  let changed = false;
  const replace = new MarinaMemoryClient(
    peer.client.url,
    peer.credential.token,
    1000,
    async (req) => {
      if (!changed) {
        changed = true;
        await local.client.cacheDelete(local.space, input);
      }
      return handleMemoryServiceApi(req, peer.service);
    },
  );
  local.service.federation.mount(local.owner, "peer", peer.client, peer.space);
  await local.client.cachePut(local.space, input);
  local.service.federation.mount(local.owner, "peer", replace, peer.space);
  expect(await local.client.cacheGet(local.space, input)).toMatchObject({
    hit: false,
    reason: "missing",
  });

  local.service.federation.mount(local.owner, "peer", peer.client, peer.space);
  await local.client.cachePut(local.space, input);
  const controller = new AbortController();
  const never = new MarinaMemoryClient(peer.client.url, peer.credential.token, 1000, async () => {
    controller.abort();
    return new Promise<Response>(() => {});
  });
  local.service.federation.mount(local.owner, "peer", never, peer.space);
  await expect(
    local.client.withSignal(controller.signal).cacheGet(local.space, input),
  ).rejects.toBeDefined();

  const revoke = new MarinaMemoryClient(
    peer.client.url,
    peer.credential.token,
    1000,
    async (req) => {
      local.db.revokeWorkloadCredential(local.credential.credentialId);
      return handleMemoryServiceApi(req, peer.service);
    },
  );
  local.service.federation.mount(local.owner, "peer", revoke, peer.space);
  await expect(local.client.cacheGet(local.space, input)).rejects.toMatchObject({ status: 401 });
});
