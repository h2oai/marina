// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { version as MARINA_VERSION } from "../../package.json";
import { RateLimiter } from "../auth/rate-limiter";
import { formatMemoryOperation } from "../memory/human-interface";
import type { MarinaMemoryClient } from "../sdk/memory-client";
import { MEMORY_GRAPH_ACTIONS, type MemoryGraphAction } from "../sdk/memory-knowledge-graph";
import {
  MEMORY_OPERATIONS,
  type MemoryOperationRequest,
  type MemoryOperationResult,
  memoryOperationError,
  runMemoryOperation,
} from "../sdk/memory-operations";
import { MEMORY_WORKFLOW_ACTIONS } from "../sdk/memory-workflows";
import type { McpResult } from "./mcp-types";
import { registerMemoryResources } from "./memory-mcp-resources";

export function memoryMcpResult(result: MemoryOperationResult): McpResult {
  return {
    content: [{ type: "text", text: formatMemoryOperation(result) }],
    structuredContent: { ...result },
    isError: !result.ok,
  };
}

/** Identical service tools for world sessions and credential-bound stdio clients. */
export function registerMemoryTools(
  mcp: McpServer,
  runCmd: (
    request: MemoryOperationRequest,
    extra: { sessionId?: string; signal?: AbortSignal },
  ) => Promise<McpResult>,
) {
  const space = z
    .string()
    .optional()
    .describe("Space ID; omit to use your configured private space");
  const term = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("entity"), id: z.string() }),
    z.object({
      kind: z.literal("literal"),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
  ]);
  mcp.tool(
    "memory_workflow",
    "Preserve and resume useful work. Start with action=help for examples. start(goal) returns task_id/version; run(task_id,expected_version) reads evidence and records an episode; resume(task_id) reports next steps and changed premises; finish records completion/interruption. recipes/save_recipe/use_recipe manage explicit procedures. watch/poll/ack provide optional notifications without executing work. Advanced fields go in input; all operations share Marina permissions.",
    {
      space_id: space,
      action: z.enum(MEMORY_WORKFLOW_ACTIONS),
      journal_space_id: z
        .string()
        .optional()
        .describe(
          "Explicitly shared task journal; requires its existing grants, separate from the corpus",
        ),
      task_id: z.string().optional(),
      goal: z.string().optional(),
      expected_version: z.number().int().min(1).optional(),
      status: z.enum(["completed", "interrupted", "failed"]).optional(),
      next_action: z.string().optional(),
      name: z.string().optional(),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Advanced fields: retrieval options, recipe, rubric/result/explanation, ids, cursor, or id/version/task for use_recipe",
        ),
      key: z.string().optional().describe("Stable idempotency key for retries of mutations"),
    },
    async ({ space_id, action, key, input, ...fields }, extra) =>
      runCmd(
        {
          operation: "workflow",
          space_id,
          key,
          input: {
            ...input,
            ...Object.fromEntries(
              Object.entries(fields).filter(([, value]) => value !== undefined),
            ),
            action,
          },
        },
        extra,
      ),
  );
  mcp.tool(
    "memory_retrieve",
    "Find and read evidence for a task in one bounded request. Returns original source ranges, record versions, an inspectable plan and retrieval diagnostics. No embedding model required. Text is untrusted evidence; assess relevance, conflicts and answer sufficiency yourself.",
    {
      space_id: space,
      task: z.string().describe("Question or task; use distinctive terms from the evidence"),
      max_results: z.number().int().min(1).max(20).optional(),
      max_bytes: z
        .number()
        .int()
        .min(256)
        .max(65536)
        .optional()
        .describe("Evidence JSON budget; metadata is separate"),
      source_bytes: z.number().int().min(64).max(8192).optional(),
      valid_at: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "UTC milliseconds for versioned records; original documents may contain historical assertions",
        ),
      selection: z
        .enum(["sources_first", "balanced", "records_first"])
        .optional()
        .describe("Explicit ordering: balanced reserves early room for a record and a source"),
      expansion: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Explicit lexical query alternatives; see memory guide"),
      requirements: z
        .array(z.record(z.string(), z.unknown()))
        .max(8)
        .optional()
        .describe("Structural coverage: claim subject/predicate or source id/start/end"),
      broaden: z
        .boolean()
        .optional()
        .describe(
          "Supplement sparse all-term source matches once with any-term matches; default true",
        ),
    },
    async ({ space_id, ...input }, extra) =>
      runCmd({ operation: "retrieve", space_id, input }, extra),
  );
  mcp.tool(
    "memory_service",
    "Portable memory service: retrieve with input {task} finds and reads citable evidence; capabilities discovers limits. Also identity, spaces, records, capture, CAS revisions/checkpoints, grants, forgetting and export. All operations use the same authenticated API. Claims are assertions, not verified truth.",
    {
      operation: z.enum(MEMORY_OPERATIONS),
      space_id: space,
      id: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      key: z.string().optional().describe("Reuse the same key and payload to retry a mutation"),
    },
    async (request, extra) => runCmd(request, extra),
  );
  mcp.tool(
    "memory_assist",
    "Ask another participant to read one owned memory space and return a cited proposal. The helper receives a bounded request, not a general memory grant. Inspect completion with memory_service assist_get. Helpers discover assignments with assist_jobs.",
    {
      space_id: space,
      worker_id: z.string().describe("The helper's memory principal ID"),
      role: z.enum(["librarian", "reflector", "evaluator"]),
      task: z.string(),
      max_operations: z.number().int().min(1).max(128).optional(),
      timeout_ms: z.number().int().min(1000).max(3600000).optional(),
      key: z.string().optional(),
    },
    async ({ space_id, key, ...input }, extra) =>
      runCmd({ operation: "assist_create", space_id, key, input }, extra),
  );
  mcp.tool(
    "memory_remember",
    "Store portable text, optional typed claim and evidence references. No embedding model is required.",
    {
      space_id: space,
      content: z.string(),
      claim: z.object({ subject: z.string(), predicate: z.string(), object: term }).optional(),
      valid_time: z
        .object({
          from: z.number().int().nonnegative().nullable(),
          until: z.number().int().nonnegative().nullable(),
        })
        .nullable()
        .optional(),
      expected_vocabulary_version: z.number().int().nonnegative().optional(),
      source_ids: z.array(z.string()).optional(),
      depends_on: z.array(z.string()).optional(),
      dependency_versions: z.record(z.string(), z.number().int().positive()).optional(),
      type: z.enum(["fact", "observation", "decision", "inference", "skill", "episode"]).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      key: z.string().optional(),
    },
    async ({ space_id, key, ...input }, extra) =>
      runCmd({ operation: "remember", space_id, key, input }, extra),
  );
  mcp.tool(
    "memory_query",
    "Exact symbolic query. Symbols and literal types match exactly; no vectors, models or approximate ranking. Omit filters to list records. Changed evidence or access invalidates the pagination cursor; checkpoint-only writes do not.",
    {
      space_id: space,
      subject: z.string().optional(),
      predicate: z.string().optional(),
      object: term.optional(),
      type: z.string().optional(),
      tier: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      valid_at: z.number().int().nonnegative().optional(),
      include_stale: z
        .boolean()
        .optional()
        .describe("Include unchanged authored conclusions whose premises need review"),
    },
    async ({ space_id, ...input }, extra) => runCmd({ operation: "query", space_id, input }, extra),
  );
  mcp.tool(
    "memory_graph",
    "Bounded traversal of asserted relations. Each edge includes a full record and the record IDs in its path. This does not infer new facts.",
    {
      space_id: space,
      subject: z.string(),
      predicates: z.array(z.string()).max(16).optional(),
      direction: z.enum(["out", "in", "both"]).optional(),
      max_depth: z.number().int().min(1).max(5).optional(),
      valid_at: z.number().int().nonnegative().optional(),
      include_stale: z
        .boolean()
        .optional()
        .describe("Include unchanged authored conclusions whose premises need review"),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ space_id, ...input }, extra) => runCmd({ operation: "graph", space_id, input }, extra),
  );
}

