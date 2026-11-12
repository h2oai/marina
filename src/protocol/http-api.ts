// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// marina.http.v1 — the HTTP APIs every Marina SDK calls, listed once.
//
// Each operation names its body and reply as TypeScript types from `src/sdk/`
// (the same types the server imports). `bun run docs:api` turns this table and
// those types into `protocol/marina.http.v1.openapi.json` (OpenAPI 3.1), the
// server serves it at `GET /api/openapi`, and `test/http-openapi.test.ts` drives
// a live server through the SDK clients and checks every request and reply
// against it. The WebSocket protocol is `wire.ts`.

export const HTTP_API_VERSION = "marina.http.v1";
/** Where a running server serves the OpenAPI document. */
export const HTTP_API_SCHEMA_PATH = "/api/openapi";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type HttpApiTag = "memory" | "routing" | "investigations" | "panels";

export interface QueryParameter {
  type: "string" | "number" | "boolean";
  required?: boolean;
  description?: string;
}

export interface HttpOperation {
  /** Unique; the SDK method that calls it, prefixed by the API where names collide. */
  id: string;
  method: HttpMethod;
  /** Path with `{param}` placeholders (all string-valued). */
  path: string;
  tag: HttpApiTag;
  summary: string;
  description?: string;
  query?: Record<string, QueryParameter>;
  /** Request body as a TypeScript type over the SDK's exported types. */
  body?: string;
  /** Success reply as a TypeScript type. */
  response: string;
  /** Success status; default 200. Several when the server says which (e.g. created or replayed). */
  status?: number | number[];
}

// ─── Memory: /v1/memory ──────────────────────────────────────────────────────

/**
 * Memory writes that the server runs without an `Idempotency-Key`: reads sent as
 * POST because they carry a body. Every other memory POST/PATCH requires the key.
 */
export const MEMORY_KEYLESS_POSTS = [
  "/search",
  "/context",
  "/query",
  "/graph",
  "/source_search",
  "/plan",
  "/execute_plan",
  "/retrieve",
  "/workflow",
  "/federated_retrieve",
  "/retrieve_cached",
  "/review",
  "/cache/get",
  "/federated_search",
  "/federated_read",
  "/knowledge_graph",
] as const;

const S = "/v1/memory/spaces/{space}";
const J = "/v1/memory/assistance/{job}";
const Receipt = "MemoryReceipt";

