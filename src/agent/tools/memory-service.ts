// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `marina_memory_service` — the ONE compact durable-memory tool (records,
// evidence, checkpoints and the assist_* helper operations); its resident
// schema is capped at 2 KB by test/tools-deferred.test.ts.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { MarinaClient } from "../../sdk/client";
import { MEMORY_OPERATIONS } from "../../sdk/memory-operations";
import type { ToolContext } from "./shared";

const memoryServiceSchema = Type.Object({
  // A plain `enum` (not a 60-literal anyOf) keeps this schema ~700 B smaller;
  // pi-ai validates it the same way.
  operation: Type.String({
    enum: [...MEMORY_OPERATIONS],
    description:
      'Operation. `capabilities` lists them; `workflow` with input {action:"help"} explains task workflows.',
  }),
  space_id: Type.Optional(Type.String({ description: "Omit for your private space" })),
  id: Type.Optional(
    Type.String({
      description: "Record / source / job id when the operation targets one",
    }),
  ),
  input: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Payload: retrieve {task}; search {query}; remember {content, claim?}; assist_create {role, task, worker_id}; assist_read/finish {lease_token, request?, completion?}",
    }),
  ),
  key: Type.Optional(
    Type.String({ description: "Idempotency key; reuse it when retrying a mutation" }),
  ),
});

/**
 * ONE memory-service tool: durable records, evidence, checkpoints AND the
 * assistance (helper job) operations, which used to be a second 4 KB typed
 * tool (`marina_memory_assistance`). That typed variant still exists as a
 * DEFERRED tool for agents that want per-field schemas; this resident surface
 * stays ≤ 2 KB (enforced by test/tools-deferred.test.ts).
 */
export function createMemoryServiceTool(ctx: ToolContext): AgentTool<typeof memoryServiceSchema> {
  return {
    name: "marina_memory_service",
    label: "Memory Service",
    description:
      "Durable private/shared memory, evidence, checkpoints and helper assistance (assist_* ops: helpers hold a lease_token, read only the delegated scope, finish with citations or an explicit abstention). Start with retrieve {task} for citable evidence and check its diagnostics. Claims and proposals are assertions, not verified truth.",
    parameters: memoryServiceSchema,
    execute: async (_id, request, signal) => {
      const result = await ctx.client.memoryService(
        request as Parameters<MarinaClient["memoryService"]>[0],
        35000,
        signal,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}
