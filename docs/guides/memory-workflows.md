# Put memory to work

Use `memory retrieve <question>` when you need evidence now. Use a task workflow when you want
someone—including a fresh agent—to continue the work later. Neither requires embeddings or an
LLM. An agent can use Marina's model router separately for reasoning and evaluation.

## Choose the shortest path

| You want to… | Human command | MCP tool / operation | TypeScript |
| --- | --- | --- | --- |
| Learn the workflow | `memory guide` | `memory_workflow`, `action: "help"` | `client.workflows(space).help()` |
| Find and read evidence | `memory retrieve <question>` | `memory_retrieve` | `client.retrieve(space, {task})` |
| Preserve a goal | `memory start <goal>` | workflow `start` | `work.start(goal)` |
| Retrieve and record the attempt | `memory run TASK_ID VERSION` | workflow `run` | `work.run(id, version)` |
| Continue after interruption | `memory resume TASK_ID` | workflow `resume` | `work.resume(id, true)` |
| Record completion | `memory finish TASK_ID VERSION completed <next step>` | workflow `finish` | `work.finish(id, version, "completed", next)` |
| Report usefulness | `memory feedback TASK_ID helpful <explanation>` | workflow `feedback` | `work.feedback(outcome)` |
| Reuse a procedure | `memory recipes`, then `memory recipe ID VERSION <question>` | workflow `recipes`, `use_recipe` | `work.recipes()`, `work.useRecipe(id, version, task)` |
| Follow corrections | `memory watch deployment RECORD_ID`, then `memory poll deployment` | workflow `watch`, `poll`, `ack` | `work.watch()`, `work.poll()`, `work.ack()` |

The world command and MCP responses return identifiers and versions; use those values in the
next command. Human output includes the next command to run. MCP and resident clients also
receive the complete structured result, including copyable `next_calls`. `memory tasks` shows saved goals when you have lost the ID; follow its next-page cursor if present.

