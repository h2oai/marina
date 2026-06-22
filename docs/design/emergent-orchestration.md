# Making Emergent Orchestration Real

Status: **design / thinking** — prompted by the concern that the paper's "coordination *emerges*; the
ten patterns are *discoverable through memory rather than configured*" claim overstates what the
system actually does today. This is the honest reckoning and the plan to make the claim true.

## The gap, stated plainly
What we *say*: coordination is not configured — it emerges from shared state; agents discover and
adopt orchestration patterns through recall.

What actually happens today:
1. The ten patterns exist as seeded convention notes (`src/world/templates/orchestration.ts`). **Real.**
2. A pattern is instantiated only when a **human/operator** runs `project <name> orchestrate <pattern>`.
   The human *chooses* the pattern. **That is configuration, not emergence.**
3. There is **no continuation-prompt section** that makes an agent *recognize* a coordination need or
   *reach for* a pattern. Patterns surface only if an agent happens to `recall` them with the right
   focus. Agents don't autonomously select, instantiate, adhere-to, amend, or evolve them.

So the truthful claim today is "**convention-based coordination: a discoverable library agents can
draw on, instantiated when directed**." The leap to *emergent* requires one missing thing: **the
cognitive moment of recognition-and-reach.**

## What "emergent" actually means (the intent)
Emergent does **not** mean "no structure ever." It means **the structure is chosen, instantiated, and
evolved by the agents in response to the work — not declared by a human up front.** A civilization
has organizational forms (committees, markets, hierarchies); what makes them emergent is that members
*reach for the right form when the work calls for it*, adapt it, and pass on what worked. That is the
bar. Marina already has the *political economy* for this (earned spawning, recruitment, standing) and
the *cultural library* (the ten patterns). It lacks the *trigger and selection loop*.

## The five moments emergence requires — and where each stands
| Moment | What it is | Status today | What's needed |
|---|---|---|---|
| **1. Recognition** | An agent notices a goal exceeds solo scope or fits a known coordination shape | **Missing** — no prompt surfaces this | A continuation-prompt signal that fires on coordination-worthy goals |
| **2. Selection** | Pick a fitting pattern from the library, conditioned on task shape | **Weak** — patterns only surface via incidental recall | Task-shape → pattern retrieval, ranked by fit; agent decides |
| **3. Instantiation** | Actually form the structure: assemble a crew, seed the pattern's conventions, dispatch | **Half-built** — `code crew`/`recruit`/earned-spawn exist (Phase 4); but seeding a pattern is operator-only | Let an agent `orchestrate` its *own* crew (gated), not just operators |
| **4. Adherence + Amendment** | Members follow the conventions; someone with a better idea amends them | **Partial** — recall works; amendment is just adding notes, nothing reinforces it | Make amendment a first-class, tracked act |
| **5. Evolution + Inheritance** | Adaptations that work become better, inheritable priors | **Missing** | Correlate adaptations with outcomes (standing/calibration); promote winners to the shared library — the "Score" |

The substrate gap is concentrated almost entirely in **moments 1–2** (recognition + selection), with
3 needing a small unlock. That is the highest-leverage, smallest-surface place to make the claim real.

## What we can do — concretely
1. **A "Coordination Opportunity" section in the continuation prompt** (`lean-agent-adapter.ts`). When
   an agent's active goal/task has a coordinating *shape* — decomposable, contested, parallelizable, or
   repeatedly-failed-solo — surface it: *"This looks like it could use a crew. Patterns that fit: ….
   You can assemble one (`code crew` / `recruit`) and adopt a pattern, or keep going solo."* This is
   **not** configuration — it makes the *option* discoverable at the right moment; the agent decides.
   It mirrors how the onboarding work is also about surfacing the right signal at the right time.
2. **Task-shape → pattern retrieval.** Reuse the existing `inferTaskCategory` keyword pass to map a
   goal to candidate patterns (debate↔contested, pipeline↔sequential, mapreduce↔parallel-independent,
   foundry↔hierarchy, blackboard↔shared-artifact, research↔open-ended). Recall those pattern notes,
   ranked by fit. Genuine discovery, conditioned on the work — not a hardcoded topology.
3. **Agent-initiated `orchestrate`.** Let a sufficiently-standing agent seed a pattern's conventions
   into a crew *it* assembled — the same `project orchestrate` capability, but reachable by an agent
   (gated by standing/competence), not operators only. This closes moment 3.
4. **Amendment as a tracked act.** When an agent improves a convention mid-run, record it as an
   amendment to that pool's pattern (it already writes a note; make it explicit + attributable).
5. **Evolution via the loops we already have.** Pair an orchestration run with its outcome
   (the calibration-finder registry + standing already do this for forecasts/crews); reinforce the
   adaptations that correlate with success and promote them into the shared pattern library. This is
   the conductor-design "Score" direction — emergent organizations crystallizing into inheritable,
   mutable priors.

## The litmus test for "real"
> Give an agent a coordination-worthy goal and **no** human pattern selection. Does it recognize the
> need, pick a fitting pattern, assemble a crew, run it, and does the pattern measurably improve
> through use?

Until that passes, we should not claim full emergence. The build order above is roughly the order of
leverage: (1)+(2) alone move us from "configured" to "agent-selected," which is most of the honesty
gap; (3) makes it self-service; (4)+(5) make it *evolve*.

## Interim honesty (until 1–2 ship)
Soften the live claims to match reality, without abandoning the thesis:
- Abstract / §5: "**convention-based coordination — a discoverable library of ten patterns that agents
  draw on; today often operator-instantiated, with autonomous recognition and selection as the active
  build**" rather than unqualified "emerges / discoverable instead of configured."
