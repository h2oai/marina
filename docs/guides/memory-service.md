# Use Marina as an agent memory service

Marina Memory v1 stores evidence, versioned memories and resumable work over HTTP. It can run
without a world, residents, model routing or standing. An external agent only needs a URL, a
memory credential and a space ID. The [reliability implementation record](../research/memory-reliability-implementation.md)
separates demonstrated behavior from the remaining roadmap.

## Start a private service

From the repository root, install dependencies with `bun install`, then provision an identity:

```bash
bun run memory init --db data/memory.db --name research-agent --credentials data/research-agent.json
bun run memory serve --db data/memory.db --embeddings none
```

The server binds `127.0.0.1:3301`. The credential file contains `token`, `principalId`, `spaceId`,
`credentialId` and `expiresAt`; its permissions are `0600`. Keep it out of version control.
Provisioning is an operator action, not an unauthenticated network endpoint. Repeating `init`
with the same name issues a new credential for the same service principal and private space;
use a new credential filename. Existing credentials remain valid until revoked or expired.

The standard install contains no ONNX runtime, tokenizer package or embedding model. To enable
the local provider, install its isolated extension explicitly:

```bash
bun install --cwd extensions/local-embeddings --frozen-lockfile
bun run memory serve --db data/memory.db --embeddings local
```

`--embeddings local` loads that extension and downloads the pinned model on first use. Subsequent launches use `data/memory-models`; use `--model-cache PATH` to move the
cache and `--local-only` to prohibit downloads. `--embeddings none` needs no model and provides
exact symbolic queries, relation traversal and literal FTS5 search. The default is `none`;
it does not provide paraphrase retrieval. See [TypeScript, MCP and resident interfaces](memory-interfaces.md).

The standalone server uses SQLite WAL with `synchronous=FULL`. Do not treat this as proof of
hardware power-loss behavior: the executable qualification tests process termination. For remote
use, terminate TLS at your authenticated deployment boundary and set `--host` deliberately.
No model-provider credentials are needed for the local embedding option.

## Use memory from an agent

This example uses the dependency-free Python client. It captures original evidence, writes a
memory linked to that evidence, queries it symbolically, and checkpoints a durable source cursor.

```bash
PYTHONPATH=src/sdk python3 - <<'PY'
import json
from marina_memory import MarinaMemory

with open("data/research-agent.json") as f:
    identity = json.load(f)
memory = MarinaMemory("http://127.0.0.1:3301", identity["token"], identity["spaceId"])
source = memory.capture({"role": "user", "content": "I avoid all animal products."},
                        session_id="intro", key="intro-source-v1")
receipt = memory.remember("I avoid all animal products.",
                          claim={"subject": "person:self", "predicate": "diet",
                                 "object": {"kind": "literal", "value": "vegan"}},
                          source_ids=[source["id"]], key="intro-diet-v1")
print(memory.query(subject="person:self", predicate="diet")["results"])
memory.save_checkpoint({"goal": "Plan a dinner", "diet_record": receipt["id"]},
                       source_cursor=source["seq"], key="intro-checkpoint-v1")
print(memory.get(receipt["id"]))
PY
```

A fresh process can call `memory.checkpoint()` and continue from the stored cursor using
`memory.sources(after=cursor)`. Store raw tool outputs **before** replacing them with a summary.
Checkpoint data is explicit agent state; the service does not infer goals or silently summarize.

The TypeScript client is [MarinaMemoryClient](../../src/sdk/memory-client.ts):

```typescript
import { MarinaMemoryClient } from "marina/memory"; // bun run build:memory in this checkout

const client = new MarinaMemoryClient(url, token);
const saved = await client.remember(spaceId, { content: "Office: Berlin", subject: "office" }, "office-1");
const corrected = await client.revise(spaceId, saved.id, 1, { content: "Office: Paris" }, "office-2");
await client.waitForIndex(spaceId, corrected);
const current = await client.get(spaceId, saved.id);     // version 2
const historical = await client.get(spaceId, saved.id, 1); // original content and attributes
```

Keep the same idempotency key when retrying an ambiguous write. A different payload with that
key returns `409`; a competing revision with a stale `expected_version` also returns `409`.
Clients expose errors and do not retry writes automatically with fresh keys.

## HTTP contract

All paths below start with `/v1/memory`. Use `Authorization: Bearer TOKEN`. Mutations also
require `Idempotency-Key: KEY`. JSON bodies are limited to 2 MiB. Errors have
`{"error":{"code":"...","message":"..."}}`. The only public read is `GET /health`.

