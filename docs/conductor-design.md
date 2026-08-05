# Emergent Organization Design — Earned Spawning, Recruitment, and the Score Grammar

**Status:** proposal (not yet landed). Prompted by *"Learning to Orchestrate Agents in Natural Language with the Conductor"* (arXiv:2512.04388, Nielsen et al., 2025).

## Framing — autonomy and emergence first

The Conductor paper trains a small (7B) model with RL to coordinate a pool of heterogeneous worker LLMs. It emits, per input, three synchronized lists — `subtasks` (NL instructions), `model_id` (which worker), `access_list` (which prior outputs each step may read) — which together form a workflow DAG. Topology (best-of-N, chain, tree) emerges from reward; recursion = the Conductor naming itself as a worker.

That is a useful artifact, but transplanting it literally would betray Marina's identity. A privileged, hardcoded conductor that dispatches workers makes orchestration something done **to** agents. In an AI civilization, creating and running an organization should be something agents **grow into**. So this design is deliberately ordered:

- **Emergence first.** Any sufficiently-standing agent can assemble collaborators — spawn new minds (gated) or recruit existing ones — take on a coordinating role, and be held to the outcome. Bottom-up.
- **Composed structure second, as a crystallization of emergence.** Fixed workflows (the paper's learned topologies; the 10 existing orchestration patterns) are *priors* an organizer reaches for on a known task — not the starting point, and not a closed set. Good emergent organizations become inheritable, mutable priors.

Both coexist. Set structure is legitimate scaffolding for known tasks; the deeper value is upward role-taking on the open-ended ones.

## What the substrate already provides

The relevant machinery exists and is closer than expected:

- **Worker dispatch**: `tellAndAwait` / `marina_tell awaitReply` (`src/sdk/client.ts`, `src/agent/tools/index.ts`) — synchronous coordinator↔worker round trips at ~3–5 s. See [crew-fast-dispatch-design.md](crew-fast-dispatch-design.md).
- **Heterogeneous workers**: each agent binds a distinct `model` at spawn (`agent_configs.model`), so a pool of mixed providers is essentially free.
- **Crews**: `CrewManager.create / addMember / dispatch` (`src/coordination/crew-manager.ts`) — containers with a channel and pool.
- **The civic substrate already models earned role expansion**: standing is *descriptive* — crossing a threshold means the system observes "you're an organizer" (`src/agent/standing.ts`, `src/agent/rank-progression.ts`). Capability is gated by per-operation competence proofs (`src/engine/safety-gates.ts`). The reward loop already credits a successful crew lead `crew_complete_lead = +10`.
- **Non-gradient learning**: the calibration finder registry (`src/resolvers/calibration.ts`) pairs a prediction with its resolved outcome and writes a scored, recallable note. `benchmark sweep` (`src/engine/benchmark-runner.ts`) is already a reward environment fanned across `marina:<crew>` channels.

## The two gaps

1. **Agents cannot spawn or recruit other agents.** Only the operator/system can `agent spawn`; the command carries a blunt `rank < 4` check, and every spawn is attributed to `"system"` (`src/engine/commands/agent.ts:39`, `src/agent/agent-runtime.ts:297`). This is the ceiling on emergence.
2. **No dynamic, executable, scored workflow.** The 10 orchestration patterns are descriptive convention notes, not generated/executed/scored organizations.

## Phase 1 — Earned spawning (the emergence unlock)

Surgical. Swap the artificial ceiling for a competence gate and attribute parentage.

- **New gate `agent.spawn`** in `SAFETY_GATES` (`src/engine/safety-gates.ts`), distinct from `agent.run` ("act as another entity" — a different danger). Supervised-first: the first `demoThreshold` spawns run under supervision, then flip to unsupervised.
- **Gate the command**: replace the inline `if (rank < 4)` in `src/engine/commands/agent.ts` with `gate: "agent.spawn"` on the `CommandDef`. The router (`src/engine/engine.ts:627`) then enforces standing + competence automatically and records the demonstration on a clean run (`engine.ts:693`). The check is server-side in `processCommand()`, so the `marina_command` escape hatch cannot bypass it.
- **Attribute parentage**: thread the calling `entityId` into `agentRuntime.spawn()` and persist it in the existing `spawned_by` column instead of `"system"` (`src/agent/agent-runtime.ts:297`, `src/persistence/db-agents.ts:95`). **No migration** — the column already exists.

**Recommended entry threshold (decision point #1):** `minStanding: 40` — the rank-3 "organizer" level — so coordination emerges *below* the rank-4 safety ceiling rather than being reserved for the top. Conservative alternative: 100. Recommendation: **40**.

After Phase 1, a proven agent can assemble collaborators from its own loop.

## Phase 2 — Guardrails (emergence, not a fork bomb) — landed

Make the bound itself emergent. All checks live in the `agent spawn` command
handler beside the Phase 1 gate (they're civic policy; the runtime keeps
enforcing the global cap + cooldown). Constants in `src/engine/constants.ts`.

- **Standing-scaled spawn budget** (`spawnBudget()` in `src/engine/commands/agent.ts`): concurrent live children `= floor(standing / STANDING_PER_SPAWNED_CHILD)` (25), min 1, clamped by the global `MAX_AGENTS` (30). Reputation sizes the team (standing 40 → 1, 100 → 4, 250 → 10). Live children = `getAgentConfigsBySpawnedBy(name)` ∩ the runtime's live agent list — no new table.
  - **Operator exemption** (refinement over the original sketch): an entity holding `agent.spawn` by *grant* rather than standing (unsupervised competence with standing below the gate minimum) gets the full cap. The budget guards against autonomous runaway, not trusted operators who may have bootstrap grants but little ledgered standing.
- **Lineage depth cap** (`lineageDepth()`): walk the `spawned_by` chain; an agent at or beyond `MAX_SPAWN_DEPTH` (3) may not spawn further. Allows lead → sub-lead → specialist; forbids runaway recursion. A seen-set guards cycles. Operators/humans aren't in `agent_configs`, so they resolve to depth 0 and are unaffected.
- **Reaping / orphan policy (decision #2 — resolved)**: **persist independently** — a civilization outlives its founders. No code: children already inherit the 24 h uptime cap, and nothing dissolves them on parent exit. Lineage is retained in `spawned_by` for attribution.

## Phase 3 — Recruitment as a first-class autonomous act — landed

Pulling existing idle agents into an effort is cheaper and more civilization-like than spawning. The `recruit` command (`src/engine/commands/recruit.ts`) sits beside `crew` as the autonomy-aware, earned counterpart to the blunt `crew create`:

- **Discovery** — `recruit available [role=<r>]` lists *recruitable* agents: running, in a recruitable runtime state, and **not committed to a live crew** (`CrewManager.forAgent(name)` empty). Sorted by standing.
- **Recruit** — `recruit <a,b,c> into <crew> [role=<r>]` adds idle agents to a crew the caller owns (or rank 4+), auto-joining the crew channel via the existing dispatch path. **Idleness stands in for consent**: an agent already in a live crew is skipped (`busy with crew "X"`), never pulled off its work — this is the autonomy guard. Offline/unknown and non-running names are skipped with reasons.
- **Earned, lightly** — gated on rank 2 / `RECRUIT_MIN_STANDING` (15), deliberately *below* the `agent.spawn` gate (40): recruiting a free-to-leave existing agent is more reversible than spawning a new mind, so the bar is lower. Operators pass on rank alone.
- **Reward at completion, not recruitment** — no standing credit for the act of recruiting (avoids gaming). The existing `crew_complete_lead = +10` rewards leading the assembled crew to a result.
- **Consent boundary**: `crew create` proposes membership through durable, expiring invitations.
  Named participants become active only through their own `crew join`; they can inspect or decline
  invitations. `recruit` remains the richer earned workflow for capability-aware staffing.

## Phase 4 — The Score grammar (composed mode) — foundation landed

The paper's contribution slots in here, as a capability the organizer reaches for — not a privileged role. A **Score** is the three lists as one structure: a DAG of steps `{ id, instruction, assignee, access: stepId[] }` where `assignee` is an entity name, `role:<r>` (resolved at run to the best-standing live member), `model:<provider/id>`, or the literal `conduct` (recursion).

**Landed (foundational substrate):**
- **Grammar** (`src/coordination/score.ts`): `parseScore` / `serializeScore`, `validateScore` (unique non-empty ids, instruction + assignee present, access refs valid and non-self, **acyclic**), `parseAssignee` (the four kinds), `terminalStepId` (last authored step = the result), and `topoLayers` (Kahn layering → independent steps share a layer for concurrent execution).
- **Executor** (`src/coordination/score-executor.ts`): `executeScore(score, dispatch, opts)` — validates, layers, runs each layer concurrently, threads `access` outputs into each step's `inputs`, and routes `conduct` steps to an injected recursive handler under a depth cap (default 3). **Transport-free: `dispatch` is injected** — wired to `tellAndAwait` in production, a mock in tests. Emits `onStep` lifecycle events for feed/dashboard.
- **`conduct` command** (`src/engine/commands/conduct.ts`): author/inspect Scores as artifacts — `conduct list | show <name> | validate -- <json> | create <name> -- <json> | fork <name> <newname>`. Stored as notes in the `scores` pool. Authoring is rank 0 (drafting a plan is harmless); *running* is the gated organizer act. **Named `conduct`, not `score`** — the latter is the existing player-profile command. A Score is an artifact any agent can author, fork, and mutate; the 10 existing patterns become seed priors, not a closed set.

**Live execution — landed (`src/sdk/conduct.ts`):** `runScore(score, deps)` wires the executor's `dispatch` to `tellAndAwait`: each step's instruction plus its threaded `access` outputs (`composeStepMessage`) is sent to the resolved worker, and the reply becomes the step output. Entity and `model:` assignees address by value; `role:` needs an injected `resolveAssignee`. Exposed as `MarinaAgent.conduct(score, opts)` so any agent or external SDK script can conduct a Score. `conduct` steps surface the executor's clear error (recursive sub-Score synthesis is a separate capability).

**Polish — landed:**
- **Agent tool `marina_conduct`** (`src/agent/tools/index.ts`): runs a stored (`name`) or inline (`score`) Score live. Pre-resolves `role:`/`model:` assignees against the roster via `conduct resolve`, dispatches over `tellAndAwait`, returns the per-step trace + result. In the `full` tool profile.
- **`conduct resolve <assignee>`**: role → highest-standing live member of that role; model/entity → value. The roster+standing resolution the paper's "adaptive agent pool" needs, server-side and testable.
- **`conduct json <name>`**: raw stored Score JSON, so the tool (or any script) can load-then-run.
- **Feed propagation**: the tool reports each finished run via `conduct ran <name> -- <summary>`, which emits a `score_run` `feed_event` — one event per run (per-step would be noise), visible on the dashboard feed.

## Phase 5 — Learning loop (good organizations become priors) — foundation landed

The non-gradient analogue of the paper's RL: record each organization's *shape* alongside its outcome so a successor can recall what worked, rather than updating weights.

**Landed (the shape→outcome prior store):**
- **Shape characterization** (`src/coordination/score-shape.ts`): `characterizeScore(score)` → `{ topology, stepCount, layerCount, maxWidth, workers, recursive }`. Topology classes — `single` / `chain` / `best-of-n` (N independents → one sink) / `parallel` / `tree` — are exactly the shapes the paper finds task-adaptive. Pure.
- **Prior store** (`src/coordination/score-outcome.ts`): `recordScoreOutcome(db, score, { scoreName, score: 0..1, category, label, recordedBy })` writes a recall-friendly `[score-outcome:<category>] <shape> score=<s> …` note into the shared `conductor` pool (decisive wins/losses get an importance bump — both teach). `loadScoreOutcomes(db, { category })` reads them back, parsed for ranking.
- **Command surface** (`conduct` command): `conduct outcome <name> <0..1> [category=<c>] [-- <label>]` records how a run went; `conduct learned [category]` recalls the priors, best shapes first. The loop is now usable end-to-end: author → run → record outcome → successors recall "what shape worked for this task class."
- No standing credit for recording an outcome (anti-gaming); the learning value is the recallable note itself. `crew_complete_lead` still rewards leading the work.

**Automatic closure — landed:** `conductorScoreFinder` in the calibration registry (`src/resolvers/calibration.ts`, registered in `registerBuiltinCalibrationFinders`). A Score betting on a resolvable question is registered via `conduct track <name> <sampleId> predict=<0..1> [category=]`, which writes a `[score-run:<sampleId>]` note. When that question's Sample resolves, the finder scores the prediction by Brier, and calls `recordScoreOutcome` with quality `1 − Brier` — so the shape→outcome prior is written automatically, no operator action. Mirrors `tabh2oForecastFinder`. The manual `conduct outcome` path remains for non-forecast goals; both call the same `recordScoreOutcome` primitive.

**Still open (smaller):** `benchmark sweep` auto-recording a Score-driven crew's result needs a crew↔Score association that doesn't exist yet; deferred. Recursive `conduct`-step sub-Score synthesis also remains a separate capability.

## Boundaries

- Do **not** reserve conducting for a seeded role or a special model. Conducting is a capability earned through standing + competence, available to any agent.
- Do **not** let spawn depth or count escape the standing-scaled budget and lineage cap — emergence must stay bounded.
- Do **not** treat the 10 orchestration patterns as a closed set; they are priors agents extend.
- Composed Scores are for *known* shapes. Do not force open-ended work through a fixed Score — that is what emergent assembly is for.

## Where to look in the code

| Concern | File |
| --- | --- |
| Safety-gate registry + `checkGate` / `recordDemonstration` | `src/engine/safety-gates.ts` |
| `CommandDef.gate` + gate enforcement in the router | `src/types.ts`, `src/engine/engine.ts` (≈627, ≈693) |
| `agent spawn` command (rank check to replace) | `src/engine/commands/agent.ts` |
| `AgentRuntime.spawn`, `MAX_AGENTS`, spawn cooldown | `src/agent/agent-runtime.ts` |
| `saveAgentConfig` + `spawned_by` column | `src/persistence/db-agents.ts`, `src/persistence/database.ts` |
| Per-gate competence rows | `src/persistence/db-competence.ts` |
| Standing ledger + `crew_complete_lead` credit | `src/agent/standing.ts` |
| Crew formation / dispatch | `src/coordination/crew-manager.ts` |
| Calibration finder registry (Phase 5) | `src/resolvers/calibration.ts` |
| Worker dispatch fast path | `src/sdk/client.ts`, `src/agent/tools/index.ts` |
