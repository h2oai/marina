---
name: marina-memory
description: Use Marina as durable memory for coding and long-running agent work. Store original evidence, explicit symbolic claims and checkpoints; query or traverse them without embeddings; resume across sessions using Marina MCP tools or the TypeScript HTTP SDK.
license: Apache-2.0
---

Use the configured Marina memory service. Discover its actual capabilities with
`memory_service` operation `capabilities`; use `me` and `spaces` to inspect identity and scope.
Omit `space_id` for the configured private space. Reuse exact entity and predicate symbols.

## Resume work

Call `memory_service` with `operation: "checkpoint"` and `id: "work"` (or the task's checkpoint
name). A missing checkpoint is normal on first use. Read its `data`, then replay evidence with
`operation: "sources", input: {after: SOURCE_CURSOR}`. Continue pagination until caught up.
Query relevant subjects using `memory_query`. Use `memory_graph` for relationships; its paths
cite records. Read those records and their evidence before treating a claim as established.

## Preserve evidence and meaning

Capture raw tool output before summarizing it:

```json
{"operation":"capture","key":"task-123-evidence-1","input":{"session_id":"task-123","content":{"tool":"test","result":"3 pass, 0 fail"}}}
```

Use the returned source ID in `memory_remember`:

```json
{"content":"Tests passed for this revision.","claim":{"subject":"task:123","predicate":"test:status","object":{"kind":"literal","value":"passed"}},"source_ids":["SOURCE_ID"],"key":"task-123-status-1"}
```

Literal objects preserve string, number, boolean or null types. Entity objects use
`{"kind":"entity","id":"project:marina"}`. Entity IDs are explicit symbols, not fuzzy name
matches. A claim represents an assertion; do not invent evidence or infer certainty from a
stored label. Cite record ID, version and source IDs when using a memory in an answer.

For exact recall use `memory_query` with `subject`, `predicate` and/or `object`. Follow
`next_cursor`; a `query_changed` error means restart pagination. Lexical search is available
through `memory_service` operation `search`; embedding retrieval is optional and must be
explicitly configured and requested with `mode:"hybrid"`. Omitting mode always uses lexical
retrieval. Inspect `degraded` if using hybrid retrieval.

For task-directed discovery, call `plan` with `input: {task: TASK}` and inspect its steps, then
call `execute_plan` with that plan as `input`. This covers records and original sources.
`use_model:true` requests the operator-configured Marina model planner. Treat plans as read
programs, not answers; check truncation and read cited evidence. A `plan_changed` error means
replan. To search only originals use `source_search`; read `source_range` with the source ID,
then follow `next_start` while preserving `text_hash` to recover complete UTF-8 evidence.

Inspect `vocabulary` before writing symbolic claims. If it declares a closed predicate set,
use those names and object types; pin `expected_vocabulary_version` when required. Temporal
claims use `valid_time: {from, until}` in UTC milliseconds, with null for unbounded endpoints.
For a question about a time, use `query` or `graph` with `valid_at`. Do not choose the first text
search result as the current or historically valid assertion; intervals are `[from, until)`.

## Correct and checkpoint

Revise a record using `memory_service`, operation `revise`, `id: RECORD_ID`, and
`input: {expected_version: CURRENT_VERSION, content: NEW_TEXT, claim: NEW_CLAIM}`. Omitting
`claim` retains it; `claim: null` removes it. On conflict, read the new version before deciding.
Use `depends_on` and `dependency_versions: {RECORD_ID: VERSION}` when storing a conclusion
derived from records you read. A correction marks current dependents stale transitively;
default retrieval excludes them. Inspect `get` or `include_stale:true` for review. Read changed
premises before explicitly rebinding all dependency versions on a revised conclusion; editing
its text alone does not clear stale status. A current binding is not a truth certification.

Save resumable work with `operation: "save_checkpoint", id: "work"` and
`input: {expected_version: VERSION, source_cursor: ACKNOWLEDGED_CURSOR, source_ids: [SOURCE_ID], data: {goal, next, record_ids}}`.
Use version 0 for a new checkpoint. Acknowledge only evidence already processed. The service
validates declared checkpoint source references at commit. External agents must capture their
own context; Marina residents journal completed messages and archive originals before lossy
compaction. Follow `data.journal.manifest_source_id` and its previous-manifest links to read
recent completed messages. Partial streaming and external tool effects are not transactional.

For many sources, use `capture_batch` with 1–64 `items`, each carrying its own `key`,
`content` and optional `session_id` (1 MiB total). Keep item keys when regrouping retries.

Reuse the same mutation `key` and payload after a timeout or disconnect; do not assume an
ambiguous write failed. Check `isError` / `ok`, not only the text response. Use `grant` only
for an intended sharing operation. `forget` propagates through recorded source/record
dependencies; it cannot retract copies already exported to other systems.

## Other interfaces

Residents have the `marina_memory_service` tool and `memory api <JSON request>` command.
Humans can use `memory claim project:marina status "active"`,
`memory query {"subject":"project:marina"}`, and `memory graph project:marina`.
TypeScript consumers use `MarinaMemoryClient` from `marina/memory`; its `remember`, `query`,
`graph`, `capture` and checkpoint methods use the same records and permission checks.
If no service connection is configured, report that setup is needed; do not claim persistence.
