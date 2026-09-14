// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { MEMORY_ASSISTANCE_READS, MEMORY_HELPER_ROLES } from "../../sdk/memory-assistance";
import type { MemoryOperationRequest } from "../../sdk/memory-operations";
import type { ToolContext } from "./index";

const schema = Type.Object({
  action: Type.Union(
    ["jobs", "get", "create", "claim", "heartbeat", "read", "finish", "cancel", "delegate"].map(
      (value) => Type.Literal(value),
    ),
  ),
  id: Type.Optional(Type.String({ description: "Assistance request ID; omit for jobs/create" })),
  space_id: Type.Optional(
    Type.String({
      description: "Owned memory space for create; defaults to your private resident space",
    }),
  ),
  lease_token: Type.Optional(
    Type.String({
      description: "Token returned by claim; required for read/heartbeat/finish/delegate",
    }),
  ),
  worker_id: Type.Optional(
    Type.String({ description: "Another participant's memory principal ID for create/delegate" }),
  ),
  role: Type.Optional(Type.Union(MEMORY_HELPER_ROLES.map((value) => Type.Literal(value)))),
  task: Type.Optional(Type.String()),
  open: Type.Optional(
    Type.Boolean({ description: "For jobs, true selects unfinished work before its deadline" }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Job page size" })),
  cursor: Type.Optional(
    Type.String({ description: "Continue jobs with next_cursor and the same open filter" }),
  ),
  max_operations: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
  request: Type.Optional(
    Type.Object({
      operation: Type.Union(
        MEMORY_ASSISTANCE_READS.map((value) => Type.Literal(value)),
        {
          description:
            "search/query search authored records; source_search searches original documents, which may have no authored record. For source_search use a few distinctive terms: default match:'all' requires every term; match:'any' broadens it. Use source_search before concluding original evidence is missing, then source_range to read it. get reads a record by ID.",
        },
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Record/source ID for get/source_range. Put the identifier here, not inside input.",
        }),
      ),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "search/source_search use query text. query uses exact subject, predicate, object, type, tier, valid_at filters; it does not take query text. graph uses subject, predicates, direction and max_depth. Omit start/end to read a source's first page.",
        }),
      ),
    }),
  ),
  completion: Type.Optional(
    Type.Object({
      status: Type.Union([Type.Literal("answered"), Type.Literal("abstained")]),
      answer: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      citations: Type.Optional(
        Type.Array(
          Type.Object({
            kind: Type.Union([Type.Literal("record"), Type.Literal("source")]),
            space_id: Type.String(),
            id: Type.String(),
            quote: Type.String(),
            version: Type.Optional(Type.Integer()),
            text_hash: Type.Optional(Type.String()),
            start: Type.Optional(Type.Integer()),
            end: Type.Optional(Type.Integer()),
          }),
        ),
      ),
    }),
  ),
  key: Type.Optional(
    Type.String({
      description:
        "Reuse a key and identical input for a retry; use a new claim key after lease expiry",
    }),
  ),
});

/** Typed handoff without mixing unrelated command-drain perceptions into the
 * result. Every operation still passes through the ordinary world memory command. */
export function createMemoryAssistanceTool(ctx: ToolContext): AgentTool<typeof schema> {
  return {
    name: "marina_memory_assistance",
    label: "Memory Assistance",
    description:
      "Ask or work as a memory librarian, reflector or evaluator. jobs with open:true lists unfinished work; follow next_cursor with the same filter. get reads the task; claim returns a lease_token. Use read with request:{operation:'source_range',id:'SOURCE'} for original evidence or request:{operation:'search',input:{query:'terms'}}. Finish with a cited answer or explicit abstention. Helpers have only the delegated read scope. Results are proposals, not verified truth. Stop when sufficient evidence answers the task; do not keep searching merely to fill a budget.",
    parameters: schema,
    execute: async (_call, params, signal) => {
      const { action, id, space_id, key, ...input } = params;
      const result = await ctx.client.memoryService(
        {
          operation: `assist_${action}` as MemoryOperationRequest["operation"],
          id,
          space_id,
          key,
          input,
        },
        35000,
        signal,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
        isError: !result.ok,
      };
    },
  };
}
