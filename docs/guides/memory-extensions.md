# Portable memory extensions

These interfaces use the same durable memory service as residents, HTTP clients and native
MCP tools. No embedding model is required. Sources remain authored evidence, relationships
remain explicit assertions, and cached results do not become facts.

## Resume a larger history transfer

Use `MarinaMemoryClient` from `marina/memory`. Both clients need their own credentials. The
exporter needs read/export access; the importer must own an empty destination space.

```typescript
let page = await origin.exportTransferPage(originSpace);
const transfer = await destination.beginTransfer(destinationSpace, page.header, "begin-copy-1");
// Persist transfer.id and the source URL/space before sending pages.
while (true) {
  const accepted = await destination.appendTransfer(
    destinationSpace, transfer.id, page, `copy-1-page-${page.position}`,
  );
  if (page.done) {
    await destination.commitTransfer(destinationSpace, transfer.id, accepted.sha256, "commit-copy-1");
    break;
  }
  page = await origin.exportTransferPage(originSpace, accepted.next_cursor!);
}
```

After a restart, call `transferStatus(destinationSpace, transferId)`. For `receiving`, resume
export from `next_cursor`; a null cursor at position zero means no page has been accepted.
For `ready`, commit using the returned `sha256`. `committed` is terminal. Use the original
request key to recover an ambiguous page/commit acknowledgment. Retry transient errors with
`retryMemoryOperation`, preserving the same payload and key. For example:

```typescript
const accepted = await retryMemoryOperation(() => destination.appendTransfer(
  destinationSpace, transferId, page, `copy-1-page-${page.position}`,
));
```

Each page has at most 256 KiB of decoded fragments (base64 makes the wire body larger),
128 fragments, and a chained SHA-256 digest. Each serialized row is limited to 4 MiB; the
whole transfer to 64 MiB and 300,000 rows. Histories are streamed as individual revisions.
IDs, exact original content, revision attributes, explicit relationships, vocabulary history
and checkpoints are preserved or rejected. Credentials, grants, retry receipts, vectors and
caches are excluded. Target ownership and grants are not copied from the source.

Any source-space generation change invalidates further export pages with `transfer_changed`.
Pause writes while copying, or export from a stable restored backup. Checksums detect damaged
content; they do not authenticate its author. Use trusted origins and authenticated transport.

Staging is durable and counts toward the owner's storage quota. It is invisible to ordinary
retrieval until one atomic publication succeeds. Publication can require substantial temporary
disk space and synchronous SQLite work; measure larger imports on the deployment hardware.
The final retained data must fit ordinary owner quotas. Existing ID conflicts and nonempty
destinations are rejected. Nothing is silently merged or overwritten.

At most two active imports per owner are allowed. Writes expire 24 hours after beginning;
expiry does not delete data. Inspect status and explicitly call `abortTransfer` to release
unused staging, including expired transfers. Abort cannot delete a committed import; use
ordinary explicit forgetting. Full instance snapshots preserve in-progress staging.

HTTP paths under `/v1/memory/spaces/:space`:

| Method/path | Operation |
|---|---|
| `GET /transfer?cursor=...` | Export a bounded page |
| `POST /transfers` | Begin with the export header |
| `GET /transfers/:id` | Inspect/resume status |
| `POST /transfers/:id/pages` | Append a complete page |
| `POST /transfers/:id/commit` | Publish with `{sha256}` |
| `POST /transfers/:id/abort` | Remove unpublished staging |

The Python client provides `export_page`, `export_pages`, `begin_transfer`, `transfer_status`,
`append_transfer`, `commit_transfer`, and `abort_transfer`. World and native MCP callers use
`memory_service` operations `export_page`, `transfer_begin`, `transfer_status`, `transfer_page`,
`transfer_commit`, and `transfer_abort`. Keep large page payloads out of a model's context;
an SDK worker can move them while the agent manages status.

## Use the reference MCP knowledge-graph tools

Launch the memory stdio bridge with a named profile:

```bash
bun run memory:mcp --url http://127.0.0.1:3301 \
  --credentials data/agent.json --profile knowledge-graph
```

Use that command/argument array in your coding client's MCP configuration. The profile exposes
`create_entities`, `create_relations`, `add_observations`, `delete_entities`,
`delete_observations`, `delete_relations`, `read_graph`, `search_nodes`, and `open_nodes`.
The default `--profile native` retains Marina's existing tools.

