// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Static, Type } from "@sinclair/typebox";
import { MEMORY_OPERATIONS } from "../sdk/memory-operations";
import { MEMORY_WORKFLOW_ACTIONS } from "../sdk/memory-workflows";

/** Portable JSON Schemas for structured service payloads. These are not world-command
 * strings: nested claims, journals and graph operations retain their own contracts. */
const choice = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
const integer = (minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) =>
  Type.Integer({ minimum, maximum });
const optional = Type.Optional;
const unknownMap = () => Type.Record(Type.String(), Type.Unknown());
const space = optional(
  Type.String({ description: "Space ID; omit to use your configured private space" }),
);
const terms = Type.Union([
  Type.Object({ kind: Type.Literal("entity"), id: Type.String() }),
  Type.Object({
    kind: Type.Literal("literal"),
    value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
  }),
]);
const term = Type.Unsafe<Static<typeof terms>>({ oneOf: terms.anyOf });
const includeStale = optional(
  Type.Boolean({
    description: "Include unchanged authored conclusions whose premises need review",
  }),
);

export const MEMORY_TOOL_INPUTS = {
  memory_workflow: Type.Object({
    space_id: space,
    action: choice(MEMORY_WORKFLOW_ACTIONS),
    journal_space_id: optional(
      Type.String({
        description:
          "Explicitly shared task journal; requires its existing grants, separate from the corpus",
      }),
    ),
    task_id: optional(Type.String()),
    goal: optional(Type.String()),
    expected_version: optional(integer(1)),
    status: optional(choice(["completed", "interrupted", "failed"])),
    next_action: optional(Type.String()),
    name: optional(Type.String()),
    input: optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Advanced fields: retrieval options, recipe, rubric/result/explanation, ids, cursor, or id/version/task for use_recipe",
      }),
    ),
    key: optional(Type.String({ description: "Stable idempotency key for retries of mutations" })),
  }),
  memory_retrieve: Type.Object({
    space_id: space,
    task: Type.String({ description: "Question or task; use distinctive terms from the evidence" }),
    max_results: optional(integer(1, 20)),
    max_bytes: optional(
      Type.Integer({
        minimum: 256,
        maximum: 65536,
        description: "Evidence JSON budget; metadata is separate",
      }),
    ),
    source_bytes: optional(integer(64, 8192)),
    valid_at: optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "UTC milliseconds for versioned records; original documents may contain historical assertions",
      }),
    ),
    selection: optional(
      Type.Unsafe<"sources_first" | "balanced" | "records_first">({
        type: "string",
        enum: ["sources_first", "balanced", "records_first"],
        description: "Explicit ordering: balanced reserves early room for a record and a source",
      }),
    ),
    expansion: optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Explicit lexical query alternatives; see memory guide",
      }),
    ),
    requirements: optional(
      Type.Array(unknownMap(), {
        maxItems: 8,
        description: "Structural coverage: claim subject/predicate or source id/start/end",
      }),
    ),
    broaden: optional(
      Type.Boolean({
        description:
          "Supplement sparse all-term source matches once with any-term matches; default true",
      }),
    ),
  }),
  memory_service: Type.Object({
    operation: choice(MEMORY_OPERATIONS),
    space_id: space,
    id: optional(Type.String()),
    input: optional(unknownMap()),
    key: optional(
      Type.String({ description: "Reuse the same key and payload to retry a mutation" }),
    ),
  }),
  memory_assist: Type.Object({
    space_id: space,
    worker_id: Type.String({ description: "The helper's memory principal ID" }),
    role: choice(["librarian", "reflector", "evaluator"]),
    task: Type.String(),
    max_operations: optional(integer(1, 128)),
    timeout_ms: optional(integer(1000, 3600000)),
    key: optional(Type.String()),
  }),
  memory_remember: Type.Object({
    space_id: space,
    content: Type.String(),
    claim: optional(
      Type.Object({ subject: Type.String(), predicate: Type.String(), object: term }),
    ),
    valid_time: optional(
      Type.Union([
        Type.Object({
          from: Type.Union([integer(0), Type.Null()]),
          until: Type.Union([integer(0), Type.Null()]),
        }),
        Type.Null(),
      ]),
    ),
    expected_vocabulary_version: optional(integer(0)),
    source_ids: optional(Type.Array(Type.String())),
    depends_on: optional(Type.Array(Type.String())),
    dependency_versions: optional(
      Type.Record(
        Type.String(),
        Type.Integer({ exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
    ),
    type: optional(choice(["fact", "observation", "decision", "inference", "skill", "episode"])),
    metadata: optional(unknownMap()),
    key: optional(Type.String()),
  }),
  memory_query: Type.Object({
    space_id: space,
    subject: optional(Type.String()),
    predicate: optional(Type.String()),
    object: optional(term),
    type: optional(Type.String()),
    tier: optional(Type.String()),
    limit: optional(integer(1, 100)),
    cursor: optional(Type.String()),
    valid_at: optional(integer(0)),
    include_stale: includeStale,
  }),
  memory_graph: Type.Object({
    space_id: space,
    subject: Type.String(),
    predicates: optional(Type.Array(Type.String(), { maxItems: 16 })),
    direction: optional(choice(["out", "in", "both"])),
    max_depth: optional(integer(1, 5)),
    valid_at: optional(integer(0)),
    include_stale: includeStale,
    limit: optional(integer(1, 200)),
  }),
};

const graphEntity = Type.Object({
  name: Type.String(),
  entityType: Type.String(),
  observations: Type.Array(Type.String()),
});
const relation = Type.Object({
  from: Type.String(),
  to: Type.String(),
  relationType: Type.String(),
});
export const MEMORY_GRAPH_INPUTS = {
  create_entities: Type.Object({ entities: Type.Array(graphEntity) }),
  create_relations: Type.Object({ relations: Type.Array(relation) }),
  add_observations: Type.Object({
    observations: Type.Array(
      Type.Object({ entityName: Type.String(), contents: Type.Array(Type.String()) }),
    ),
  }),
  delete_entities: Type.Object({ entityNames: Type.Array(Type.String()) }),
  delete_observations: Type.Object({
    deletions: Type.Array(
      Type.Object({ entityName: Type.String(), observations: Type.Array(Type.String()) }),
    ),
  }),
  delete_relations: Type.Object({ relations: Type.Array(relation) }),
  read_graph: Type.Object({}),
  search_nodes: Type.Object({ query: Type.String() }),
  open_nodes: Type.Object({ names: Type.Array(Type.String()) }),
};
