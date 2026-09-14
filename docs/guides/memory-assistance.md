# Memory assistance

Marina participants can ask a librarian, reflector, or evaluator to investigate a
memory task. Helpers use the same commands and durable memory API as humans and
external agents. Results are attributed, cited proposals; they do not certify
claims as true or change the requester's existing records.

## Start resident helpers

The `memory-librarian`, `memory-reflector`, and `memory-evaluator` roles are seeded
when absent. You can inspect and edit them with the ordinary role commands.
Spawning uses Marina's existing `agent.spawn` permission and deployment profile.

```text
agent spawn Librarian model marina/default role memory-librarian budget 40
agent spawn Reflector model marina/default role memory-reflector budget 40
agent spawn Evaluator model marina/default role memory-evaluator budget 40
```

Run each command after the preceding spawn completes. Helpers are resident agents;
`marina/default` routes their model calls through Marina. One configured upstream
model can serve all three. Helpers wait for direct work notifications, and model
call budgets pause them when exhausted. Inspect them with `agent status NAME`.
No embedding model or additional memory database is required.

## Ask for help

```text
memory remember Project Amber deploys on port 7419
memory assist librarian Librarian Find Amber's deployment port and cite the evidence
memory jobs
memory jobs {"open":true}
memory assistance REQUEST_ID
```

`memory assist` delegates reading of your private resident space. To choose another
space you own, use `memory api` or the TypeScript/MCP interfaces. A shared-space
writer cannot delegate the owner's authority. Each request names one helper's
durable principal. It does not grant that helper general access to the space.

The librarian finds evidence and explains uncertainty. The reflector compares
observed attempts and outcomes to propose a reusable lesson. The evaluator checks
the support and limitations of a claim. You choose whether to adopt their proposals
using ordinary versioned memory operations. No automatic verification, ratification,
standing credit, or destructive pruning occurs.

## TypeScript and MCP

```ts
import { MarinaMemoryAssistance, MarinaMemoryClient } from "marina/memory";

const memory = new MarinaMemoryClient(url, token);
const help = MarinaMemoryAssistance.http(memory);
const request = await help.create(spaceId, {
  role: "librarian",
  worker_id: helperPrincipalId,
  task: "Find Amber's deployment port and cite the evidence",
  max_operations: 32,
  timeout_ms: 600_000,
}, "amber-port-request-1");
const status = await help.get(request.id);
```

The world and memory-only MCP servers expose `memory_assist`. The shared
`memory_service` tool exposes `assist_jobs`, `assist_get`, `assist_claim`,
`assist_read`, `assist_heartbeat`, `assist_finish`, `assist_cancel`, and
`assist_delegate`. Human commands and the resident SDK use the same correlated
operation replies.

`assist_jobs` accepts `input: {open:true, limit:100, cursor:NEXT_CURSOR}`.
`help.jobs({open:true})` uses the same filter. Follow `next_cursor` until null;
authorization changes can produce an empty page with another cursor. Cursors
are bound to the caller and the `open` filter. Selecting open work filters out
completed history before limiting the page.

Resident agents also have a typed `marina_memory_assistance` tool in every tool
profile. Its nested `request.id` identifies the record or source being read;
the outer `id` identifies the assistance job. Use `source_search` to discover
original documents and `source_range` to read them. `search` searches authored
records, which can refer to sources but do not cover all captured documents.

External workers can use `help.work(requestId, { next, maxTurns, signal })` with
their own model callback. `next` receives model-neutral messages and may call
Marina's model endpoint. The loop claims the request, renews its lease, restricts
reads, validates its cited answer, and submits the proposal. It reports errors,
exhaustion, and abstention separately. A failed worker can reclaim after its lease
expires; use a new claim key for a new attempt.

## Evidence and delegation

Helpers must read evidence through `assist_read`. Supported operations are
`search`, `query`, `graph`, `get`, `source_search`, `source_range`, `vocabulary`,
and `review`. The service binds identity and space; embedded write requests or
requests to another space are rejected. Search is lexical; the helper can reason
about aliases and alternative queries. Original source ranges remain readable.

Completion requires exact quotations from witnessed reads and current versions.
This checks citation mechanics, not semantic entailment. An evaluator's judgment
is still attributed opinion. All observed records and sources are attached as
dependencies of the result, including observations omitted from its citation list.
Changed premises make results stale; unavailable evidence prevents their use.
Editing a result record also invalidates its job result, so later edits cannot
be presented as the helper's original answer.

Helpers may call `assist_delegate` with their lease token, another worker's
principal ID, a role, and a subtask. Children retain the same space, owner
authorization, deadline, and shared operation budget. A parent worker can inspect
its child's job, but must independently read evidence before citing it. Cycles are
rejected. The limit is three delegation levels below the root and eight requests
in the entire tree.

The TypeScript client exposes `help.delegate(id, leaseToken, { worker_id, role,
task })` and `help.heartbeat(id, leaseToken)` for these operations.

## Lifecycle and limits

- Requests and proposals survive process restarts. Requests use canonical sources;
  results use versioned records. Work leases and request IDs are durable coordination
  metadata. Portable memory exports preserve artifacts, not live work assignments.
  World JSON exports also omit leases; restoring a world closes existing assistance
  assignments. Create new requests after restore. SQLite snapshots retain the full
  durable job state, subject to the original credential and deadline checks.
- A claim lasts up to two minutes and can be renewed before expiry. Lease tokens
  fence delayed workers after a new claim. Reuse a key and identical input to retry
  a mutation; a repeated read uses current authorization and current data.
- `state` records the last work transition. `work_open` projects whether the
  request is unfinished, within its deadline, and has open ancestors. A deadline
  passing closes work without rewriting that history. An expired lease on an
  otherwise open request can be reclaimed; an expired request needs a new request.
- A root request defaults to 32 delegated read/subtask operations and ten minutes.
  The owner can select 1–128 operations and 1 second–1 hour. These are protocol
  bounds; the resident's model-call budget separately bounds model execution.
- Responses are limited to 128 KiB, proposals to 32 KiB, and witnessed evidence to
  256 entries. Coordination metadata counts toward the owner's storage budget.
- `memory assist-cancel REQUEST_ID` withdraws an unfinished request and closes
  its descendants' delegated reads. Expiry, credential revocation, or principal
  suspension also closes delegated access. Already delivered content cannot be
  recalled from another participant's process.
- Forgetting within a space conservatively retires assistance request sources and
  their derived proposals, as well as opaque checkpoints. This prevents copied task
  text from retaining material the owner asked Marina to forget.
- Helpers receive direct notifications containing request IDs, state, and budget.
  Durable `assist_jobs` discovery recovers missed notifications. Finished work does
  not depend on receiving a particular chat reply.

Direct memory reads remain usable when no helper or model is available.

## Validate a deployment

The real-resident qualification creates a disposable Marina instance and uses
`marina/default` for all helpers and a fresh consuming agent:

```sh
bun run qualify:memory:assistance \
  --directory /tmp/marina-assistance-qualification --budget-usd 2
```

It needs the configured upstream key. The harness checks a randomized answer used
by the consumer, the reflector's original incident citation, and the evaluator's
original methodology citation and stated limitations. It bounds upstream spending
and writes reports and traces only to the chosen private directory. These are
functional workflow checks; they do not establish general retrieval accuracy,
statistical improvement, or long-horizon reliability across workloads.
