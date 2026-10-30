# Orchestration: One Catalogue, Four Ways to Run It

**When to read this:** you are adding or changing a formation in the catalogue (`src/orchestration/formations/`), a project pattern template, crew pool access, crew formation briefs, or the formation mediators. `CLAUDE.md` → "Orchestration Patterns" states the invariants (convention-based, members-only crew pools, one mediator line per event); this page has the mechanics.

## One catalogue, four ways to run it

Every formation is one entry in `src/orchestration/formations/catalogue.ts` (`FORMATIONS`): its
name, one-line summary, fit (task shapes), roles, protocol steps, and the Score templates it runs
as. The catalogue is the only list of formation names. Each surface resolves a name through
`canonicalFormationName`, so the legacy aliases `nsed` (→ `deliberation`) and `custom`
(→ `freeform`) keep parsing; help and listings show catalogue names only.

| Way to run it | Command | Which entries | What runs |
| --- | --- | --- | --- |
| A crew | `crew create <name> <members> formation:<f>` | `crew: true` (16 formations + `freeform`) | The crew brief (`CREW_BRIEFS`), mediators, and request protocols. `crew info` shows the entry's summary, roles and protocol. A `crew dispatch` adds the entry's Score steps when it has a free-text template (`scoreStepsLine`). |
| A project | `project <name> orchestrate <f>` | `crew: true`, except `freeform` | Pool notes: an opening note generated from the entry (title, summary, roles, protocol) plus the pattern's project conventions. |
| One free-text task | `pattern run <f> -- <task>`, `POST /v1/patterns/run` | the entry has `text` | The entry's Score template on the operator's models. |
| A room's turn rule | `build formation [room] <f>` | the entry has `room` | One `[formation-mediator]` line per `say`. |