This profile follows the [reference memory server's nine tool contracts](https://github.com/modelcontextprotocol/servers/tree/main/src/memory).
Entities have `{name, entityType, observations:string[]}`; relations have
`{from, to, relationType}`. Names are case-sensitive identities. Search performs case-insensitive
substring matching across names, types and observations. Search/open results include relations
incident to either selected endpoint; the other endpoint need not appear in the returned entities.
Relations require both entities to exist. Each mutation batch is atomic.

The bounded profile differs from a full server replacement:

- It supports the nine tools, without resource subscriptions or reference JSONL persistence.
- Each space has at most 2,000 profile records and a 1 MiB graph/result limit. Each entity,
  observation and relation uses a record. Names/types are nonempty and at most 256 characters;
  observations are nonempty and at most 8,192 characters. Owner quotas also apply.
- Each observation has its own original source. Explicit deletion removes that source and its
  declared lineage. Native forgetting also invalidates checkpoints/caches and retires earlier
  profile receipts that might contain copied observations; replay then returns `receipt_retired`.
- Native changes that leave malformed graph data require explicit repair. Stale profile records
  return `compat_review_required`; use native review/reaffirmation before reusing them.

Profile records remain searchable/readable through native APIs. Relations are native typed
claims and work with exact queries and graph traversal. Native bundles and paged transfers
preserve profile data and ordering. Keep application data in a dedicated space when possible.
TypeScript also exposes `client.knowledgeGraph(space, action, input, key?)`; Python exposes
`knowledge_graph`. World agents use the `knowledge_graph` memory-service operation.

## Supply a portable retrieval vocabulary

```typescript
import { expandMemoryQuery } from "marina/memory";

const plan = expandMemoryQuery("shipping status", {
  policy: "logistics-glossary:v1",
  rules: [{ term: "shipping", alternatives: ["dispatch", "shipment"] }],
});
console.log(plan.applied, plan.truncated);
const result = await client.sourceSearch(space, {
  query: plan.query, expansion: plan.expansion, match: "all",
});
console.log(result.expansion, result.results);
```

The helper makes literal, Unicode-aware substitutions against the original query. It does not
recursively expand or combine every rule. Rule order selects up to four alternatives, and
`truncated` reports omissions. Supply at most 128 rules and eight alternatives per rule.
Persist/version this JSON vocabulary wherever your application stores authored configuration;
it is separate from the service's predicate/type vocabulary.

Both `/search` and `/source_search` accept `expansion:{policy,queries}` directly, including
from Python or an explicit retrieval plan. A caller can also ask its chosen model to propose
queries, inspect them, then submit them. No router call or inference is hidden in search.
Queries are deduplicated against the original and each other. All queries apply the same
authorization, filters and source-match mode in one read snapshot. Stale records stay excluded
unless explicitly requested.

Fusion adds the original query's reciprocal rank and the **mean** contribution of alternatives
(`k=60`). Optional hybrid retrieval adds its existing semantic contribution. Responses report
the policy, exact alternative queries, candidate counts and per-result ranks. Record queries
have at most 200 candidates per ranker; source queries have at most 100. Original record search
uses any-token FTS matching; source search defaults to all-token matching. Expansion can improve
recall or add noise: measure the same tasks with and without it. Search excerpts remain
discovery aids; read original stable ranges before quoting evidence.

## Pin a reusable result to remote evidence

An operator configures explicit principal mounts as described in the
[federation guide](memory-service.md#explicit-federation). Callers cannot supply arbitrary peer
URLs. A cache write may combine local `records`/`sources` with explicit remote pins:

```typescript
await client.cachePut(space, {
  inputs: { task: "prepare release" }, model: "caller-model", policy: "release:v2",
  value: { summary: "Caller-authored derived result" }, expires_at: Date.now() + 60_000,
  federated: [{ kind: "record", mount: "team", space_id: peerSpace, id: recordId, version: 3 }],
}, "release-cache-1");
```

Remote source pins use `{kind:"source",mount,space_id,id,content_hash}`. There must be 1–32
pins total. Every write and lookup rechecks the configured endpoint, remote principal,
retrieval generation, current record/version or source hashes, and live access. Local access
and cache state are checked again after network waits. An unavailable, revoked, remounted or
changed peer yields a miss; the old value is not returned as a fallback. Even unrelated peer
evidence changes can invalidate a result conservatively.

These are per-peer checks, not an atomic distributed snapshot. A peer can change after its
check completes. Mounts must be restored by operator configuration after service restart.
An unchanged restored peer can validate existing entries again. Same-key acknowledgment
recovery remains available during an outage, but it does not return cached content.
Federated caching adds network validation work; it is useful when that costs less than
recomputing the derived result. It does not automatically cache model tokens.

## Transfer discovery and recovery

Owners can list imports without retaining their IDs:

```ts
const imports = await memory.transfers(space, { state: "receiving", limit: 20 });
const next = imports.next_cursor;
const status = await memory.transferStatus(space, imports.transfers[0]!.id);
```

`state`, `expired`, `limit` and `cursor` are optional filters. Listing is owner-only, uses an ID cursor, and reflects current status. Expired staging remains charged to its owner until explicitly aborted or forgotten.

```sh
bun run memory transfer-list --url http://localhost:3301 --credentials destination.json
bun run memory transfer-status --credentials destination.json --transfer TRANSFER_ID
bun run memory transfer-resume --credentials destination.json --transfer TRANSFER_ID \
  --source-url http://source:3301 --source-credentials source.json
bun run memory transfer-abort --credentials destination.json --transfer TRANSFER_ID
```

Use `--url` for a destination outside the default local service. Resume supplies the original source connection again; Marina does not store its credentials. A ready transfer can be committed without reconnecting to the source. The TypeScript `resumeMemoryTransfer(destination, space, id, { source, signal, progress })` helper follows the durable cursor and retries with stable request keys. Original source generations must remain unchanged.

Large publication runs in a trusted local subprocess, retaining one atomic SQLite transaction. Other tenants can continue reading. SQLite still permits only one writer: memory writes receive retryable `503 import_busy` during publication, and other database writers fail promptly on lock contention. Publication has a 120-second limit. Use a client timeout above that limit for large commits; the CLI uses 130 seconds. Cancellation waits for the child to exit, but a write may already have committed. Inspect status and retry with the same key to recover its receipt. File-backed databases and the bundled `dist/memory-import.js` entry are required for background publication; normal source installs include its TypeScript entry.

## Typed joins and authored rules

Joins match explicit typed claims. Entity IDs and literal strings remain distinct:

```ts
const person = { variable: "person", type: "entity" } as const;
const project = { variable: "project", type: "entity" } as const;
const query = {
  patterns: [
    { subject: person, predicate: "reviews", object: project },
    { subject: project, predicate: "status", object: { kind: "literal", value: "active" } },
  ],
  select: ["person"],
  valid_at: Date.now(),
} satisfies import("marina/memory").MemoryJoin;
const result = await memory.join(space, query);
```

Each match includes bindings, supporting record IDs and versions, and the intersection of their valid-time ranges. `valid_at` is optional; when supplied it uses UTC milliseconds and half-open ranges. Predicate variables use type `symbol`; literal variables use `string`, `number`, `boolean` or `null`. Repeated variables must agree in both type and value. Stale records are excluded.

Joins allow up to eight patterns, 256 distinct candidate queries, 8,000 candidates, 20,000 comparisons and 2,000 intermediate matches. Candidate and intermediate data each have a 4 MiB budget. Exceeding an intermediate budget returns `symbolic_budget_exceeded`. Final results are limited to 100 and report `truncated`; they never silently imply complete coverage. A caller-authored retrieval plan can include a `join` step.

Store a reusable rule as a native versioned memory:

```ts
const rule = await memory.saveRule(space, {
  schema: "marina.memory.rule.v1",
  name: "Reviewers of active projects",
  query,
  conclusion: { subject: person, predicate: "activeReviewer", object: project },
}, { source_ids: [policySourceId] });
const preview = await memory.runRule(space, rule.id, 1);
// An explicit authored write, after deciding to save the conclusions:
const saved = await memory.materializeRule(space, rule.id, 1);
```

A saved query retains its `valid_at` value. Pass a new `valid_at` to `runRule` or `materializeRule` when evaluating another time. Rules are nonrecursive pattern programs; they do not execute arbitrary code or infer verified truth. Their heads can use constants and variables bound by the body. Preview is read-only. Materialization refuses truncated results and saves inference records pinned to the rule and every supporting record version. Changing either can mark conclusions stale. Reaffirmation remains an explicit review action. To revise a rule, pass its `id` and `expected_version` to `saveRule`; native record history and portable transfers preserve its prior definitions.

World commands expose the same operations through `memory join`, `memory rule-save`, `memory rule-run` and `memory rule-materialize`, each accepting JSON. Native MCP callers can use `memory_service` with `join`, `save_rule`, `run_rule` or `materialize_rule`.

## Human workspace and MCP resources

Open **Memory** in the dashboard header after signing into world chat. The workspace uses that resident's authenticated connection and existing grants. It supports memory search, original source ranges, revision comparison, competing assertions, explicit reaffirmation, and transfer inspection or abort. Switching identity clears the displayed data. Service credentials are not stored in the browser.

`sourceHeaders(space, after, limit)` lists source metadata without loading original bodies; `sourceRange` reads the immutable text by byte range. These also appear as `source_headers` and `source_range` native operations.

The memory-only MCP bridge exposes `memory://space` in the native profile and `memory://knowledge-graph` in the reference graph profile. Resource reads recheck authorization. Subscriptions watch one configured resource per connection, poll at one-second intervals, and notify about HTTP and resident changes too. Notifications contain the resource URI; clients reread for content. Unsubscribe and disconnect stop polling. Access failure stops a subscription, which must be explicitly renewed after recovery. Resource bodies are limited to 1 MiB; use paged tools for larger data. These follow the [MCP resource protocol](https://modelcontextprotocol.io/specification/2025-06-18/server/resources).

For LangGraph namespace storage, see the optional [JSON store adapter](../../extensions/langgraph-store/README.md). Its `langgraph-store-json-v1` profile supports authored JSON and exact filters without an embedding model.