const memory: Omit<HttpOperation, "tag">[] = [
  {
    id: "capabilities",
    method: "GET",
    path: "/v1/memory",
    summary: "What this memory service offers",
    response: "Record<string, unknown>",
  },
  {
    id: "me",
    method: "GET",
    path: "/v1/memory/me",
    summary: "Who the presented credential is",
    response: "{ principal_id: string; credential_id: string; scopes: string[] }",
  },
  {
    id: "usage",
    method: "GET",
    path: "/v1/memory/usage",
    summary: "Storage used and its limits",
    response: "MemoryStorageUsage",
  },
  {
    id: "spaces",
    method: "GET",
    path: "/v1/memory/spaces",
    summary: "Spaces this credential can read",
    response: "{ spaces: MemorySpace[] }",
  },
  {
    id: "createSpace",
    method: "POST",
    path: "/v1/memory/spaces",
    summary: "Create a space",
    body: "{ name: string }",
    response: Receipt,
    status: 201,
  },
  {
    id: "space",
    method: "GET",
    path: S,
    summary: "One space",
    response: "MemorySpace",
  },
  {
    id: "remember",
    method: "POST",
    path: `${S}/records`,
    summary: "Write a record",
    body: "MemoryRecordInput",
    response: Receipt,
    status: [200, 201],
  },
  {
    id: "get",
    method: "GET",
    path: `${S}/records/{id}`,
    summary: "Read a record, or one of its earlier versions",
    query: { version: { type: "number" } },
    response: "MemoryRecord",
  },
  {
    id: "revise",
    method: "PATCH",
    path: `${S}/records/{id}`,
    summary: "Revise a record (compare-and-set on its version)",
    body: "MemoryRecordInput & { expected_version: number }",
    response: Receipt,
  },
  {
    id: "search",
    method: "POST",
    path: `${S}/search`,
    summary: "Search records",
    body: "MemorySearchInput",
    response: "MemorySearchResult",
  },
  {
    id: "context",
    method: "POST",
    path: `${S}/context`,
    summary: "A prompt-ready context block with citations, within a token budget",
    body: "MemorySearchInput & { budget_tokens?: number }",
    response:
      "{ text: string; citations: { id: string; version: number; source_ids: string[]; truncated: boolean }[]; estimated_tokens: number; generation: number; degraded: string[] }",
  },
  {
    id: "query",
    method: "POST",
    path: `${S}/query`,
    summary: "Structured query over claims",
    body: "MemoryQuery",
    response: "MemoryQueryResult",
  },
  {
    id: "graph",
    method: "POST",
    path: `${S}/graph`,
    summary: "Walk the claim graph from a subject",
    body: "MemoryGraphQuery",
    response: "MemoryGraphResult",
  },
  {
    id: "join",
    method: "POST",
    path: `${S}/join`,
    summary: "Join claim patterns",
    body: "MemoryJoin",
    response: "MemoryJoinResult",
  },
  {
    id: "saveRule",
    method: "POST",
    path: `${S}/rules`,
    summary: "Save an inference rule",
    body: "{ rule: MemoryRule; id?: string; expected_version?: number; source_ids?: string[] }",
    response: Receipt,
    status: [200, 201],
  },
  {
    id: "runRule",
    method: "POST",
    path: `${S}/rules/run`,
    summary: "Run a rule without writing",
    body: "{ id: string; expected_version: number; valid_at?: number }",
    response: "MemoryRuleResult",
  },
  {
    id: "materializeRule",
    method: "POST",
    path: `${S}/rules/materialize`,
    summary: "Run a rule and write what it infers",
    body: "{ id: string; expected_version: number; valid_at?: number }",
    response: "MemoryReceipt & { records: MemoryReceipt[] }",
    status: [200, 201],
  },
  {
    id: "knowledgeGraph",
    method: "POST",
    path: `${S}/knowledge_graph`,
    summary: "Entity/relation/observation graph operations",
    description:
      "`action` picks the operation; the other fields are that action's input (see MemoryGraphInputs).",
    body: "{ action: MemoryGraphAction } & Record<string, unknown>",
    response: "Record<string, unknown>",
  },
  {
    id: "review",
    method: "POST",
    path: `${S}/review`,
    summary: "Records that need a decision: stale, competing or pending",
    body: '{ kind?: "all" | "stale" | "competing" | "pending"; limit?: number; cursor?: string }',
    response: "MemoryReviewResult",
  },
  {
    id: "reaffirm",
    method: "POST",
    path: `${S}/reaffirm`,
    summary: "Confirm a stale record still holds against its dependencies",
    body: "{ id: string; expected_version: number; dependency_versions: Record<string, number>; content?: string }",
    response: Receipt,
  },
  {
    id: "resolve",
    method: "POST",
    path: `${S}/resolve`,
    summary: "Settle a contradiction: keep the head, close its rivals",
    body: "MemoryResolveInput & { id: string }",
    response: "MemoryResolveResult",
  },
  {
    id: "adopt",
    method: "POST",
    path: `${S}/adopt`,
    summary: "Adopt an answered assistance proposal into this space",
    body: "MemoryAdoptInput",
    response: "MemoryAdoptResult",
    status: [200, 201],
  },
  {
    id: "acknowledge",
    method: "POST",
    path: `${S}/acknowledge`,
    summary: "Acknowledge change notifications by key",
    body: "{ keys: string[] }",
    response: "{ acknowledged: string[]; missing: string[] }",
  },
  {
    id: "forget",
    method: "POST",
    path: `${S}/forget`,
    summary: "Erase records or sources",
    body: "ForgetMemoryInput",
    response: Receipt,
  },
  {
    id: "grant",
    method: "POST",
    path: `${S}/grants`,
    summary: "Give a principal read or write access (null removes it)",
    body: '{ principal_id: string; role: "reader" | "writer" | null }',
    response: Receipt,
  },
  {
    id: "reindex",
    method: "POST",
    path: `${S}/reindex`,
    summary: "Re-embed records, one page at a time",
    body: "{ expected_generation: number; cursor?: string; limit?: number }",
    response:
      "MemoryReceipt & { model: string; job_ids: string[]; examined: number; next_cursor: string | null; generation: number }",
  },
  {
    id: "cacheGet",
    method: "POST",
    path: `${S}/cache/get`,
    summary: "Read a cached derived value, if still valid",
    body: "MemoryCacheInput",
    response: "MemoryCacheResult",
  },
  {
    id: "cachePut",
    method: "POST",
    path: `${S}/cache/put`,
    summary: "Cache a derived value pinned to the records and sources it used",
    body: "MemoryCacheWrite",
    response: Receipt,
  },
  {
    id: "cacheDelete",
    method: "POST",
    path: `${S}/cache/delete`,
    summary: "Drop a cached value",
    body: "MemoryCacheInput",
    response: "MemoryReceipt & { removed: boolean }",
  },
  {
    id: "plan",
    method: "POST",
    path: `${S}/plan`,
    summary: "Plan the retrieval steps for a task",
    body: "{ task: string; use_model?: boolean; steps?: MemoryPlanStep[]; max_results?: number; max_bytes?: number }",
    response: "MemoryPlan",
  },
  {
    id: "executePlan",
    method: "POST",
    path: `${S}/execute_plan`,
    summary: "Run a retrieval plan",
    body: "MemoryPlan",
    response: "MemoryPlanResult",
  },
  {
    id: "retrieve",
    method: "POST",
    path: `${S}/retrieve`,
    summary: "Find and read citable evidence in one bounded request",
    body: "MemoryRetrievalInput",
    response: "MemoryRetrievalResult",
  },
  {
    id: "retrieveCached",
    method: "POST",
    path: `${S}/retrieve_cached`,
    summary: "Retrieve, reusing a cached result while its evidence is unchanged",
    body: "MemoryCachedRetrievalInput",
    response: "MemoryCachedRetrievalResult",
  },
  {
    id: "federatedRetrieve",
    method: "POST",
    path: `${S}/federated_retrieve`,
    summary: "Retrieve across mounted peer spaces",
    body: "{ mounts: string[]; retrieval: MemoryRetrievalInput; allow_partial?: boolean }",
    response: "MemoryFederatedRetrievalResult",
  },
  {
    id: "federationMounts",
    method: "GET",
    path: `${S}/federation_mounts`,
    summary: "Peer spaces this principal can search",
    response: "{ mounts: string[] }",
  },
  {
    id: "federatedSearch",
    method: "POST",
    path: `${S}/federated_search`,
    summary: "Search mounted peer spaces",
    body: "MemoryFederatedSearch",
    response: "MemoryFederatedResult",
  },
  {
    id: "federatedRead",
    method: "POST",
    path: `${S}/federated_read`,
    summary: "Read one item from a mounted peer space",
    body: "MemoryFederatedRead",
    response:
      "{ origin: { mount: string; space_id: string; id: string }; result: MemoryRecord | MemorySourceRange }",
  },
  {
    id: "vocabulary",
    method: "GET",
    path: `${S}/vocabulary`,
    summary: "The space's vocabulary (current, or a version)",
    query: { version: { type: "number" } },
    response: "MemoryVocabulary",
  },
  {
    id: "saveVocabulary",
    method: "POST",
    path: `${S}/vocabulary`,
    summary: "Replace the vocabulary (compare-and-set on its version)",
    body: "{ expected_version: number; definition: MemoryVocabularyDefinition }",
    response: Receipt,
  },
  {
    id: "capture",
    method: "POST",
    path: `${S}/sources`,
    summary: "Capture a source (raw evidence)",
    body: "{ content: unknown; session_id?: string }",
    response: Receipt,
    status: [200, 201],
  },
  {
    id: "captureBatch",
    method: "POST",
    path: `${S}/sources/batch`,
    summary: "Capture several sources, each with its own key",
    body: "{ items: { content: unknown; session_id?: string; key: string }[] }",
    response: "MemoryReceipt & { receipts: MemoryReceipt[] }",
    status: [200, 201],
  },
  {
    id: "sources",
    method: "GET",
    path: `${S}/sources`,
    summary: "Sources after a cursor, oldest first",
    query: { after: { type: "number" }, limit: { type: "number" } },
    response: "{ sources: MemorySource[]; next_cursor: number }",
  },
  {
    id: "sourceHeaders",
    method: "GET",
    path: `${S}/source_headers`,
    summary: "Source headers (no bodies) after a cursor",
    query: { after: { type: "number" }, limit: { type: "number" } },
    response: '{ sources: Omit<MemorySource, "body">[]; next_cursor: number | null }',
  },
  {
    id: "sourceRange",
    method: "GET",
    path: `${S}/sources/{id}`,
    summary: "Read a range of a source",
    query: {
      start: { type: "number" },
      end: { type: "number" },
      text_hash: { type: "string", description: "Fail unless the range still has this hash." },
    },
    response: "MemorySourceRange",
  },
  {
    id: "sourceSearch",
    method: "POST",
    path: `${S}/source_search`,
    summary: "Search source text",
    body: "MemorySourceSearch",
    response: "MemorySourceSearchResult",
  },
  {
    id: "checkpoint",
    method: "GET",
    path: `${S}/checkpoints/{name}`,
    summary: "Read a named checkpoint",
    response: "MemoryCheckpoint",
  },
  {
    id: "saveCheckpoint",
    method: "POST",
    path: `${S}/checkpoints/{name}`,
    summary: "Save a named checkpoint (compare-and-set on its version)",
    body: "{ expected_version: number; data: Record<string, unknown>; source_cursor?: number; source_ids?: string[] }",
    response: Receipt,
  },
  {
    id: "captureCheckpoint",
    method: "POST",
    path: `${S}/checkpoints/{name}/capture`,
    summary: "Capture sources and the checkpoint naming them in one transaction",
    body: "MemoryCheckpointCapture",
    response: "MemoryCheckpointCaptureReceipt",
    status: [200, 201],
  },
  {
    id: "exportBundle",
    method: "GET",
    path: `${S}/bundle`,
    summary: "Export the space as one bundle",
    response: "MemoryBundle",
  },
  {
    id: "importBundle",
    method: "POST",
    path: `${S}/bundle`,
    summary: "Import a bundle into the space",
    body: "MemoryBundle",
    response: "MemoryReceipt & { portable_ids_preserved: boolean }",
    status: [200, 201],
  },
  {
    id: "exportTransferPage",
    method: "GET",
    path: `${S}/transfer`,
    summary: "Export the space page by page",
    query: { cursor: { type: "string" } },
    response: "MemoryTransferPage",
  },
  {
    id: "beginTransfer",
    method: "POST",
    path: `${S}/transfers`,
    summary: "Begin a paged import",
    body: "MemoryTransferHeader",
    response: "MemoryTransferStatus",
    status: [200, 201],
  },
  {
    id: "transfers",
    method: "GET",
    path: `${S}/transfers`,
    summary: "Paged imports into this space",
    query: { state: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } },
    response: "MemoryTransferList",
  },
  {
    id: "transferStatus",
    method: "GET",
    path: `${S}/transfers/{id}`,
    summary: "One paged import",
    response: "MemoryTransferStatus",
  },
  {
    id: "appendTransfer",
    method: "POST",
    path: `${S}/transfers/{id}/pages`,
    summary: "Add a page to a paged import",
    body: "MemoryTransferPage",
    response: "MemoryTransferStatus",
  },
  {
    id: "commitTransfer",
    method: "POST",
    path: `${S}/transfers/{id}/commit`,
    summary: "Commit a paged import, checked against its hash",
    body: "{ sha256: string }",
    response: "MemoryReceipt & { portable_ids_preserved: boolean }",
  },
  {
    id: "abortTransfer",
    method: "POST",
    path: `${S}/transfers/{id}/abort`,
    summary: "Abandon a paged import",
    body: "{}",
    response: Receipt,
  },
  {
    id: "export",
    method: "GET",
    path: `${S}/export`,
    summary: "Everything in the space as JSON",
    response: "Record<string, unknown>",
  },
  {
    id: "job",
    method: "GET",
    path: `${S}/jobs/{id}`,
    summary: "An index job (a receipt's job_id)",
    response: "MemoryJobStatus",
  },
  {
    id: "jsonStore",
    method: "POST",
    path: `${S}/json_store`,
    summary: "Key-value JSON documents in namespaces, as one atomic batch (1-64 operations)",
    description:
      "Each operation is one of: read (`namespace` + `key`), write (`value`; `null` deletes), search (`namespacePrefix`, optional `query`/`filter`), or list namespaces (`matchConditions`). `results` has one entry per operation, in order.",
    body: "{ operations: ({ namespace: string[]; key: string; value?: Record<string, unknown> | null; index?: unknown } | { namespacePrefix: string[]; filter?: Record<string, unknown>; query?: string; limit?: number; offset?: number } | { matchConditions?: unknown[]; maxDepth?: number; limit?: number; offset?: number })[] }",
    response: "{ results: unknown[] }",
  },
  {
    id: "workflow",
    method: "POST",
    path: `${S}/workflow`,
    summary: "Task workflows over memory: start, run, finish, resume, recipes, watches",
    description: "`action` picks the operation; the other fields are its input.",
    body: "{ action: (typeof MEMORY_WORKFLOW_ACTIONS)[number] } & Record<string, unknown>",
    response: "Record<string, unknown>",
  },
  {
    id: "assistCreate",
    method: "POST",
    path: `${S}/assistance`,
    summary: "Ask a helper for memory work",
    body: "MemoryAssistanceInput",
    response: "{ id: string }",
    status: 201,
  },
  {
    id: "assistJobs",
    method: "GET",
    path: "/v1/memory/assistance",
    summary: "Assistance jobs for this principal",
    query: { open: { type: "boolean" }, limit: { type: "number" }, cursor: { type: "string" } },
    response: "MemoryAssistancePage",
  },
  {
    id: "assistGet",
    method: "GET",
    path: J,
    summary: "One assistance job",
    response: "MemoryAssistanceJob",
  },
  {
    id: "assistClaim",
    method: "POST",
    path: `${J}/claim`,
    summary: "Claim a job (as its worker); returns a lease",
    body: "{}",
    response: "{ id: string; lease_token: string; lease_until: number }",
  },
  {
    id: "assistHeartbeat",
    method: "POST",
    path: `${J}/heartbeat`,
    summary: "Extend the lease",
    body: "{ lease_token: string }",
    response: "{ id: string; lease_until: number }",
  },
  {
    id: "assistRead",
    method: "POST",
    path: `${J}/read`,
    summary: "Run one read operation inside the job's scope",
    body: "{ lease_token: string; request: { operation: string; id?: string; input?: Record<string, unknown> } }",
    response: "unknown",
  },
  {
    id: "assistFinish",
    method: "POST",
    path: `${J}/finish`,
    summary: "Finish with an answer (cited) or an abstention",
    body: "{ lease_token: string; completion: MemoryAnswer }",
    response: '{ id: string; state: MemoryAssistanceJob["state"]; result_record_id: string }',
  },
  {
    id: "assistCancel",
    method: "POST",
    path: `${J}/cancel`,
    summary: "Cancel a job",
    body: "{}",
    response: '{ id: string; state: MemoryAssistanceJob["state"] }',
  },
  {
    id: "assistDelegate",
    method: "POST",
    path: `${J}/delegate`,
    summary: "Hand part of the job to another helper",
    body: 'Pick<MemoryAssistanceInput, "worker_id" | "role" | "task"> & { lease_token: string }',
    response: "{ id: string }",
    status: 201,
  },
  {
    id: "assistAdopt",
    method: "POST",
    path: `${J}/adopt`,
    summary: "Adopt the job's answer into its own space",
    body: 'Omit<MemoryAdoptInput, "job_id">',
    response: "MemoryAdoptResult",
    status: [200, 201],
  },
];

