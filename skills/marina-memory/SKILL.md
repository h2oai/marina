---
name: marina-memory
description: Use Marina as durable memory for coding and long-running agent work. Store original evidence, explicit symbolic claims and checkpoints; query or traverse them without embeddings; resume across sessions using Marina MCP tools or the TypeScript HTTP SDK.
license: Apache-2.0
---

Use the configured Marina memory service. Discover its actual capabilities with
`memory_service` operation `capabilities`; use `me` and `spaces` to inspect identity and scope.
Omit `space_id` for the configured private space. Reuse exact entity and predicate symbols.

## Task workflow

Call `memory_workflow` with `action:"help"` to discover runnable examples. For work that must
survive a restart: `start` with `goal` → `run` with returned `task_id` and `expected_version` →
inspect cited evidence → do the actual task → `finish` with the current version, status and
`next_action`. `resume` returns changed/unavailable premises; pass `input:{retrieve:true}` for
fresh evidence in that call. `tasks` rediscovers saved IDs. Keep stable mutation keys for retries.
A `ready` episode means retrieval completed, not that the task succeeded. A changed premise lists
`current_version` and `read_current`; get its current version, not the historical reference. Report outcomes with
`feedback` (`input:{task_id,rubric,result,explanation,metrics}`). Do not turn helpful votes into truth.

For another principal to continue the same task, the owner must explicitly share the corpus and
journal. Use your own credential and the supplied `journal_space_id`; workflows never add grants.

Use `recipes`/`use_recipe` only after inspecting prerequisites, exceptions and evidence. Recipes
are inactive data until explicitly selected; stop selecting one to withdraw it. `watch`/`poll`/`ack`
provide resumable notifications; acknowledge only processed events, and never execute work merely
because a notification appeared. Human equivalent: `memory guide`. Full examples and error recovery:
[workflow guide](https://github.com/h2oai/marina/blob/main/docs/guides/memory-workflows.md).

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

For task-directed discovery, start with `memory_retrieve` using `{task: TASK}` (or
`memory_service` operation `retrieve`, input `{task: TASK}`). It finds records and reads
original source windows in one request, without embeddings. Cite the returned record versions
or source `id`, `text_hash`, `start`, `end` and exact quotes. Check `diagnostics`: an empty
result does not prove absence, broadened matches need relevance checks, and truncated windows
may need adjacent `source_range` reads. `max_bytes` bounds the evidence array, not metadata.
The service does not judge whether evidence answers the task. `valid_at` filters records;
original documents can contain historical claims. Use `broaden:false` for strict source matching.

For custom read programs, pass `steps` to `retrieve`, or call `plan` then `execute_plan`.
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

## Ask or work as a memory helper

`memory_assist` assigns a librarian, reflector, or evaluator a task in a space you own.
Supply `worker_id` (the helper's principal), `role`, `task`, and optional operation/deadline
limits. This delegates bounded reading. Helpers may return cited proposals or abstain;
their role does not authorize edits to the owner's existing memories or certify truth.

Workers discover `assist_jobs` with `input:{open:true}` and follow `next_cursor` using the
same filter, including empty pages. Inspect `assist_get`, claim with `assist_claim`, and
retain its lease token. Read evidence with `assist_read`, placing the record/source ID in
`input.request.id`, alongside `input.request.operation`. Use `source_search` for originals;
ordinary `search` covers authored records. Complete with `assist_finish` using exact quotes
and current evidence IDs/versions from these reads. Inspect errors before continuing.

Renew long work with `assist_heartbeat`. `work_open` reflects deadlines and ancestor
completion; `state` retains the last recorded transition. After a lease expires, reclaim
using a new attempt key. A new request is needed after the request deadline. `assist_delegate`
can hand a bounded subproblem to another principal under the shared root budget and deadline.
Use `assist_cancel` to withdraw your unfinished request. Ordinary goals, tasks and projects
remain authoritative for their own work; helper completion is one attributed result.

## Other interfaces

Residents have the `marina_memory_service` and typed `marina_memory_assistance` tools and
the `memory api <JSON request>` command. Helpers can use `marina/default` as their model.
Humans can use `memory retrieve <task>`, `memory claim project:marina status "active"`,
`memory query {"subject":"project:marina"}`, and `memory graph project:marina`.
TypeScript consumers use `MarinaMemoryClient` from `marina/memory`; its `remember`, `query`,
`retrieve`, `graph`, `capture` and checkpoint methods use the same records and permission checks.
If no service connection is configured, report that setup is needed; do not claim persistence.