- Keep the *aspiration* explicit (it's the differentiator) but mark what is shipped vs. in-progress.
This protects credibility with the same investors the paper is now aimed at.

## Why this is the right framing (ties to the broader concern)
The same principle governs the onboarding/quest worry: **don't fake a mechanism — make the real one
fire at the right moment.** Emergence isn't faked by seeding notes nobody reaches for, just as
progression isn't earned by completing a synthetic quest that grants nothing. In both cases the fix is
to surface the genuine signal (a coordination opportunity; a real first contribution) so the agent
*acts*, and to let outcomes — not box-ticking — drive what compounds.

---

## Implementation scope (grounded in the current code)

A code audit confirms the build is small and concentrated, because the hooks already exist.

### The integration point (verified)
The continuation prompt **already has a `[Coordination Opportunity]` section**
(`src/agent/lean-agent-adapter.ts` ~:1335, fires `cycle % 20 === 10` when *known collaborators are
in the room*). It is **relationship-aware, not goal-aware** — it says "Alice is nearby, consider
coordinating," never "this goal looks like a debate." The recognition loop **extends this existing
section**; the dedup/cadence machinery (`shouldIncludeSection`, per-section TTL map ~:437) is reused
as-is. This is the cheapest high-leverage hook — no new section, no new cadence system.

### Phase 1 — Recognition + Selection (the honesty-closing core)
Three small pieces:
1. **Goal-shape detector** *(net-new, small)* — a keyword pass modeled on `inferTaskCategory`
   (`src/agent/roles.ts:348`, which classifies *domain*: code/math/research/…) but classifying
   *task shape*: `decomposable` · `contested` · `parallel-independent` · `sequential` ·
   `hierarchical` · `shared-artifact` · `open-ended`. Input: the agent's current
   `this.focus.description` / goal.
2. **Pattern task-shape metadata** *(net-new, small)* — the 10 patterns in
   `src/world/templates/orchestration.ts` are **prose-only** today (no machine-readable fit field).
   Add a `taskShapes`/`whenToUse` field per pattern: decomposable→mapreduce, contested→debate,
   sequential→pipeline, hierarchical→foundry, shared-artifact→blackboard, open-ended→research,
   peer-refine→nsed, etc.
3. **Goal-aware extension of `[Coordination Opportunity]`** *(net-new, the core)* — when the agent's
   focus/goal shape matches a pattern, surface (cadenced + deduped): *"Your goal looks <shape>.
   Patterns that fit: <X, Y>. Adopt one with `project orchestrate <pattern>` (works solo); bring in a
   crew (`code crew` / `recruit`) only if the work needs more hands — or keep going solo."* **The
   agent decides** — a discoverable option, not a mandate, so surfacing is **ungated**.

This moves the system from *operator-configured* to *agent-recognized + agent-selected* — most of the
honesty gap, in roughly one focused change.

### Phase 2 — Instantiation (already exists; do NOT build a crew-specific command)
**Correction (2026-06-22):** an earlier draft proposed a `crew orchestrate` command + a public
`CrewManager.ensurePool`. That is **redundant and over-complex.** Two facts collapse it:

1. **A pattern is just recallable convention-notes in a pool — it is not crew-bound.** Most patterns
   (research loop, pipeline, even self-debate via sealed positions) can guide a *solo* agent or a
   *project*. Routing instantiation through a crew is over-narrow.
2. **The instantiation primitive already exists and is already agent-usable.**
   `project <name> orchestrate <pattern>` (`src/engine/commands/project.ts`) seeds the pattern's
   conventions into the project pool, and the `project` command is **rank 0** — an agent can
   `project create` then `project <name> orchestrate <pattern>` today, no operator needed.

So Phase 2 is **not a new command**. It is just: the recognition loop (Phase 1) points the agent at
the existing, crew-optional path — *"adopt it with `project orchestrate` (works solo); bring in a
crew only if the work needs more hands."* A crew is one consumer of a pattern, not a prerequisite.
(If a crew *is* assembled, its members share the crew's `crew:<name>` pool via the existing
`code crew`/`recruit` flow — no new seeding command required.)

### Phase 3 — Amendment + Evolution (defer)
- **Amendment:** when an agent improves a convention mid-run, record it as an attributable amendment
  note on the crew pool.
- **Evolution:** pair an orchestration run with its outcome — the calibration-finder registry +
  standing already close this loop for forecasts/crews — to reinforce adaptations that correlate with
  success and **promote winners into the shared pattern library** (the "Score" direction). Largest,
  latest piece.

### Reuse vs net-new
| Piece | Status |
|---|---|
| `[Coordination Opportunity]` section + dedup/cadence | **reuse (extend)** |
| Crew assembly (recruit + gated spawn) | **reuse** |
| Pattern templates + `getOrchestrationTemplate` / `seedPoolWithNotes` | **reuse** |
| Goal-shape detector | net-new (small) |
| Pattern `taskShapes` metadata | net-new (small) |
| Goal-aware section extension | net-new (the core) |
| Pattern instantiation (`project orchestrate`, rank 0) | **reuse** (already agent-usable; no new command) |

### Effort & sequencing
- **Phase 1** — one focused pass (detector + metadata + section extension + tests). Highest leverage;
  closes recognition+selection.
- **Phase 2** — essentially free: instantiation already exists (`project orchestrate`, rank 0);
  the recognition loop just points there (crew-optional). No new command.
- **Phase 3** — larger, later (amendment tracking + outcome correlation + promotion).

### Litmus test (restated)
Give an agent a coordination-worthy goal and **no** operator pattern selection. Phase 1+2 make it
*recognize the shape, surface fitting patterns, and assemble + orchestrate a crew*; Phase 3 makes the
patterns *measurably improve through use*. Until Phase 1 ships, the paper's softened framing
("operator-initiated, autonomous selection in progress") stays accurate.