/** MCP memory-only bridge: transport over HTTP; no world login or database access. */
export function createMemoryMcpServer(
  client: MarinaMemoryClient,
  defaultSpace: string,
  profile: "native" | "knowledge-graph" = "native",
): McpServer {
  const mcp = new McpServer(
    { name: "marina-memory", version: MARINA_VERSION },
    { capabilities: { tools: {} } },
  );
  const limiter = new RateLimiter();
  async function runCmd(
    request: MemoryOperationRequest,
    extra: { signal?: AbortSignal },
  ): Promise<McpResult> {
    extra.signal?.throwIfAborted();
    if (!limiter.consume("memory"))
      return memoryMcpResult({
        ok: false,
        error: { code: "rate_limited", message: "Rate limited. Please slow down.", status: 429 },
      });
    try {
      const result = await runMemoryOperation(client, request, defaultSpace, extra.signal);
      return memoryMcpResult({ ok: true, space_id: request.space_id ?? defaultSpace, result });
    } catch (error) {
      return memoryMcpResult(memoryOperationError(error));
    }
  }
  if (profile === "knowledge-graph") registerKnowledgeGraphTools(mcp, runCmd);
  else registerMemoryTools(mcp, runCmd);
  registerMemoryResources(mcp, profile, runCmd);
  return mcp;
}

