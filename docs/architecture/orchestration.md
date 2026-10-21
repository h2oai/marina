# Orchestration Patterns, Crew Pools, and the Crew Runtime Layer

**When to read this:** you are adding or changing an orchestration pattern template, a formation in the catalogue (`src/orchestration/formations/`), crew pool access, crew formation briefs, or the formation mediators. `CLAUDE.md` → "Orchestration Patterns" states the invariants (convention-based, members-only crew pools, one mediator line per event); this page has the full pattern list and mechanics.

## Patterns
- All patterns are convention-based pool notes discovered via `recall`, not engine constraints
- Activated via `project <name> orchestrate <pattern>`
- Patterns: Deliberation (flat peer propose/evaluate/execute/debrief with lesson artifact; formerly "NSED" — legacy name accepted, never advertised), Chorus (parallel phases + broadcast wall + crossfire review), Foundry (Overseer/Patrol/Gate hierarchy + merge-queue invariant), Swarm (self-organizing handoffs with payload), Pipeline (sequential stages + contract per stage), Debate (sealed positions + adversarial argumentation), MapReduce (parallel decomposition with independence invariant), Blackboard (shared workspace + no-private-state invariant), Symbiosis (mutual epistemic benefit + entropy-driven mode shifts), Research (iterative experimentation), Delphi (private estimates sent to a facilitator → anonymized summary of range/median/reasons → one or two revisions; dissent kept and linked `contradicts`, fast convergence treated as a warning sign), Tournament (independent candidates → pairwise bracket judged by non-authors → recorded rulings → losers' best ideas grafted into the winner), Verification (candidates → one verifier per aspect: correctness, requirements, evidence, safety; checkable claims are run, failed aspects become rework tasks), Auction (lots posted on the board → bids state fit + expected cost → award to best fit per cost → fit-check note after approval), Ledger (orchestrator keeps a task ledger and a progress ledger as pool notes; an expired lease is the stall signal, repeated stalls trigger a replan), Sharding (an oracle — tests, reference implementation or checker — turns a failing target into claimable shard tasks; fixers never edit the oracle, the oracle decides done)
- Templates in `src/world/templates/orchestration.ts` — 5 detailed notes per pattern (project-pool conventions) + `PATTERN_FIT` (shape recognition); `project <name> recommend` ranks fitting patterns by this world's own recorded outcomes (no static scores)
- Shapes (`TaskShape`): `decomposable`, `contested`, `parallel`, `sequential`, `hierarchical`, `shared-artifact`, `open-ended`, `verifiable` (a mechanical check decides: failing tests, a test suite, a reference implementation, verification). `detectTaskShapes` keyword-matches a goal; `suggestPatterns` ranks patterns by shape overlap
- Every command a template note quotes must exist with that syntax — `test/orchestration-patterns.test.ts` runs the knowledge-hygiene auditor over every template

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

**Serving crews and request protocols.** A `marina:<crew>` model request is routed to the `model-<crew>` channel and never passes through a `[crew-task]` dispatch, so two rules in `src/net/model-api/routing.ts` (`servingCrewPlan`) carry the crew's formation to each request:

- **Outward face.** When a non-dissolved crew named `<crew>` serves the channel, requests go only to its `lead`/`answerer` members that are online. A specialist that joined the endpoint channel on its own no longer takes requests meant for the lead. With no outward member online, every online member stays eligible.
- **Protocol line.** For `verification`, `deliberation`, `tournament` and `delphi`, the `model_request` payload carries a `protocol` field, placed before `content` so the perception clamp never cuts it (`requestProtocolLine` in `crew-formations.ts`). It names up to `CONSULTS_PER_REQUEST` (2) online specialists, chosen by configured role (`CONSULT_ROLE_ASPECTS`: skeptic, mathematician, scholar, historian) in the formation's order, preferring a model vendor different from the responder's and from each other (`pickConsultants`). Each consult is an awaited `marina_tell` bounded by `CONSULT_TIMEOUT_MS` (30 s, lower when the request deadline is short); a timeout means proceed, so a silent specialist never holds the reply. Specialists need not be crew members. The Answerer's goal puts a present `protocol` ahead of its answer-directly default. Consults inside a traced turn carry the request's trace links, so benchmark attribution credits the consulted specialists.

See also: `docs/guides/coordination.md`, `docs/guides/emergent-organization.md`.

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
  patterns plus `ensemble` and `skeptic`. Each entry has:
  - `summary`: the one-line description (`PATTERN_FIT.why` reads it);
  - `crew`: whether the crew brief and the project template of that name exist;
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
| Resident forecasts (`src/forecast/resident-forecast.ts`) | all four | Each forecaster slot is `role:`, `marina:` or `model:` (`assigneePart`). The referee and the skeptic are the pipeline's critic. The ensemble and delphi Scores are byte-identical to the pre-catalogue ones. |
| Free-text patterns (`text-patterns.ts`: `pattern run`, `/v1/patterns/run`) | all eight | Members are the operator's models. Crew-only patterns are refused, and the catalogue gives the reason. |
| Arena (`src/arena/formations.ts`) | ensemble, delphi | The other ten arena formations run their own protocols on the shared clamps. Moving them is a follow-up, held byte-identical meanwhile. |
| Crews (`crew-formations.ts`, project templates) | none (crew protocols) | `crewFormationEntry` names each brief's entry, and `ORCHESTRATION_TEMPLATES` maps every template by name. |

Equivalence is enforced, not assumed. The pre-catalogue implementations are frozen in
`test/fixtures/formations-legacy/`. Given the same model replies, the catalogue reproduces them
exactly, compared as JSON with key order and as the ordered list of every prompt:

- `test/formation-equivalence-typed.test.ts`: 4 formations × 7 answer types, with failures and junk
  replies.
- `test/formation-equivalence-text.test.ts`: 8 patterns × member counts × budgets × aborts.
- `test/formation-equivalence-arena.test.ts`: all 12 arena formations on the stored rounds
  (`test/fixtures/formations/arena-rounds.json`), with out-of-order replies.

`test/formation-catalogue.test.ts` fails when a brief, a template, `PATTERN_FIT`, `TEXT_PATTERNS`,
`CREW_ONLY_PATTERNS`, the typed list or the arena list drifts from the catalogue. Never edit a frozen
fixture to make a test pass.

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