For HTTP/TypeScript setup, follow [the memory service guide](memory-service.md#start-a-private-service).
For MCP setup, follow [memory interfaces](memory-interfaces.md). The installed
[Marina memory skill](../../skills/marina-memory/SKILL.md) teaches the same workflow.

## Try a complete working example

From a checkout, start the service with a new demo identity:

```bash
bun install
bun run memory init --db data/workflow-demo.db --name workflow-demo --credentials data/workflow-demo.json
bun run memory serve --db data/workflow-demo.db --embeddings none
```

In another terminal:

```bash
bun examples/memory-workflows/run.ts data/workflow-demo.json
```

The example creates disposable spaces, captures an original instruction, retrieves evidence,
records a task, compares a recipe offline, changes a premise, resumes using a fresh client,
acknowledges a notification, and records completion. It checks the returned evidence and the
changed premise and fails if either is missing. It prints IDs, counts and status, never credentials.
See [the executable source](../../examples/memory-workflows/run.ts). It leaves its spaces available
for inspection; remove them explicitly with the normal `forget` API when finished.

## Start, work, and resume

```typescript
import { MarinaMemoryClient } from "marina/memory";

const client = new MarinaMemoryClient(url, token);
const work = client.workflows(space);
const task = await work.start("Deploy Zephyr safely", {
  next_action: "Read the deployment procedure and check the current health path",
}, "deploy-17-start");

const run = await work.run(task.task_id, task.version, {
  selection: "balanced",
  max_results: 6,
  max_bytes: 8192,
}, "deploy-17-read");

// Inspect run.retrieval.evidence and diagnostics, then do the actual work.
// Marina has recorded retrieval, not executed your deployment.
await work.finish(task.task_id, run.version, "interrupted",
  "Port is documented; still need to check the health path", "deploy-17-pause");

// Another session, same authorized identity; no local conversation state required.
const resumed = await work.resume(task.task_id, true);
console.log(resumed.episode.next_action, resumed.premises, resumed.retrieval?.evidence);
```

`resume(id, true)` includes a fresh retrieval with balanced evidence selection so current records
get room alongside journal/source passages. Omitting `true` returns the saved next step,
checkpoint and premise status without another discovery query. If this is a Marina resident's
space, the result also includes its existing `resident` checkpoint, including journal/archive
references. Historical observation traces stay in the episode record and explicit export; they
are omitted from the concise resume view. Changed record premises include `current_version` and
an exact `read_current` call (get without a historical version). A saved next action is authored advice, not an instruction from the system.

A task has `open`, `running`, `ready`, `completed`, `interrupted` or `failed` status. `ready` means
retrieval completed; it does not mean the task succeeded. The service commits intent before
retrieval. A crash can leave `running`: retry the **same key and payload**, or explicitly mark the
attempt interrupted before starting a new one. `version_conflict` means read the current task
with `resume` before deciding what to change. Failed attempts remain in record version history.

For a different principal to continue or evaluate the same task, explicitly share both scopes:

```typescript
await client.grant(space, successorPrincipalId, "reader");
await client.grant(task.journal_space_id, successorPrincipalId, "writer");
// The successor uses its own credential, not the owner's token.
const successorWork = successorClient.workflows(space, task.journal_space_id);
const handoff = await successorWork.resume(task.task_id, true);
```

Shared journals require existing grants and must differ from the corpus. A journal grant covers
all its tasks; use a dedicated journal space when handing off only one task. No grant is created by
the workflow. The executor and outcome evaluator are attributed to their own principals. Revoke
a journal grant to stop further task access. HTTP/resident/MCP equivalents pass `journal_space_id`
alongside the workflow action; returned `next_calls` carry the same journal scope.

Task bookkeeping uses a separate space owned by the calling principal, named
`marina.tasks:<corpus-space-id>`. It does not add copies of questions to the retrieval corpus.
A writer credential with reader access to the corpus can keep its own journal. A credential
restricted to `memory:read` can retrieve, but cannot create a task journal. Task workflows use
normal source/record/checkpoint storage quotas and ordinary forgetting/export rules. Forgetting
inside a journal invalidates that journal's checkpoints under the existing forget contract; start
a new task for subsequent work rather than treating invalidated checkpoints as resumable.

Evidence manifests contain references, not hidden copies of the returned documents. Resume checks
current access and reports `changed`, `stale`, `out_of_time` or `unavailable` premises. Export requires `memory:export` on the credential and access to both corpus and journal; it checks
access again and fails if evidence was forgotten. Losing access to the corpus prevents workflow
reads as well. Previously exported copies cannot be retracted from another computer.

To move selected evidence and task intent to another authorized corpus, export an observation and
explicitly import it:

```typescript
const observation = await work.exportEpisode(task.task_id);
const recipient = client.workflows(otherSpace);
const imported = await recipient.importEpisode(observation, {}, "import-deploy-17");
const checked = await recipient.run(imported.task_id, imported.version);
```

Import requires write access to the target corpus. It creates new canonical records/sources with
attributed origins, and an interrupted task requiring review. Imported ranges are excerpts, not a
claim to possess the original full document; assertions remain unverified. Import does not replay
action side effects or certify another system's execution. The imported task acquires its own live
retrieval observation only after an explicit `run`. Normal portable bundles remain available for
moving a larger corpus.

## Tell retrieval what you need

The default `sources_first` selection remains available. Balanced/records-first discovery leaves
room for every planned read instead of letting a dense first search consume all discovery slots. `balanced` reserves early budget for
records and original passages; `records_first` starts with records. An item can still be omitted
if it cannot fit. Selection is explicit per call; no recipe is silently promoted to a default.

```typescript
const result = await client.retrieve(space, {
  task: "Zephyr launch procedure",
  selection: "balanced",
  expansion: { policy: "team-vocabulary-v1", queries: ["Zephyr deployment runbook"] },
  steps: [
    { operation: "source_search", input: { query: "Zephyr launch" } },
    { operation: "query", input: { subject: "app:zephyr", predicate: "health:path" } },
  ],
  requirements: [{ kind: "claim", subject: "app:zephyr", predicate: "health:path" }],
  max_bytes: 8192,
});
```

Alternatives are explicit lexical hints. They do not rename exact symbols or prove equivalence.
Use symbolic `query`, `graph` or `join` steps when the relationship matters. `requirements` reports
whether the **selected evidence** contains a declared claim or source byte range; it does not
add an implicit query or establish that the answer is correct. `known_conflicts` identifies
differing values among discovered current claims; it does not adjudicate them or exhaust the
corpus. Use `review` and explicit resolution when needed.

Overlapping windows of the same immutable source are coalesced when their union fits the
per-source byte allowance. Larger windows remain separately cited. `max_bytes` bounds the
returned evidence array. Plan, diagnostics and optional observation data have separate bounds.
Sources use UTF-8 byte ranges and a full-text hash. A partial source needs adjacent `source_range`
reads if the surrounding context matters. `valid_at` filters versioned claims; original documents
can contain historical assertions. `answer_sufficiency` remains `not_assessed`.

## Record an outcome without inventing certainty

```typescript
await work.feedback({
  task_id: task.task_id,
  rubric: "Deployment used the documented port and passed the health check",
  result: "pass", // helpful | unhelpful | pass | fail | unknown
  explanation: "The deployment check returned HTTP 200 from /healthz.",
  metrics: { model_calls: 2, input_tokens: 1400, output_tokens: 120, cost_usd: 0.002 },
}, "deploy-17-outcome");
```

Capture original test/tool output with `client.capture` and supply exact `evidence` references
when available. Outcome records identify the evaluator principal, rubric, task version and
caller-reported metrics. A usefulness vote is not verification. Distinct helper roles using the
same model are not independent evaluators. Report failures and the cost of failed attempts too.

## Inspect, compare and transfer a recipe

A recipe is versioned declarative data. It cannot upload code, change grants, or activate itself.
Prerequisites and exceptions are inspectable guidance; Marina does not infer that they are met.

```typescript
import { compareMemoryRecipes, type MemoryRecipe } from "marina/memory";

const recipe: MemoryRecipe = {
  schema: "marina.memory.policy.v1",
  name: "Claims with original context",
  description: "Place a record and an original passage early in the evidence budget.",
  retrieval: { selection: "balanced" },
  prerequisites: ["The corpus contains original sources and/or versioned records"],
  exceptions: ["Unfamiliar wording may need explicit alternatives"],
  compatibility: "marina.memory.retrieval.v1",
  evidence: [], // Authorized episode/comparison record pins: {space_id, id, version}
};
const observation = await work.exportEpisode(task.task_id);
const comparison = compareMemoryRecipes(observation, [recipe]); // No network or model calls
const saved = await work.saveRecipe(recipe, "recipe-17");
const selected = await work.useRecipe(saved.id, saved.version!, "Zephyr deployment");
// To capture the selected version in an episode:
// await work.runRecipe(task.task_id, currentTaskVersion, saved.id, saved.version!);
```

Offline comparison runs the same evidence-selection interpreter as live retrieval. It can change
selection order or reduce the observed output budget. Omitted recipe fields use live defaults;
they do not silently inherit an episode's custom expansion or source-read size. A different query, vocabulary expansion,
time, source-read size, or larger envelope is `unsupported` and requires a live trial. Results
are `observed_only`, with discovery truncation disclosed. They are not predicted model answers,
quality scores or counterfactual latency. Keep exported observations and comparison reports in
your authorized private storage; ordinary memory records can hold an attributed comparison.

`saveRecipe` stores a skill record in the chosen corpus; `recipes` lists it. Use ordinary CAS
`revise` to publish a new version, and select that version explicitly. Withdraw by ceasing to
select it, or forget the record to remove it. Imported recipe data remains inactive. A successor
can use `saveRecipe` or normal portable bundles, inspect evidence/prerequisites, and explicitly
call `useRecipe` after the author has stopped. Supporting references still require permission;
when publishing a recipe, deliberately share the evidence you intend the recipient to inspect.

## Ask a scoped helper

Existing librarian, reflector and evaluator roles can now request:

```json
{"operation":"retrieve","input":{"task":"Zephyr deployment port","selection":"balanced"}}
```

Pass that request to `MarinaMemoryAssistance.read(jobId, leaseToken, request)` or `assist_read`.
The helper is bound to the job's corpus and live lease. Discovery steps, witness hydration and
source reads consume the shared root operation budget. Repeating a composite read consumes its
underlying read budget again. Helpers cannot enable model planning through this read API; their
own reasoning can use the Marina router. Graph depth remains at most three, source windows are
bounded, and assistance request sources are excluded from evidence. No permanent space grant is
created. See [the complete assistance loop](memory-assistance.md).

## Retrieve across selected peers and reuse a result

The operator first configures principal-bound mounts as described in
[portable memory extensions](memory-extensions.md). Callers select aliases, never arbitrary URLs:

```typescript
const across = await client.federatedRetrieve(space, ["team", "archive"], {
  task: "Zephyr deployment", max_results: 6, max_bytes: 8192,
}, true); // Explicitly accept partial availability
console.log(across.peers, across.evidence);

const taskTime = Date.now(); // Keep fixed for as-of reuse; advance it for a new question about now.
const reused = await client.retrieveCached(space, {
  retrieval: { task: "Zephyr deployment", valid_at: taskTime, selection: "balanced" },
  mounts: ["team"], // Omit for local retrieval
  cache: "read_write",
  ttl_ms: 60000,
}, "deploy-17-cache");
```

Peers are visited in the requested order under **one total evidence budget**. The result names
`ok`, `truncated`, `unavailable` and `budget_exhausted` peers. Later peers may receive no budget;
reorder the mounts or narrow the task when that matters. Snapshots are per peer, not a distributed
transaction. `allow_partial` defaults to false for peer errors; budget exhaustion is always explicit.

Cache lookup is opt-in. `read` (default) never writes; `read_write` stores a miss; `refresh` skips
lookup and requests a new stored result. Writes require write authority in the cache space.
Reuse requires an explicit `valid_at` because time alone can change current claim eligibility.
This is an as-of query; choose a new timestamp when you need an answer about now. Identity,
parameters, software policy, generation, expiry, local pins and live remote evidence seals are
validated. New evidence or lost access invalidates reuse. Unavailable/unvisited/empty peer bases
are not stored. Remote validation has a cost; the response says whether a validated hit occurred.

## Subscribe without surrendering control

```typescript
await work.watch("deployment", [premiseRecordId]);
const batch = await work.poll("deployment", 50);
// Process batch.changes.events and batch.temporal_due, then acknowledge:
await work.ack("deployment", batch.acknowledgement);
```

Pass the complete acknowledgement object to preserve its observed-time watermark; acknowledging only
a cursor leaves temporal notifications pending. This prevents a validity change between poll and ack
from being silently skipped. A poll does not acknowledge. A crash before acknowledgement repeats the same events, allowing
at-least-once handling. Use `seq` to deduplicate effects. Follow `has_more` with another poll after
acknowledgement. Watch checkpoints survive restart and have CAS versions; concurrent consumers
must resolve `version_conflict`. `unwatch(name, version)` stops delivery. Use
`changes(cursor, ids, limit)` for a stateless cursor consumer.

The feed contains operation names, IDs, versions and timestamps, not document bodies. Scope-wide
grant/forget events also reach filtered watches so consumers can revalidate their selected premises. Access is
checked at every poll. Watches with explicit record IDs also report crossed validity boundaries
and the next known boundary. Source IDs have no claim-validity schedule. A watch without IDs
follows all corpus events; it does not scan all records for temporal transitions. Nothing launches
an agent or executes a procedure because a notification arrived.

## HTTP and resident tools

All workflow actions use `POST /v1/memory/spaces/:space/workflow`, with bearer authentication.
For mutations, send `Idempotency-Key`. Read actions do not require one.

```json
{"action":"start","goal":"Deploy Zephyr safely","task_id":"deploy-17"}
```

```json
{"action":"run","task_id":"deploy-17","expected_version":1,"retrieval":{"selection":"balanced"}}
```

```json
{"action":"resume","task_id":"deploy-17","retrieve":true}
```

A resident calls `marina_memory_service` with `operation: "workflow"` and the same object as
`input`. Omit `space_id` to use its private space. A TypeScript resident can construct
`MarinaMemoryWorkflows(space, call)` with its own operation transport. Dedicated MCP
`memory_workflow` exposes common fields directly; advanced fields go in `input`. Generic
`memory_service` supports the identical operations.

## When something goes wrong

| Result | Useful next action |
| --- | --- |
| `empty` | Try distinctive terms or an explicit alternative; check that originals were captured. |
| `budget_exhausted`, `truncated` | Increase the relevant budget, narrow the task, or read adjacent source ranges. |
| `plan_changed`, `cache_basis_changed` | Memory changed during the operation; retry against the new state. |
| `version_conflict` | Resume/poll/get the current version; do not blindly overwrite it. |
| `running` after restart | Retry the same operation key, or explicitly close the interrupted attempt. |
| `episode_incomplete` | The episode has no completed retrieval to export. Inspect its state and error. |
| `unsupported` comparison | Run a live trial for the new read program. |
| Source/space unavailable | Check scope, credential expiry, sharing and forgetting; do not reuse an old cached payload. |
| `assistance_budget` | Narrow the read or create an explicitly larger bounded request. |

These interfaces prove what was stored, read, revised and resumed. Whether a recipe improves an
agent's task quality still requires matched evaluations with realistic tasks and complete costs.

For a bounded provider-backed handoff check through Marina's existing router, developers can run
`bun run qualify:memory:task-workflows /tmp/marina-task-check 0.5` from a configured checkout.
The output directory must be outside the public repository. This exercises fresh external and
resident agent processes; its reports measure this controlled task chain, not general usefulness.