| Method and path | Behavior |
|---|---|
| `GET /` and `/me` | Actual configured capabilities and credential identity/scopes |
| `GET /spaces`, `POST /spaces` | List authorized spaces; create with `{name}` |
| `GET /spaces/:space` | Space state and current generation |
| `POST /spaces/:space/records` | Verbatim `{content, type?, tier?, importance?, subject?, metadata?, source_ids?, depends_on?, claim?, valid_time?, expected_vocabulary_version?}`; returns stable record ID, version and optional index job ID |
| `GET /spaces/:space/records/:id?version=N` | Current record by default; explicitly requested historical revision otherwise |
| `PATCH /spaces/:space/records/:id` | Full replacement content plus `expected_version`; omitted attributes are retained |
| `POST /spaces/:space/query` | Exact `{subject?, predicate?, object?, type?, tier?, valid_at?, limit?, cursor?}`; no embeddings; current records and generation-bound pagination |
| `POST /spaces/:space/graph` | `{subject, predicates?, direction?, max_depth?, valid_at?, limit?}`; asserted relationships with record-cited paths; no inference |
| `POST /spaces/:space/search` | `{query, mode?, limit?, subject?, type?, tier?, allow_degraded?}`; current records, source IDs, component ranks and generation |
| `POST /spaces/:space/context` | Search plus `budget_tokens`; bounded evidence text, revision citations and truncation flags |
| `POST /spaces/:space/sources` | Original JSON `{content, session_id?}`; returns durable source ID and cursor |
| `GET /spaces/:space/sources?after=N&limit=100` | Ordered source replay with `next_cursor` |
| `POST /spaces/:space/source_search` | `{query, match?:"all"\|"any"\|"phrase", session_id?, limit?}` searches original sources, including those with no derived record |
| `GET /spaces/:space/sources/:id?start=N&end=N&text_hash=HASH` | Read an immutable UTF-8 byte range with representation/hash/continuation metadata |
| `GET/POST /spaces/:space/vocabulary` | Read latest (or `?version=N`); owner writes `{expected_version, definition}` with CAS |
| `POST /spaces/:space/plan` | `{task, use_model?, steps?, max_results?, max_bytes?}` creates an inspectable read plan |
| `POST /spaces/:space/execute_plan` | Executes a returned plan against its exact space generation and vocabulary version |
| `GET/POST /spaces/:space/checkpoints/:name` | Get state; write `{expected_version, data, source_cursor?, source_ids?}` atomically. Use version 0 for first write. |
| `GET /spaces/:space/jobs/:id` | Durable embedding job state; worker lease secrets are excluded |
| `POST /spaces/:space/reindex` | `{expected_generation}`; enqueue missing vectors for the configured model, returning `job_ids` |
| `POST /spaces/:space/grants` | Owner grants `{principal_id, role:"reader"\|"writer"\|null}`; `null` revokes access |
| `POST /spaces/:space/forget` | `{record_ids}` or `{source_ids}`; whole-space deletion requires `{all:true, expected_generation}` from its owner |
| `POST /spaces/:space/sources/batch` | Atomically capture 1–64 sources (1 MiB total), retaining individual retry keys |
| `GET /spaces/:space/export` | Authorized `marina.memory.bundle.v1` snapshot of current records, raw sources and checkpoints |

Memory credentials have a separate audience from world and model credentials. Scopes are
`memory:read`, `memory:write`, `memory:share` and `memory:export`; provisioning currently issues
all four. Space grants restrict what those scopes can reach. Reader grants cannot mutate;
only the owner can grant access or forget the whole space. API request headers cannot select
another identity. Revoke a credential with:

```bash
bun run memory revoke --db data/memory.db --credential CREDENTIAL_ID
```

Credentials expire after 30 days. Sharing a space is an explicit same-instance grant, not a
copy or federation. Service records use canonical Marina notes internally but remain isolated
from legacy name-based `/mem` access. New `memory api`, symbolic human commands and MCP tools
reach those service records through the same authorization layer. The full world server exposes
the same `/v1/memory` routes over its database; provision against that DB for external HTTP access.
See [interface setup](memory-interfaces.md). Resident checkpoints and lossy context transforms
now use these durable APIs. Legacy notes and pools retain their existing interfaces.

## Retrieval and index behavior

