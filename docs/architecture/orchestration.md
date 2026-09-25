# Orchestration Patterns, Crew Pools, and the Crew Runtime Layer

**When to read this:** you are adding or changing an orchestration pattern template, crew pool access, crew formation briefs, or the formation mediators. `CLAUDE.md` → "Orchestration Patterns" states the invariants (convention-based, members-only crew pools, one mediator line per event); this page has the full pattern list and mechanics.

## Patterns
- All patterns are convention-based pool notes discovered via `recall`, not engine constraints
- Activated via `project <name> orchestrate <pattern>`
- Patterns: Deliberation (flat peer propose/evaluate/execute/debrief with lesson artifact; formerly "NSED" — legacy name accepted, never advertised), Chorus (parallel phases + broadcast wall + crossfire review), Foundry (Overseer/Patrol/Gate hierarchy + merge-queue invariant), Swarm (self-organizing handoffs with payload), Pipeline (sequential stages + contract per stage), Debate (sealed positions + adversarial argumentation), MapReduce (parallel decomposition with independence invariant), Blackboard (shared workspace + no-private-state invariant), Symbiosis (mutual epistemic benefit + entropy-driven mode shifts), Research (iterative experimentation)
- Templates in `src/world/templates/orchestration.ts` — 5 detailed notes per pattern (project-pool conventions) + `PATTERN_FIT` (shape recognition) + `PATTERN_VALIDATION` (empirical sweep status shown by `project recommend`)

## Crew pools and the crew runtime layer
- **Crew pools are members-only** (2026-09-16): every persisted crew's `crew:<name>` pool has a group object of the same id (`memory_pools.group_id`; the existing group-pool ACL in `src/memory/access.ts` and the `gatherRetrievalContext` guard are the fence). Roster = owner ∪ current members, re-synced on create/persist, add/remove, dispatch, deposit, dissolve (final sync) and `loadFromDb` (idempotent backfill of pre-existing ungrouped pools); dissolving keeps the pool and notes (generational memory) scoped to the final roster; a successor crew reusing the name inherits and re-syncs. `crew info <dissolved>` no longer prints pool notes to non-members. Tests: `test/crew-pool-group.test.ts`.
- **Crew runtime layer** (`src/coordination/crew-formations.ts`): `CREW_BRIEFS` — compact purpose-built runtime brief per formation, posted with a protocol-priority preamble on activation/formation change (replaces concatenated pool-note prose; sweep-measured: process-heavy briefs displaced the crew's actual replies). `FORMATION_MEDIATORS` — deterministic event-driven nudges (Phase 4): crew-manager calls `onDispatch`/`onStageCompleted`/`onArtifact`, posting at most one `[formation-mediator]` line per event (pipeline handoffs, mapreduce fan-out/merge, foundry merge-gate, debate sealed-positions, deliberation one-round, blackboard no-fork). Engine-side liveness is separate: pending `model_request` reminders in `src/net/model-api.ts` re-post unanswered requests at 25%/60% of timeout (`MODEL_REQUEST_REMINDERS=0` disables).

See also: `docs/guides/coordination.md`, `docs/guides/emergent-organization.md`.

## Executable Scores

`src/coordination/score-executor.ts` snapshots a validated Score and dispatches ready steps with
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