// ─── Participant routing: /api/routing ───────────────────────────────────────

const R = "/api/routing/sessions/{session}";
const routing: Omit<HttpOperation, "tag">[] = [
  {
    id: "joinSession",
    method: "POST",
    path: "/api/routing/sessions",
    summary: "Join as a routed participant session",
    body: "RoutingJoin",
    response: "RoutingSession",
  },
  {
    id: "discover",
    method: "GET",
    path: "/api/routing/sessions",
    summary: "Sessions you can see",
    query: { after: { type: "string" }, limit: { type: "number" } },
    response: "RoutingSessionPage",
  },
  {
    id: "overview",
    method: "GET",
    path: "/api/routing/overview",
    summary: "Sessions with their latest activity",
    query: { after: { type: "string" }, limit: { type: "number" }, attention: { type: "boolean" } },
    response: "RoutingOverview",
  },
  {
    id: "session",
    method: "GET",
    path: R,
    summary: "One session",
    response: "RoutingSession",
  },
  {
    id: "heartbeat",
    method: "POST",
    path: `${R}/heartbeat`,
    summary: "Keep the session live",
    body: "{}",
    response: "RoutingSession",
  },
  {
    id: "leave",
    method: "POST",
    path: `${R}/leave`,
    summary: "End the session",
    body: "{}",
    response: "RoutingSession",
  },
  {
    id: "publish",
    method: "POST",
    path: `${R}/events`,
    summary: "Publish output events",
    body: "{ events: RoutingEventInput[] }",
    response: "{ events: RoutingEvent[] }",
  },
  {
    id: "events",
    method: "GET",
    path: `${R}/events`,
    summary: "Events after a cursor (poll this to watch)",
    query: { after: { type: "number" }, limit: { type: "number" } },
    response: "RoutingEventPage",
  },
  {
    id: "send",
    method: "POST",
    path: `${R}/messages`,
    summary: "Send a message to another session",
    body: "RoutingSend",
    response: "RoutingMessage",
  },
  {
    id: "inbox",
    method: "GET",
    path: `${R}/inbox`,
    summary: "Messages waiting for this session",
    query: { limit: { type: "number" } },
    response: "{ messages: RoutingMessage[] }",
  },
  {
    id: "deliveries",
    method: "GET",
    path: `${R}/deliveries`,
    summary: "Messages this session sent, with delivery state",
    query: { limit: { type: "number" } },
    response: "{ messages: RoutingMessage[] }",
  },
  {
    id: "receipt",
    method: "GET",
    path: `${R}/messages/{message}`,
    summary: "One message's delivery state",
    response: "RoutingMessage",
  },
  {
    id: "acknowledgeMessage",
    method: "POST",
    path: `${R}/messages/{message}/ack`,
    summary: "Acknowledge a received message",
    body: "{}",
    response: "RoutingMessage",
  },
  {
    id: "channels",
    method: "GET",
    path: `${R}/channels`,
    summary: "World channels this session can use",
    response: "{ channels: { id: string; name: string }[] }",
  },
  {
    id: "channelMessages",
    method: "GET",
    path: `${R}/channels/{channel}/messages`,
    summary: "Channel history after a cursor",
    query: { after: { type: "number" }, limit: { type: "number" } },
    response: "RoutingChannelPage",
  },
  {
    id: "sendChannel",
    method: "POST",
    path: `${R}/channels/{channel}/messages`,
    summary: "Post to a channel",
    body: "{ clientMessageId: string; text: string }",
    response: "RoutingChannelReceipt",
  },
  {
    id: "sync",
    method: "POST",
    path: "/api/routing/sync",
    summary: "Report a supervisor's runtimes and collect their controls",
    body: "RoutingSyncInput",
    response: "RoutingSyncResult",
  },
  {
    id: "runtime",
    method: "GET",
    path: `${R}/runtime`,
    summary: "The session's supervised runtime state",
    response: "{ state: RuntimeState | null }",
  },
  {
    id: "control",
    method: "POST",
    path: `${R}/control`,
    summary: "Send a runtime control (steer, interrupt, stop…) to another session",
    body: "{ targetId: string; clientMessageId: string; control: RuntimeControl }",
    response: "RoutingMessage",
  },
  {
    id: "enrolResident",
    method: "POST",
    path: "/api/routing/residents",
    summary: "Enrol a run's agent as its own world account",
    body: "ResidentEnrolInput",
    response: "ResidentEnrolment",
  },
  {
    id: "renewResident",
    method: "POST",
    path: "/api/routing/residents/{name}/renew",
    summary: "A fresh credential for a live owned run",
    body: "{ sessionId: string }",
    response: "{ name: string; credential: ResidentCredential }",
  },
  {
    id: "revokeResident",
    method: "POST",
    path: "/api/routing/residents/{name}/revoke",
    summary: "End this run's hold on the resident",
    body: "{ sessionId: string }",
    response: "{ name: string; revoked: number }",
  },
  {
    id: "reportResidentAttention",
    method: "POST",
    path: "/api/routing/residents/{name}/attention",
    summary: "Report attention-bridge decisions and presence",
    body: "ResidentAttentionReport",
    response: "{ name: string; recorded: number }",
  },
  {
    id: "issueSupervision",
    method: "POST",
    path: "/api/routing/supervision",
    summary: "Exchange a world session for a routing-only supervision credential",
    body: "{}",
    response: "SupervisionCredentialGrant",
  },
  {
    id: "renewSupervision",
    method: "POST",
    path: "/api/routing/supervision/renew",
    summary: "Replace the presented supervision credential",
    body: "{}",
    response: "SupervisionCredentialGrant",
  },
  {
    id: "revokeSupervision",
    method: "POST",
    path: "/api/routing/supervision/revoke",
    summary: "Revoke the presented supervision credential",
    body: "{}",
    response: "{ revoked: boolean }",
  },
];