`ensemble` and `skeptic` are catalogue entries without a crew protocol: they run as `pattern run`
(ensemble) and as typed forecasts. `crew create … formation:skeptic` is refused with that reason.
Typed forecasts and the arena's `ensemble`/`delphi` also run the catalogue's templates (see
[The formation catalogue](#the-formation-catalogue-one-formation-one-template)).

## Patterns
- The 16 orchestration patterns are the catalogue's crew formations; as a project they are convention-based pool notes discovered via `recall`, not engine constraints
- Templates in `src/world/templates/orchestration.ts`: per pattern, the generated opening note plus 4 project-convention notes, and `PATTERN_FIT` (the catalogue's fit and summary); `project <name> recommend` ranks fitting patterns by this world's own recorded outcomes (no static scores)
- Shapes (`TaskShape`): `decomposable`, `contested`, `parallel`, `sequential`, `hierarchical`, `shared-artifact`, `open-ended`, `verifiable` (a mechanical check decides: failing tests, a test suite, a reference implementation, verification). `detectTaskShapes` keyword-matches a goal; `suggestPatterns` ranks patterns by shape overlap
- Every command a template note quotes must exist with that syntax — `test/orchestration-templates.test.ts` runs the knowledge-hygiene auditor over every template

## Crew pools and the crew runtime layer
- **Crew pools are members-only**: every persisted crew's `crew:<name>` pool has a group object of the same id (`memory_pools.group_id`; the existing group-pool ACL in `src/memory/access.ts` and the `gatherRetrievalContext` guard are the fence). Roster = owner ∪ current members, re-synced on create/persist, add/remove, dispatch, deposit, dissolve (final sync) and `loadFromDb` (idempotent backfill of pre-existing ungrouped pools); dissolving keeps the pool and notes (generational memory) scoped to the final roster; a successor crew reusing the name inherits and re-syncs. `crew info <dissolved>` no longer prints pool notes to non-members. Tests: `test/crew-pool-group.test.ts`.
- **Crew runtime layer** (`src/coordination/crew-formations.ts`): `CREW_BRIEFS` — compact purpose-built runtime brief per formation, posted with a protocol-priority preamble on activation/formation change (replaces concatenated pool-note prose, because process-heavy briefs displace the crew's actual replies). `FORMATION_MEDIATORS` — deterministic event-driven nudges: crew-manager calls `onDispatch`/`onStageCompleted`/`onArtifact`, posting at most one `[formation-mediator]` line per event (pipeline handoffs, mapreduce fan-out/merge, foundry merge-gate, debate sealed-positions, deliberation one-round, blackboard no-fork). The other formations — swarm, chorus, symbiosis, research, delphi, tournament, verification, auction, ledger, sharding — run on their brief alone. Briefs and dispatches name the real lead (`crewLeadName`: the `lead`-role member, else the first member), crew and channel in place of the `<lead>` / `<name>` / `<crew-channel>` placeholders, and a `Lead:` line says the requester is not part of the protocol. Every `[crew-task]` dispatch for delphi, tournament, verification, auction, ledger and sharding restates that formation's starting move for the task at hand (`dispatchStartMove`), so the essential protocol command sits where members act; the pool-note templates stay advisory reference, and `benchmarks/formation-adherence.ts` reports their markers as a diagnostic outside the headline brief score. Engine-side liveness is separate: pending `model_request` reminders in `src/net/model/model-api.ts` re-post unanswered requests at 25%/60%/85% of the deadline (`MODEL_REQUEST_REMINDERS=0` disables).
- **Request deadlines: every budget ends in an answer** (`src/coordination/request-deadline.ts`, shared mechanism `src/agent/budget-terminal.ts`). A routed `marina:<crew>` request has a deadline: `MODEL_REQUEST_TIMEOUT_MS`, or the client's own per-item deadline in `x-marina-deadline-ms` when that is sooner. The client's deadline is reduced by a margin of 10 % (at most 15 s) so the reply arrives first.
  - **At the deadline** the request returns the crew's best draft so far instead of a 504, in this order:
    1. the lead's latest explicit draft (`{"type":"model_draft","id":…,"content":…}` on the request channel);
    2. the most-agreed explicit member draft;
    3. the lead's latest model text under the request's trace;
    4. the most-agreed member text under that trace.
  - The reply carries `x-marina-budget-forced: deadline`. The `completed` lifecycle event carries `routeReason …+budget-forced:deadline` and a `detail` naming the source.
  - A crew with no draft at all still times out with 504.
  - **Fail fast:** two non-retryable upstream refusals of the lead's model while it serves the request (400/401/402/403/404/405/410/413/415/422; never 408/409/425/429 or 5xx) end the wait at once. The draft so far is returned with `budget-forced: upstream_error`, else a 502.
  - The 85 % reminder names the time left and the draft post.

**A crew serves its own name.** `CrewManager.syncEndpoint` creates the crew's `model-<name>` channel when the crew is created and keeps its agent members on it: on join, leave, dispatch, boot and when a member's entity (re)appears; a member who leaves, and every member at dissolution, is taken off (the channel stays). People are never joined (`servesEndpoint`, the engine's `principalOf`). Code Mode crews are created with `serves: false`. `benchmark run crew:<name>` therefore resolves for any crew with an online agent member and records its formation; with none online, or no such crew, the refusal names the step. No model provider is needed for any of it.

**Dispatches are tasks; tasks carry the formation.** `crew dispatch` creates a value-0 task (or binds `task:<id>`) and records the binding in core memory (`bindTaskToCrew`, owner `work:approach`, key `crew-task:<id>`). At claim, `noteTaskApproach` takes the bound crew's formation first, then the claimant's live crews, else `solo`; `taskApproach` reads the same order after the fact. Code Mode verification adds `crew:<formation>` while the session's dispatched `code crew` is live. A benchmark run on a crew target is always `method:crew:<formation>` (`crew:unknown` without a recorded formation), never a model id; an upstream model named in its target goes in a separate `method:model:<id>` ref.

**Serving crews and request protocols.** A `marina:<crew>` model request is routed to the `model-<crew>` channel and never passes through a `[crew-task]` dispatch, so two rules in `src/net/model-api/routing.ts` (`servingCrewPlan`) carry the crew's formation to each request:

- **Outward face.** When a non-dissolved crew named `<crew>` serves the channel, requests go only to its `lead`/`answerer` members that are online. A specialist that joined the endpoint channel on its own no longer takes requests meant for the lead. With no outward member online, every online member stays eligible.
- **One claimant per request** (`src/net/model-api/request-claim.ts`; the receiving rule is `endpointDispatchDrop` in `src/agent/attention.ts`). Each `model_request` is addressed (`target`) to one eligible member, and only that member owes it. The other members drop it as `addressed-elsewhere`, and drop a peer's `model_response` as `answered-elsewhere`, so neither wakes them. Before this rule every Answerer of the 4-Answerer showcase crew treated every request as owed. Under 4-way load that made 4× the work, filled each reply ledger (32), and left obligations unsettled until their 30-minute TTL. The claim is a lease (`MARINA_REQUEST_CLAIM_LEASE_MS`, default 120 s) that the holder's traced work renews. When it lapses, the request is re-offered to another eligible member (untried first, fewest in flight), and the old holder releases it from its ledger. Reminders follow the current holder. Pinned requests and a lone member are never re-offered. Deliberate fan-out stays explicit: `open`/`panel` endpoint modes post one request per member, each addressed to that member, and consults are awaited `tell`s.
- **Protocol line.** For `verification`, `deliberation`, `tournament` and `delphi`, the `model_request` payload carries a `protocol` field, placed before `content` so the perception clamp never cuts it (`requestProtocolLine` in `crew-formations.ts`). It names up to `CONSULTS_PER_REQUEST` (2) online specialists, chosen by configured role (`CONSULT_ROLE_ASPECTS`: skeptic, mathematician, scholar, historian) in the formation's order, preferring a model vendor different from the responder's and from each other (`pickConsultants`). Each consult is an awaited `marina_tell` bounded by `CONSULT_TIMEOUT_MS` (30 s, lower when the request deadline is short); a timeout means proceed, so a silent specialist never holds the reply. Specialists need not be crew members. The Answerer's goal puts a present `protocol` ahead of its answer-directly default. Consults inside a traced turn carry the request's trace links, so benchmark attribution credits the consulted specialists.

See also: `docs/guides/coordination.md`, `docs/guides/emergent-organization.md`.

Optional `task work` (`src/coordination/task-work.ts`) adds revisioned field patches,
source-version citations, collaborator proposals and deterministic advisory checks
to existing tasks. It has no agent-loop hooks or automatic review/approval behavior.
The existing task creator/current claimants own draft edits; other readers can
contribute proposals and evidence. Sources are resolved under the reader's current
ACL before views or receipt reuse. Scalar citations store reference/version/quotation
offsets; explicit artifact `source` edits publish selected content to task readers.
Source edits can atomically retain evidence-coverage requirements. Scoped array
replacements can opt into following context changes, preserving earlier batches;
unknown contexts remain unverified. Edits, handoff views and submission responses
return advisory gaps without creating an approval condition. Typed review packets
omit draft values. Optional set questions select their criterion and candidate
universe from current readable sources, require cited inclusion/exclusion for
every candidate, and compare unique sets independently of ordering; uncertainty
stays unverified. Only explicit `artifact-review-fresh` requests call a model in
a new context, reusing unchanged receipts and rejecting changes during inference.
A receipt binds the reader, revision, task criteria,
source state and check implementation, expires after one hour and can be refreshed
explicitly. Migration 185 adds `task_work_revisions` and `task_work_checks`; the
former preserves revision history, the latter is recomputable. Account erasure is
an explicit exception to author-metadata immutability. See [shared task work](../guides/shared-task-work.md)
for the command contract and the limits of declared checks.

## Orchestration on the outcome path

Three orchestration surfaces record what they settle as ONE outcome each, through `recordResolved`
(`src/outcomes/orchestration.ts`), tagged in the `family:` / `method:` / `scope:` convention of
`src/outcomes/work-refs.ts`, so the competence map can compare ways of working. Labels and ids
only: never the task, goal, a person's evidence text or any output. None needs a model, and a
surface with no verdict records nothing.

| Surface | When | Outcome | Tags |
| --- | --- | --- | --- |
| `project <name> outcome <0..1> \| …` | a PERSON records it (an agent's report on its own project is not a verdict) | kind `task`, subject `project:<id>` (settled once), `mechanical`, metric `person-verdict`, succeeded at ≥ 0.5, quality = the score | `family:work:project`, `method:orchestration:<pattern>`, the recorder's scope |
| `pattern run` / `POST /v1/patterns/run` | the run's OWN review step returned `approve` or `revise` (today only `verification` reviews) | kind `request`, subject `judged:pattern:<run>`, `judged` by `pattern-review:<checker>` (a model's opinion: evidence for earned-judge readers, never a lesson on its own) | `family:work:request`, `method:pattern:<name>`, `method:model:<m>` when one model did the work, the caller's scope (`scope:unscoped` for an unbound API key) |
| room formation (`build formation`) | a round closes on its own closing move with a mechanical result | kind `request`, subject `room-formation:<room>:<ref>`, `mechanical`, metric `aspect-checks`, succeeded when no check failed, quality = share passed | `family:work:request`, `method:room-formation:<formation>`, the drafter's scope |

A pick between answers, a budget stop or an unreadable review is not a verdict. Of the room
formations only `verification` defines a mechanical result: each checker's first message in the
grammar the mediator asks for, `aspect: <aspect> pass|fail — <reason>`, is read once as a label
(`aspectCheck`, never stored as text; the `say_sent` event stays content-free) and the round's
tally is recorded when the drafter closes it. A `debate` ruling is free text naming a winner, not
whether the method worked, and a `chorus` merge has no verdict, so neither records anything.

## Executable Scores

`src/sdk/score-executor.ts` snapshots a validated Score and dispatches ready steps with
bounded concurrency (default 4). A successor can start as soon as its own dependencies finish;
it does not wait for unrelated branches. `DispatchContext.signal` carries cancellation to the
worker transport. Failure, caller cancellation or an optional overall deadline stops admission
and signals active dispatches. A dispatcher that ignores cancellation may still have external
side effects; late results are discarded and the executor never retries them automatically.

`runScore` and `MarinaAgent.conduct` accept `signal`, `concurrency` and `runTimeoutMs`, alongside
the per-step reply timeout. Use `strictCorrelation: true` for machine workflows whose workers echo reply tags.
Existing Score and `tellAndAwait` defaults remain compatible with untagged human/legacy replies.
`marina_conduct` forwards its tool cancellation signal and accepts a concurrency limit.
Cancelling a tell waiter does not retract a delivered message or forcibly stop a remote
agent; a dispatcher with execution control must propagate the signal to that runtime.

Coding attempts use the existing task and coding-artifact stores (`src/coding/task-run.ts`).
The command-ingress async context retains the attempt ID across long-running checks, preventing
late results from being attached to a newer attempt. Migration 126 adds lookup indexes and
unique active-attempt constraints per session and durable worker. Submission and task approval
are distinct. See [the coding guide](../guides/coding.md) for the complete operator flow.

## The formation catalogue: one formation, one template

A formation used to be implemented once per surface: pool-note templates, crew briefs, the arena's
numeric protocols, the typed forecast formations and the free-text patterns. They shared names,
not code. `src/orchestration/formations/` is now the one catalogue, with the Score executor as the
one runtime.

- **Entries** (`catalogue.ts`, `FORMATIONS`). There is one entry per formation: the 16 orchestration
  patterns, `freeform`, `ensemble` and `skeptic`. Each entry has:
  - `summary`: the one-line description (`PATTERN_FIT.why` reads it);
  - `title`, `roles`, `protocol`, `fit`: the display name, the parts members play, the protocol in
    surface-neutral steps and the task shapes it fits;
  - `crew`: whether the crew brief and the project template of that name exist;
  - `room`: whether a room runs it as its turn rule;
  - `markers`: protocol phrases that brief and template must both keep;
  - `crewOnly`: why the formation needs a crew over time (`CREW_ONLY_PATTERNS` is derived from it);
  - its Score templates: `typed`, `text` and `numeric`.
- **Templates** (`template.ts`). A template declares its steps, which step fans out K times
  (`k`, `chain`, or a knockout `bracket` scheduled match-by-match or round-by-round), which step reads
  which, and an abstract slot per step: `forecaster`, `referee`, `skeptic`, `member`, `peer`,
  `checker` or `pipeline`. `formationScore` resolves the slots to assignees (`model:<id>`, `role:<r>`,
  `marina:<crew>`, or the in-process pipeline) and returns an ordinary Score. A surface whose members
  can drop out runs the template's `entrants` step first, then the rest over the entrants that
  answered (`afterEntrants`).
- **Combiners** (`combine-typed.ts`, `combine-numeric.ts`). Combiners are pure code for each answer
  type: Delphi medians, the tournament champion and the skeptic's shrink toward the prior (typed);
  the median move, settle clamps and anonymous Delphi summary (numeric); the checker's pick for free
  text.
- **Running** (`run.ts`). `runFormationScore` admits every ready step at once, so the access graph is
  the schedule. `seeded` supplies steps that are already done. `StageGates` checks a surface's budget
  once per stage.

Where each surface stands:

| Surface | Runs from the catalogue | Notes |
|---|---|---|
| Typed forecasts (`src/forecast/formations.ts`, `skeptic.ts`) | ensemble, delphi, tournament, skeptic | Round one is the typed pipeline (the template's `research` + `f1…fK`). The rest runs as the template's Score, each member step going to that run's own part. |
| Resident forecasts (`src/forecast/resident-forecast.ts`) | all four | Each forecaster slot is `role:`, `marina:` or `model:` (`assigneePart`). The referee and the skeptic are the pipeline's critic. The ensemble and delphi Scores are the catalogue's templates. |
| Free-text patterns (`text-patterns.ts`: `pattern run`, `/v1/patterns/run`) | all eight | Members are the operator's models. Crew-only patterns are refused, and the catalogue gives the reason. |
| Arena (`src/arena/formations.ts`) | ensemble, delphi | The other ten arena formations run their own protocols on the shared clamps. Moving them is a follow-up; until then they are held byte-identical to their own pre-catalogue code. |
| Crews (`crew-formations.ts`, project templates) | none (crew protocols) | `crewFormationEntry` names each brief's entry, and `ORCHESTRATION_TEMPLATES` maps every template by name. |

The catalogue is held by behaviour, not by frozen bytes. Its prompts and answers may change; a
change meant to improve answers is measured (benchmarks, resolved outcomes), not pinned. The tests
assert what a formation must do:

- `test/formation-behaviour.test.ts`: every typed formation × answer type is deterministic given the
  same replies, well-formed with failed and junk replies, and researches before any analyst is
  asked; delphi revises only after every first answer and never shows names; a tournament plays
  n − 1 refereed matches; the skeptic is asked once, after the proposals; the combiners' math
  (delphi medians, the referee's pick, the skeptic's trust, blowup bound, sd floor and
  informative-prior rule); the catalogue's arena formations cap the move and drop blowups on the
  stored rounds (`test/fixtures/formations/arena-rounds.json`).
- `test/formation-catalogue.test.ts`: a brief, a template, `PATTERN_FIT`, `TEXT_PATTERNS`,
  `CREW_ONLY_PATTERNS`, the typed list or the arena list drifting from the catalogue; templates that
  stop instantiating to valid Scores; the resident Scores' shape; `model:` and `role:` slots giving
  the plain formation's answer.
- Per-protocol examples: `test/forecast-formations.test.ts`, `test/patterns-run.test.ts`,
  `test/arena-formations.test.ts`.

The ten arena formations still on their own code are the one frozen comparison:
`test/arena-formations-legacy.test.ts` holds them byte-identical to
`test/fixtures/arena-formations-legacy.ts` until they move to the catalogue. Never edit that fixture
to make the test pass.

Follow-ups:

- Move the remaining arena formations (deliberation, debate, chorus, pipeline, mapreduce, blackboard,
  symbiosis, research, tournament, verification) and the profile rounds (`formation-profile.ts`).
- Let the arena crew forecaster (`src/arena/crew.ts`) reuse the skeptic entry.
- Allow a resident referee or skeptic slot.

## Budget terminal: every budget ends in an answer

`src/agent/budget-terminal.ts` is the one mechanism for loops with a turn, step or time budget.
- Steer from 75 % (`budgetSteerAt`, also the lean agent's run-cap warning). At the cap, block tools and ask for the answer from what the loop has.
- Label a forced answer `BudgetForced`: in traces, in run records, and as `budget_forced` on ledger items (migration 157). Never pass it off as a free answer.
  - Code Mode (`code do budget:`, which `marina -p` always sends): a submission past the final-answer point is labelled `budgetForced` in the `task_run` metadata, the terminal lifecycle event and `-p --json`. The SWE-bench adapter reads it from the session database into `budget_forced` on the ledger item (`sessionBudgetForced`, `benchmarks/swebench/adapter.ts`).
- The users are the lean agent's run cap (owed `model_response`), the benchmark tool loop (`--final-answer`), crew request deadlines (`src/coordination/request-deadline.ts`: best draft at `x-marina-deadline-ms`, fail fast on non-retryable 4xx) and typed forecasts (`budgetMs`). Reuse it rather than adding another loop-local cap. → docs/architecture/orchestration.md
- A Code Mode attempt has two budgets that end it this way. The time budget (`code do budget:<duration>`) steers the coder and then asks it for the final submission. A spend stop is different: money ran out, so nothing can ask a model. Spend stops are an upstream spend refusal (`isSpendRefusal`) or Marina's daily/scope cap, but not a rolling-hour cap, which lifts on its own. The worker's runtime emits `SPEND_STOP_EVENT_CONTEXT` once per task; it never comes from a tool. The attempt observer (`endCodingRunForSpend`, `src/engine/commands/code/task-run.ts`) ends the attempt with no model call:
  - If the attempt changed the workspace, the observer submits it. A change means writes, edits or applied patches recorded for this attempt, or a command followed by workspace paths that differ from HEAD, untracked files included (`changedPaths`, `.gitignore` respected). The summary is assembled from the attempt's record. The submission carries the label `budgetForced` `{reason:"spend"}` and whatever verification is recorded. It is never reported as verified unless its checks passed.
  - The submission verifier is not asked. Its opinion is `none`, like an outage, never a pass.
  - If nothing changed, the attempt ends `Blocked: BudgetForced: …` (`kind:impossible`) with the same label.

## The Arbiter: adjudication only where answers disagree

Always-on verification asks a reviewer, often the same model, to check every answer, and such a
reviewer can overrule correct answers too easily. The Arbiter (`src/orchestration/arbiter.ts`) is
one general replacement for that pattern, shared by every surface: it adjudicates only where
answers already disagree.

- **Disagreement detection is free.** `detectDisagreement` reads signals the pipeline already has:
  - agreement among independent runs, by answer type: choice and text by folded text, numbers
    within a relative tolerance, multi-select as a set, rankings in order;
  - a reviewer's dissent: a verifier's correction, a critic's revision, a checker's flag;
  - the spread of judge scores.

  Only contested items reach the Arbiter, and at most `MARINA_ARBITER_CAP` of them, most contested
  first (`selectForArbiter` for a batch, `ArbiterQuota` per UTC day for a server).
- **The contract.** The Arbiter writes ONE JSON verdict: `keep`, `overrule` (with the answer it
  overrules to) or `abstain`. It must cite every answer item (each element of a list answer) with a
  source and a verbatim quote, score `source_quality` and `reasoning_quality` separately, and give
  a `confidence`. Abstaining is encouraged, and keeps the majority answer.
- **The overrule bar** (`applyOverruleBar`). To overrule a majority of agreeing runs, the Arbiter
  needs all three of:
  - grounded citations: the quote is found in the evidence, and the source is a known source or
    appears in it;
  - at least `MARINA_ARBITER_MIN_DOMAINS` (2) independent registrable domains (`sourceKey`:
    `en.` and `de.wikipedia.org` are one domain, a corpus document id is its own key);
  - confidence of at least `MARINA_ARBITER_MIN_CONFIDENCE` (0.7).

  With no majority, the domain floor is 1. A verdict that falls short is downgraded: to `abstain`
  when confidence is short, otherwise to `keep`. The record says why. Residents can check the bar
  for free with `arbiter check`.
- **Earned trust.** Each overrule that clears the bar is scored when its question resolves. Observed
  overrules count too, so `observe` builds the record before the Arbiter is allowed to act. In
  forecasts the record lives in the forecast history (`ResolvedRecord.arbiter`), as booleans and the
  Arbiter's model name. `arbiterTrackRecord` measures precision per evaluator. Under
  `MARINA_ARBITER_UNEARNED=observe`, an Arbiter acts only after `MARINA_ARBITER_EARN_MIN_RESOLVED`
  resolved overrules at precision of at least `MARINA_ARBITER_EARN_MIN_PRECISION`. Under `strict`
  (the default), the bar alone decides.
- **Surfaces.**
  - Typed forecasts: `MARINA_FORECAST_ARBITER=off|observe|on|replace`, or formation `arbiter`
    (`src/forecast/arbiter.ts`). Contested is judged on the runs' drafts. `on` makes the verifier
    and critic advisory; `replace` also drops the per-run verifier.
  - `marina/verify:`: `MARINA_VERIFY_ARBITER`, or the `x-marina-arbiter` header. A checker's flag
    on a final answer becomes a dissent, adjudicated from the tool results. Tool-call drafts, which
    are where verification helps τ² airline, are unchanged.
  - The world: the `arbiter` role and `adjudication` trait (seeded with the other roles), invited
    like any specialist, plus the read-only `arbiter contested|check|policy` command.
- **Replay.** `bun benchmarks/transfer/arbiter-replay.ts` reads stored per-item results with no model
  calls: BrowseComp-Plus replicate dirs, ledger runs (`answer_hash`, `correct`) and typed-forecast
  answers. It counts how many items would reach the Arbiter, and how often the always-on verifier
  overruled a correct majority or fixed a wrong one.

`off` everywhere is byte-identical: no call, no field, the same prompts (`test/forecast-arbiter.test.ts`,
`test/arbiter-verify.test.ts`). The core is pure and tested in `test/arbiter.test.ts`.

Task-work handoff rendering (`task-artifact-handoff.ts`) is a read-only Markdown
projection of the exact authored JSON at a named revision. It does not synthesize
current-state prose or validate source currency. The optional client publication
helper replaces only a named snapshot section using artifact revision/hash and
journal version/hash guards; outside history is preserved, malformed/nested
sections are refused, and equal bytes cause no write. Snapshots remain explicitly
historical when newer revisions appear. No scheduler, completion or approval
path calls this helper automatically.

The optional `artifact-evidence` plan maps a readable source contract's full
requirement list to artifact entries and caller-selected fact quotations. Checks
inspect every selected citation, including extras, and complete per-entry fact
bundles. Source versions are bound at declaration and stored internally; changed
sources require explicit renewal. Public views and report fingerprints exclude
expected private versions. Each read rechecks source access. Advisory feedback
does not establish entailment, trigger a model, edit values or gate completion.

Optional `prose-review` and `prose-review-fresh` inspect explicitly supplied actual handoff
text (`task-prose-review.ts`, `task-prose-model-review.ts`). They use a separate candidate-
aware packet; the existing answer-free artifact reviewer retains its independent packet
contract. Prose receipts bind text bytes, task requirements, native revision, requesting
reader and accessible source versions. Source/task/work changes across the model await
invalidate the result; simultaneous identical calls share inference and current receipts
expire normally. Exact target/source quotation checks are provenance checks, not semantic
certification. Missing source access cannot yield a verified result. The optional
`task-prose-file.ts` adapter rechecks a caller-owned file version/hash before and after
review without reading server host paths or writing files. Neither review changes task
submission, scheduler behavior, agent prompts, peer wakes or approval.

`prose-audit` applies the evidence plan's requirements, bundles and bound selections to
prose (`auditProseEvidence`, sharing the artifact audit's source loading): a fact is
supported when the prose quotes its selection verbatim, so "supported" means one thing
for JSON and for sentences. `journal` entries (`WorkJournalEntry`, append-only in the
work document) are the task's own record; `prose-audit {journal:true}` audits them and
the prose review packet carries them.

An evidence-plan quotation from an unlisted or ambiguous original is unverified. It is
not labeled false merely because the author's plan lacks that readable original. An
actual mismatch against a selected readable original remains a discrepancy.