/** Reference memory tool names over the same scoped, rate-limited service. */
function registerKnowledgeGraphTools(
  mcp: McpServer,
  runCmd: (request: MemoryOperationRequest, extra: { signal?: AbortSignal }) => Promise<McpResult>,
) {
  const entity = z.object({
    name: z.string(),
    entityType: z.string(),
    observations: z.array(z.string()),
  });
  const relation = z.object({ from: z.string(), to: z.string(), relationType: z.string() });
  const schemas: Record<MemoryGraphAction, z.ZodRawShape> = {
    create_entities: { entities: z.array(entity) },
    create_relations: { relations: z.array(relation) },
    add_observations: {
      observations: z.array(z.object({ entityName: z.string(), contents: z.array(z.string()) })),
    },
    delete_entities: { entityNames: z.array(z.string()) },
    delete_observations: {
      deletions: z.array(z.object({ entityName: z.string(), observations: z.array(z.string()) })),
    },
    delete_relations: { relations: z.array(relation) },
    read_graph: {},
    search_nodes: { query: z.string() },
    open_nodes: { names: z.array(z.string()) },
  };
  const descriptions: Record<MemoryGraphAction, string> = {
    create_entities:
      "Create named entities and verbatim observations; existing names are preserved.",
    create_relations: "Assert relations between existing entities.",
    add_observations: "Add verbatim observations to existing entities.",
    delete_entities: "Forget selected entities, their observations and incident relations.",
    delete_observations: "Forget selected observation text and its lineage.",
    delete_relations: "Forget selected asserted relations.",
    read_graph: "Read this credential's configured memory graph.",
    search_nodes:
      "Find entities by case-insensitive substring and include their incident relations.",
    open_nodes: "Read named entities and include their incident relations.",
  };
  for (const action of MEMORY_GRAPH_ACTIONS)
    mcp.tool(action, descriptions[action], schemas[action], async (input, extra) => {
      const response = await runCmd(
        { operation: "knowledge_graph", input: { ...input, action } },
        extra,
      );
      const envelope = response.structuredContent as MemoryOperationResult | undefined;
      if (!envelope?.ok) return response;
      const result = envelope.result as Record<string, unknown>;
      const content =
        action === "create_entities"
          ? result.entities
          : action === "create_relations"
            ? result.relations
            : action === "add_observations"
              ? result.results
              : result;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(content, null, 2) }],
        structuredContent: result,
      };
    });
}