Omitting `mode` always selects lexical retrieval, even when an embedding provider is installed.
Only an explicit `mode:"hybrid"` requests embeddings. `/search` searches memory records;
`/source_search` searches original sources. A default task plan searches both stores.

Hybrid search combines FTS5 and cosine similarity using reciprocal rank fusion (`k=60`). It
returns current heads, applies scope and record filters, and identifies the embedding model.
The native implementation scans at most 10,000 eligible active records. It reports a capacity
error above that bound instead of silently omitting memories; this is not an ANN scale claim.

Writes are durable before asynchronous semantic indexing finishes. Wait for the receipt's job
to become `ready`. Hybrid search fails with `503 retrieval_incomplete` if the provider or eligible
vectors are unavailable. An explicit `allow_degraded:true` returns available results with reasons;
it does not disguise lexical results as semantic success. After enabling or changing a model,
read the space generation, call `reindex`, and wait for the returned jobs. Model identities include
preprocessing versions, preventing accidental mixing of incompatible embeddings.

`budget_tokens` conservatively limits the **UTF-8 bytes of returned evidence text**, including
its framing and inline citations. This is an upper-bound estimate for byte-based tokenizers,
not an exact provider tokenizer or a budget for the entire JSON response/system prompt. Truncated
content is identified; the original remains available by record ID. Retrieved text is labeled
as evidence and JSON-quoted, but prompt-injection resistance still requires agent-side policy.

