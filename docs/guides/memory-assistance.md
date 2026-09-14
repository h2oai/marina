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

## Curator duties (Phase 3.1)

The three helpers also carry the curator duties — no fourth role:

- **Evaluator = Steward.** When a job names competing, stale, or pending
  assertions (a `[hygiene]` or `[shared-write-review]` task), it adjudicates each
  with citations and *proposes* a `resolve` policy — `last_writer_wins`,
  `evidence_weighted`, `await_confirmation`, or `keep_both` — as part of its
  answer. It never applies one; the owner runs `memory resolve`, or does not.
- **Librarian = Auditor.** Given a space to sweep, it finds unsupported claims,
  duplicates (repetition is not corroboration), and suspicious low-provenance
  clusters, proposes what to merge/retire/source, cites each finding, and never
  deletes.
- **Reflector = Janitor.** Given an accumulation of related notes (an
  `[accumulation]` task lists ids and topic), it proposes ONE consolidated lesson
  that cites every source it merges. Append-and-link: the owner adopts it as a new
  record linked to its sources; the originals are never rewritten.

**Re-seeding rule.** Roles are installed when absent. A stored role is upgraded
on boot only if its description tail carries an older `[guidelines_version=N]`
marker (missing = 0) than `MEMORY_HELPER_GUIDELINES_VERSION` *and* nobody but
`system` has ever saved it (`created_by` and every `role history` row). An
operator-edited role is preserved at any version; copy new duty lines in with
`role edit` if you want them.

## Automatic dispatch (Phase 3.2)

Three triggers file assistance jobs without anyone typing `memory assist`. Every
automatic job is an ordinary request: it appears in `memory jobs`, can be withdrawn
with `memory assist-cancel ID`, and its result is a cited proposal, not a change.

| Trigger | When | Files | Guard |
| --- | --- | --- | --- |
| Hygiene (`[hygiene]`) | hourly; `stale + competing + pending ≥ 5` | one evaluator job (local) / tells the owner the command (shared, public) | one open hygiene job per account |
| Accumulation (`[accumulation]`) | hourly; ≥ 8 fact-like personal notes in 24 h sharing a topic | one reflector job "Consolidate these N notes about *topic*" with the note ids | one open job per account; a process-tier `[accumulation] … max_note=ID` receipt prevents re-filing for the same notes; no reflector running → one hint per day with the spawn command |
| Shared-write review (`[shared-write-review]`) | a `pool_note` deposit by a writer with standing < 5 (below rank 1) | one evaluator job against the *writer's own* space, deposit text included as untrusted data | at most one per writer per hour; one open review per writer; silent (never notifies); skipped entirely under the `local` profile |

Topic clustering is deterministic and lexical: distinct content terms (lower-cased,
≥ 4 chars, stop-words dropped); the term with the highest document frequency names
the cluster, ties break alphabetically. The task carries legacy note ids; the
reflector reads the durable twins through `assist_read` by searching the topic terms.
The debounce maps are in-process and reset on restart; the durable guards (open-job
marker, receipt note) do not.

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

## Adopt a proposal

```text
memory adopt REQUEST_ID                          # into the job's own space
memory adopt REQUEST_ID space GUIDE_SPACE_ID {"rationale":"matches the docs"}
memory adopt REQUEST_ID confirm-abstention       # credit an honest abstention
pool guide ratify 42 importance 8 verified against the registry
```

`adopt` (HTTP `POST /v1/memory/assistance/:id/adopt` or `/spaces/:space/adopt`, TS
`client.adopt(space, jobId, input, key)`, Python `adopt`, MCP `memory_service` op `adopt`)
turns an `answered` job's proposal into a versioned record. Record citations you can read
become `depends_on`/`dependency_versions`, source citations `source_ids`, and the proposal
record is `metadata.derived_from`. Adopting the same job into the same space twice returns
the same record. The helper earns `assistance_adopted` standing (1.0; delegated trees split
0.6 root / 0.4 shared among answered contributors); a confirmed abstention earns 0.25; an
adopted record later superseded by `memory resolve` debits 0.5.

Institutional spaces (the durable twins of `guide`, `orchestration:*`, `tradition:*`; owned
by the `guide` system principal, readable by everyone) accept only ratifications: standing
≥ 15, a sovereign, or the ungated local operator. Every ratified record carries
`metadata.ratified_by`, so a shared record always answers "why is this shared?". On a shared
instance `pool guide add` files a proposal (importance capped at 4, unverified) until
`pool guide ratify <noteId>` lifts it and mirrors it into the institutional space.

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