// ─── Investigations: /api/investigations ─────────────────────────────────────

const A = "/api/investigations/attempts/{attempt}";
const investigations: Omit<HttpOperation, "tag">[] = [
  {
    id: "startInvestigation",
    method: "POST",
    path: "/api/investigations",
    summary: "Start an investigation (or replay the one this key started)",
    body: "InvestigationRequest & { idempotencyKey: string }",
    response: "{ attempt: InvestigationAttempt; created: boolean }",
    status: [200, 202],
  },
  {
    id: "listInvestigations",
    method: "GET",
    path: "/api/investigations",
    summary: "Your cases, newest first",
    query: { before: { type: "number" } },
    response: "{ cases: InvestigationCase[] }",
  },
  {
    id: "getInvestigation",
    method: "GET",
    path: "/api/investigations/{case}",
    summary: "A case with its attempts (or one attempt of it)",
    query: { attempt: { type: "string" } },
    response: "InvestigationSnapshot",
  },
  {
    id: "eraseInvestigation",
    method: "DELETE",
    path: "/api/investigations/{case}",
    summary: "Erase a case",
    response: "{ erased: boolean }",
  },
  {
    id: "grantInvestigation",
    method: "POST",
    path: "/api/investigations/{case}/grants",
    summary: "Share a case (null access removes it)",
    body: "{ name: string; access: InvestigationAccess | null }",
    response: "{ name: string; access: InvestigationAccess | null }",
  },
  {
    id: "attempt",
    method: "GET",
    path: A,
    summary: "One attempt",
    response: "InvestigationAttempt",
  },
  {
    id: "attemptEvents",
    method: "GET",
    path: `${A}/events`,
    summary: "An attempt's events after a cursor",
    query: { after: { type: "number" }, limit: { type: "number" } },
    response: "InvestigationEventPage",
  },
  {
    id: "cancelAttempt",
    method: "POST",
    path: `${A}/cancel`,
    summary: "Cancel an attempt",
    body: "{}",
    response: "{ cancelled: string[] }",
  },
  {
    id: "selectAttempt",
    method: "POST",
    path: `${A}/select`,
    summary: "Make this attempt the case's answer",
    body: "{}",
    response: "InvestigationSnapshot",
  },
  {
    id: "reviewAttempt",
    method: "POST",
    path: `${A}/review`,
    summary: "Add a review note",
    body: "{ text: string }",
    response: "InvestigationEvent",
  },
  {
    id: "resolveAttempt",
    method: "POST",
    path: `${A}/resolve`,
    summary: "Record the real outcome; scores a prediction",
    body: "{ value: unknown }",
    response: "{ answerId: number; loss: number | null }",
  },
  {
    id: "investigationContent",
    method: "GET",
    path: "/api/investigations/content/{content}",
    summary: "Stored content an event refers to",
    response: "InvestigationContent",
  },
];