Local embeddings use Apache-2.0 [Tokenizers.js](https://github.com/huggingface/tokenizers.js)
`0.2.0`, MIT [ONNX Runtime](https://github.com/microsoft/onnxruntime/tree/v1.21.0) `1.21.0`,
and the Apache-2.0 [all-MiniLM-L6-v2 model](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9),
pinned at `751bff37182d3f1213fa05d7196b954e230abad9`. Tokenizer-checked chunks cover long input
before normalized mean pooling; this avoids silently embedding only a prefix. It is a compact
baseline, not a claim that MiniLM is the strongest multilingual or long-document model.

An optional [Ollama embedding adapter](https://docs.ollama.com/api/embed) is available via
`--embeddings ollama --embedding-model MODEL --embedding-revision REVISION --embedding-url URL`.
The operator must keep that revision identifier aligned with the deployed model. It has not
been live-qualified here. No Hindsight, Graphiti or Mem0 backend is installed by this slice.

## Forgetting and portability boundaries

Forgetting a source deletes its linked records, their complete revision history, dependent
records and vector jobs/index entries in the same transaction. Lineage is cumulative across
revisions. Any forgetting invalidates all checkpoints in that space because opaque checkpoint
payloads may contain copies. Forgetting just a record leaves its original sources intact.

Clients must declare `source_ids` and `depends_on`; the service cannot discover undeclared
copies, erase downloaded exports, remote model inputs or backups, or promise forensic erasure
of SQLite free pages/WAL. Receipt hashes and identifier-only audit/tombstone rows remain for
safe retries. These are logical API deletion guarantees within recorded lineage.

Export currently contains current revisions, not full historical bundles. There is no bundle
import, Mem0 compatibility endpoint, automatic extraction, temporal inference, distributed
store, semantic response cache or federation in v1. All are explicit roadmap gates.

## Reproduce the external-agent proof

```bash
bun run qualify:memory --embeddings none
bun run qualify:memory --embeddings local --model-cache data/memory-models
```

The harness provisions temporary credentials, runs the [Python agent](../../examples/memory-service/agent.py)
using HTTP only, kills the server with `SIGKILL`, starts fresh processes, and checks original
artifact integrity, checkpoint recovery, retrieval, revisions, bounded context, sharing,
revocation and forgetting. It cleans up its temporary database and does not use your memories.

That qualification agent uses a deterministic policy, not an LLM. In the recorded eleven-record corpus,
hybrid search recovered all three paraphrased facts at rank three or better; lexical search
recovered none. This demonstrates the service boundary and a small semantic benefit. Broader
agent-task improvement, competitor parity, multi-day operation and scale remain unproven.

A separate [LLM comparison](../research/memory-portable-implementation.md) runs the same fresh
HTTP-only agent and six tasks without memory, with portable memory, and with optional embeddings.
Its traces and failures are retained; it does not establish general agent or competitor parity.

## Original sources and stable ranges

`capture` preserves a JSON value. Range reads expose string values directly as UTF-8; other
values use the exact stored JSON serialization. `content_hash` identifies the stored JSON;
`text_hash` identifies the range-readable text. Offsets address bytes in `utf8-source-text-v1`,
not characters or tokenizer positions. The default range is up to 16 KiB; explicit ranges may
span up to 64 KiB. A split UTF-8 codepoint is rejected. Follow `next_start` until null and send
`text_hash` to detect a changed representation. Sources are immutable until explicitly forgotten.
Source search returns bounded excerpts and IDs; read ranges to inspect complete evidence.

```typescript
const matches = await client.sourceSearch(spaceId, {query: "incident Kestrel", match: "all"});
const hit = matches.results[0];
if (hit) {
  const page = await client.sourceRange(spaceId, hit.id, {start: 0});
  console.log(page.text, page.next_start, page.text_hash);
}
```

## Vocabulary and time

A space starts at vocabulary version 0 with an open predicate set. Owners can publish a
versioned contract; writers can pin `expected_vocabulary_version` to reject a stale vocabulary.
Each predicate declares an object type (`entity`, `string`, `number`, `boolean` or `null`) and
cardinality (`one` or `many`). A closed vocabulary rejects unknown predicates. Updating a
vocabulary validates existing active assertions; online validation is capped at 10,000 assertions.

```typescript
await client.saveVocabulary(spaceId, 0, {
  closed: true,
  predicates: {status: {object: "string", cardinality: "one"}},
});
await client.remember(spaceId, {
  content: "River was active during the first phase.",
  claim: {subject: "project:river", predicate: "status", object: {kind: "literal", value: "active"}},
  valid_time: {from: 100, until: 200},
  expected_vocabulary_version: 1,
});
const at150 = await client.query(spaceId, {subject: "project:river", predicate: "status", valid_at: 150});
```

Valid time uses half-open intervals `[from, until)` in nonnegative UTC milliseconds; null bounds
are unbounded. `query` and `graph` accept `valid_at`; ordinary text search does not filter time.
A cardinality-one predicate rejects different objects whose intervals overlap; adjacent intervals
are allowed. It reports conflicts without choosing a winner. This describes assertions, not
verified truth. Current queries use current revisions; explicit `get(..., version)` preserves
historical attributes. There is no global transaction-time/as-of query, rule engine or inferred
ontology. For temporal questions, use `valid_at` rather than expecting an LLM to choose an
interval from text-search results.

## Inspectable task retrieval

```typescript
const plan = await client.plan(spaceId, {task: "Aster migration approval"});
console.log(plan.steps, plan.assumptions, plan.budget);
const evidence = await client.executePlan(spaceId, plan);
```

Default planning is deterministic keyword retrieval, with no model call. Explicit caller steps
can combine exact `query`, `graph`, record `search` and `source_search`. Unknown operations and
unsupported fields are rejected. Plans contain up to eight read steps, with up to 20 results
per step and a total limit of 100 evidence items. `max_bytes` bounds serialized evidence items
(256–131,072 bytes), not the entire response envelope. Traces expose inputs, evidence and
truncation. `answer_sufficiency:"not_assessed"` explicitly leaves answer evaluation to the agent.
Evidence, vocabulary or access changes make the plan stale and require replanning.
Checkpoint-only writes preserve new plans carrying `retrieval_generation`.

To ask Marina's existing model router to generate the read plan, configure the memory server:

```bash
export MARINA_MEMORY_PLANNER_URL=http://127.0.0.1:3300/v1
export MARINA_MEMORY_PLANNER_MODEL=marina
# Set MARINA_MEMORY_PLANNER_TOKEN to an authorized model-router credential when required.
bun run memory serve --db data/memory.db --embeddings none
```

Then pass `use_model:true` to `plan`. Only the operator selects the router URL/model/credential.
The planner sends the task and authorized vocabulary, not stored source bodies. It makes a
bounded model request, validates the returned plan, and pairs text discovery across both records
and sources. Model errors remain errors; there is no silent downgrade. Permissions and generation
are checked again after model work and between execution steps. Model planning can incur the
router's normal inference cost. It does not perform writes or answer the task.


## Reliable corrections and retries

`depends_on` binds a conclusion to the current revision of each declared premise. Supply
`dependency_versions: {RECORD_ID: VERSION}` to pin the revisions you actually read; a racing
change rejects the write. Correcting a premise atomically marks its direct and transitive
current dependents `freshness: "stale"`. Their original contents, ownership and history remain
available. Default query, graph, search and context retrieval exclude stale conclusions.
Use `include_stale: true` for review, or `get` a known record directly. `freshness: "current"`
means its declared premises have not changed; it is not a truth or trust certification.

A text-only revision does not clear stale status. After reviewing the evidence, explicitly
supply all current `dependency_versions` when revising the conclusion. Revalidate upstream
premises first. Removing `depends_on` explicitly asserts independent support; historical
lineage still controls forgetting. Older dependencies with no recorded revision bindings
require review after migration. No model automatically corrects or reaffirms conclusions.

```ts
const premise = await memory.get(space, premiseId);
const conclusion = await memory.get(space, conclusionId);
await memory.revise(space, conclusion.id, conclusion.version, {
  content: "Updated conclusion based on the reviewed evidence.",
  depends_on: [premise.id],
  dependency_versions: { [premise.id]: premise.version },
});
```

New plans and query cursors carry `retrieval_generation`. Evidence, assertions, vocabulary,
permissions and forgetting invalidate it; checkpoint saves and reindex requests do not.
The existing `generation` still tracks all service mutations. Old plans/cursors without the
new marker retain the stricter generation check. Every execution rechecks live authorization.

For bursts, use TypeScript `captureBatch`, Python `capture_batch`, or generic MCP operation
`capture_batch`, with `items: [{content, key, session_id?}]`. The whole batch is atomic. Keep
both batch and item keys stable when retrying; individual receipts survive regrouping.

The TypeScript SDK exports opt-in `retryMemoryOperation`. Build the exact request and mutation
key **outside** its callback. It defaults to five attempts for timeouts, network failures,
408/429/502/503/504, with bounded backoff and service `Retry-After` support. It does not retry
permission denials or version conflicts. Residents use this helper internally. Retry exhaustion
surfaces the failure; it never counts as successful persistence.

```ts
import { retryMemoryOperation } from "marina/memory";
const key = crypto.randomUUID();
const items = [{ content: originalToolOutput, key: `${key}:source` }];
await retryMemoryOperation(() => memory.captureBatch(space, items, key));
```

Residents journal completed user, assistant and tool-result messages privately through the
same authenticated service, awaiting acknowledgement before the runtime advances. Journal
manifests link to previous manifests; read `checkpoint.data.journal.manifest_source_id` to
start navigating. Compaction also preserves the original transcript before shrinking context.
The source cursor advances at archival, so later journal evidence remains replayable. Explicit
compaction pool configuration still shares only its summary. Storage failures retain local
context and fail the current run; discarded checkpoints require restart before local re-archival.
This does not make external tool side effects transactional: a tool can act before its result
is captured, and unfinished streaming output is not a completed-message receipt.

## Backup and restore

Both standalone memory and the normal world entry point use SQLite `synchronous=FULL` by
default. `MARINA_DB_DURABILITY=normal` is an explicit world-server tradeoff for fewer syncs;
it weakens the power-loss guarantee. Hardware and filesystem behavior still matter. See
[SQLite synchronous semantics](https://www.sqlite.org/pragma.html#pragma_synchronous).

Back up the **whole database**, including any world data and credentials, using operator CLI
access. This is not a scoped memory API export. Snapshot files are private (0600), verified
with integrity and foreign-key checks, hashed, synced, and atomically published at a new path.
A live WAL database is supported through
[SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause).

```bash
bun run memory backup --db data/memory.db --output /secure-backups/memory-001.db
bun run memory restore --backup /secure-backups/memory-001.db --db data/restored-memory.db
bun run memory serve --db data/restored-memory.db --embeddings none
```

Restore always creates a new database; it refuses to overwrite an existing destination.
The JSON receipt includes SHA-256, byte size and schema version. Test the restored instance
before changing the deployment's database path. Restores recover the snapshot's point-in-time
credentials and content: later revocations and forgetting must be reapplied when appropriate.
A process killed during backup can leave a private `.marina-snapshot-*` staging directory;
an incomplete file is never published as the requested destination. Operators own retention,
encryption, off-host copies and cleanup of abandoned staging directories. Health checks confirm
a schema read succeeds; they do not certify writable capacity or power-loss protection.

Reproduce process recovery and lost-receipt tests with:

```bash
bun run qualify:memory:reliability --cycles 100 --output /tmp/marina-memory-recovery.json
```


## Storage admission and failure recovery

`GET /v1/memory/usage`, TypeScript/Python `usage()`, generic MCP `{operation:"usage"}`, and
in-world `memory usage` report the authenticated principal's owned-space totals, configured
limits and `over_limit` dimensions. A shared writer consumes the space owner's budget; usage
never reveals another owner's private totals. Inspecting usage does not create a resident space.

Migration **105** adds rebuildable accounting projections and backfills existing memory.
Limits apply to both world and standalone entry points. Configure positive safe integers in
the environment and restart, or pass `memoryLimits` when constructing `MarinaDB`:

| Setting | Default | Counted scope |
|---|---:|---|
| `MARINA_MEMORY_MAX_BYTES` | 1,073,741,824 | Logical UTF-8 payload bytes plus row allowances |
| `MARINA_MEMORY_MAX_SOURCES` | 100,000 | Retained original source rows |
| `MARINA_MEMORY_MAX_REVISIONS` | 100,000 | All retained record revisions, including superseded revisions |
| `MARINA_MEMORY_MAX_SPACES` | 256 | Active owned spaces |

Logical bytes include original source JSON, record revisions and attributes, current checkpoints,
vocabulary versions, operation receipts/events, grants, optional index jobs and vectors. Row
allowances cover bookkeeping approximately. Retry receipts are retained and charged, including
receipts in forgotten spaces. Replacing a checkpoint can grow usage even when its current payload
has the same size. There is no automatic TTL, history pruning, or model-selected eviction.

A growing write that exceeds a dimension fails with `507 quota_exceeded`; its content, receipts,
events and accounting roll back together. Atomic batches roll back in full. Same-key receipt
replays consume no additional budget. Existing over-budget data stays readable after an operator
lowers limits. Explicit forgetting and revocation remain admitted even when their audit receipts
increase usage; these exceptions mean the budget is not an absolute ceiling. Existing SQLite
pages, FTS indexes, WAL, other world tables and backups require separate deployment disk quotas,
monitoring and retention. Forgetting does not necessarily shrink the physical database file.

| Error | HTTP | Recovery |
|---|---:|---|
| `storage_busy` | 503, `Retry-After: 1` | Bounded same-key retry after contention clears |
| `quota_exceeded` | 507 | Inspect usage; explicitly forget appropriate data or raise the owner's configured budget |
| `storage_full` | 507 | Operator restores capacity before retrying the same request |
| `storage_read_only` | 500 | Operator repairs write access |
| `storage_io_error` | 500 | Operator investigates storage; preserve the original key for receipt recovery |
| `storage_corrupt` | 500 | Operator verifies storage and performs a controlled restore |

Fault classification uses real SQLite result codes, not error-message text. Generic failures
never echo SQL or source content. The SDK does not automatically retry 500 or 507. A lost response
or cancellation cannot prove that a write failed; after recovery, replay the exact payload and
original idempotency key. Optional vector admission failures retain a pending job with
`error:"quota_exceeded"`; the existing bounded retry policy eventually marks it failed. After
raising capacity, a failed job needs an explicit reindex request. Original memories remain usable
without vectors.

## Request cancellation

Use a per-operation TypeScript client view and pass the same signal to the retry helper:

```ts
const controller = new AbortController();
const operation = memory.withSignal(controller.signal);
const key = crypto.randomUUID();
const payload = { tool: "test", result: "original result" };
const pending = retryMemoryOperation(
  () => operation.capture(space, payload, "task:123", key),
  { signal: controller.signal },
);
// Attach your caller's usual error handling before cancelling.
controller.abort();
await pending; // Rejects with the cancellation reason.
```

`withSignal` leaves concurrent users of the base client unaffected. Cancellation stops local
fetch/body waits, index polling and retry backoff, including non-cooperative custom transports.
The memory-only MCP bridge forwards protocol cancellation to HTTP. Incoming HTTP requests check
cancellation while reading bodies and waiting on query-planning or optional semantic providers.
A cancelled optional query does not silently return degraded evidence. Cooperative configured
providers receive the signal; synchronous SQLite work and already-sent commands are not
preempted or rolled back by an abort.

Residents pass the runtime signal through completed-message journals and the compaction archival
barrier. Aborting a stalled capture prevents the next model call and keeps original local context;
a cancelled queued journal will not start later. WebSocket `memoryService(request, timeoutMs,
signal)` cancels its local response wait and removes listeners. World MCP commands already queued
in the engine may still run. The synchronous Python SDK retains its existing timeout behavior;
it does not expose `AbortSignal` cancellation.

**Cancellation is not a rollback receipt.** A request sent before cancellation can still commit.
Keep mutation keys outside retry callbacks and preserve them until the remote outcome is known.
Cancellation does not make external tools transactional or retract already exported evidence.
