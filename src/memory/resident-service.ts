// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { handleMemoryServiceApi } from "../net/memory-service-api";
import type { MarinaDB } from "../persistence/database";
import { MarinaMemoryClient, MemoryClientError } from "../sdk/memory-client";
import { type MemoryOperationRequest, runMemoryOperation } from "../sdk/memory-operations";
import { worldMemoryService } from "./world-service";

interface Binding {
  client: MarinaMemoryClient;
  space?: Promise<string>;
  expiresAt: number;
}
const bindings = new WeakMap<MarinaDB, Map<string, Binding>>();

/** Bind only the server-resolved durable world account, never an input identity. */
export async function residentMemoryOperation(
  db: MarinaDB,
  name: string,
  request: MemoryOperationRequest,
) {
  const user = db.getUserByName(name);
  const principal = db.getPrincipal("human", name);
  if (!user || !principal || user.id !== principal.principal_id || principal.status !== "active")
    throw new MemoryClientError(
      401,
      "world_identity_required",
      "An active durable world account is required",
    );
  let cache = bindings.get(db);
  if (!cache) {
    cache = new Map();
    bindings.set(db, cache);
  }
  let binding = cache.get(user.id);
  if (!binding || binding.expiresAt <= Date.now()) {
    const credential = db.issueMemoryCredential(principal.principal_id);
    const client = new MarinaMemoryClient(
      "http://marina.internal",
      credential.token,
      35000,
      (request) => handleMemoryServiceApi(request, worldMemoryService(db)),
    );
    binding = { client, expiresAt: credential.expiresAt };
    cache.set(user.id, binding);
  }
  if (["usage", "capabilities", "me", "spaces", "create_space"].includes(request.operation))
    return { ok: true as const, result: await runMemoryOperation(binding.client, request) };
  const space =
    request.space_id ??
    (await (binding.space ??= binding.client
      .spaces()
      .then(
        async ({ spaces }) =>
          spaces.find((s) => s.owner_id === principal.principal_id && s.name === "resident")?.id ??
          (
            await binding!.client.createSpace("resident", `resident:${principal.principal_id}`)
          ).id,
      )
      .catch((error) => {
        // Keep the credential, but let transient initialization failures retry.
        binding!.space = undefined;
        throw error;
      })));
  return {
    ok: true as const,
    space_id: space,
    result: await runMemoryOperation(binding.client, request, space),
  };
}