// ─── Published panels: /api/canvases ─────────────────────────────────────────

const N = "/api/canvases/{canvas}/nodes/{node}";
const panels: Omit<HttpOperation, "tag">[] = [
  {
    id: "createCanvas",
    method: "POST",
    path: "/api/canvases",
    summary: "Create a canvas to publish panels on",
    body: "{ name: string; description?: string }",
    response: "{ id: string; name: string }",
    status: [200, 201],
  },
  {
    id: "canvases",
    method: "GET",
    path: "/api/canvases",
    summary: "Canvases you can see",
    query: { limit: { type: "number" } },
    response: "{ id: string; name: string }[]",
  },
  {
    id: "panelResources",
    method: "GET",
    path: "/api/panel-resources",
    summary: "Live data a panel can bind to",
    response: '{ schema: "marina.panel-resources.v1"; resources: PanelResourceDefinition[] }',
  },
  {
    id: "canvas",
    method: "GET",
    path: "/api/canvases/{canvas}",
    summary: "A canvas with its nodes (panels are type `a2ui`)",
    response: "{ nodes: PublishedPanelNode[] }",
  },
  {
    id: "publishPanel",
    method: "POST",
    path: "/api/canvases/{canvas}/nodes",
    summary: "Publish a panel",
    body: '{ type: "a2ui"; data: A2UINodeData }',
    response: "PublishedPanelNode",
    status: [200, 201],
  },
  {
    id: "panel",
    method: "GET",
    path: N,
    summary: "One panel",
    response: "PublishedPanelNode",
  },
  {
    id: "revisePanel",
    method: "PATCH",
    path: N,
    summary: "Replace a panel's document (409 if `revision` is stale)",
    body: "{ revision: string; data: A2UINodeData }",
    response: "PublishedPanelNode",
  },
  {
    id: "interactPanel",
    method: "POST",
    path: `${N}/interaction`,
    summary: "Press a panel's button or submit its form",
    body: "PanelInteractionInput",
    response: "{ status: string; message?: string; receipt?: { id: string; status: string } }",
  },
];

export const HTTP_OPERATIONS: HttpOperation[] = [
  ...memory.map((op) => ({ ...op, tag: "memory" as const })),
  ...routing.map((op) => ({ ...op, tag: "routing" as const })),
  ...investigations.map((op) => ({ ...op, tag: "investigations" as const })),
  ...panels.map((op) => ({ ...op, tag: "panels" as const })),
];

/** Whether a memory request must carry an `Idempotency-Key`. */
export function memoryNeedsIdempotencyKey(method: string, path: string): boolean {
  return (
    ["POST", "PATCH", "DELETE"].includes(method) &&
    !MEMORY_KEYLESS_POSTS.some((suffix) => path.endsWith(suffix))
  );
}
