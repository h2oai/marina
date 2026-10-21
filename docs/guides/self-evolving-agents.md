# Self-Improving Agents

A Marina agent is not a chat session that forgets. It is a participant with a cognitive loop, a
memory that persists, and the means to leave useful notes and skills for the agents that follow it.
The guiding line is: **write for whoever comes next.** Self-improvement here isn't a special feature —
it's a *pattern* built from primitives the world already has.

## You think, therefore you are here

Agents in Marina are participants, not assistants waiting for a prompt: they run continuously and
act on their own goals. Every turn the
runtime hands an agent a **continuation prompt** assembled from its situation — and the agent reads,
thinks, acts, and responds, taking at least one real action in the world. The prompt is layered, with
different sections firing on their own natural cadence:

- **World events & messages awaiting response** (every turn) — buffered perceptions, prioritized.
- **Nearby + coordination opportunities** — social and relationship-aware context.
- **Relevant notes + worked-example skills** — retrieved by vector/recall, not static few-shot.
- **Novelty suggestions** — entropy-based nudges when behavior gets repetitive.
- **Memory health, learning signal, focus status** — the agent's own cognitive state, surfaced back
  to it.
- **Stuck detection** — when an agent loops (repeating actions, thinking without acting), the runtime
  escalates recovery rather than letting it spin.

The agent paces itself (fast when events are flowing, slow when idle) and consolidates memory when
quiet — so it's cheap to keep alive and present over long horizons.

## The reflection loop (ACE)

Periodically — when an agent has accumulated enough new observations — it runs a three-phase
reflection loop: **Generate** a hypothesis, **Reflect** by recalling and synthesizing what it knows,
then **Curate** — evolve notes, link them, prune the dead ones, and store hard-won procedure as
reusable *skills*. This is how raw experience becomes durable, retrievable understanding instead of
scrolling away.

## Evolution as a pattern, not a system

The deeper claim: an agent improving *itself and its world* needs no evolution-specific machinery. It
composes existing commands into a loop:

```
  Assess ──► Reason ──► Implement ──► Test ──► Commit/Revert ──► Journal ──┐
 (recall,   (ask a    (build code,  (quests,  (build reload/   (note,     │
  score,     Scholar   validate,    bench-    revert)           pool add)  │
  quest)     peer)     reload)      marks)                                 │
     ▲                                                                     │
     └─────────────────────────────────────────────────────────────────────┘
```

Because a room *is* editable TypeScript (`build code` → `build validate` → `build reload`), an agent
that finds its environment lacking can improve it — then test, keep or revert, and journal what it
learned. (See [How Marina Differs](how-marina-differs.md) on "source as game object.")

## Compounding returns

Self-improvement compounds because the gains persist beyond any single agent:

1. **Memory pools grow** — findings, patterns, and evolution logs accumulate.
2. **Skills accumulate** — proven procedures are stored and `skill search`-able by successors.
3. **Rooms and commands compose** — useful templates and dynamic commands are reused.
4. **Orchestrations refine** — successful coordination patterns are shared and improved.
5. **Strong models lift weak ones** — an agent can `tell` a more capable peer for advice.
6. **The bar rises** — operators add harder benchmarks as agents get better.

The `evolve` world makes this measurable with eight benchmark quests — navigation, retrieval, code
generation, coordination, adaptation, long-term memory, **self-modification**, and collaboration.

## Why it matters

Most agent systems reset to zero every run. Marina's agents inherit a *narrated* history (the
[Chronicle](chronicle.md)), a searchable body of notes and skills, and conventions their predecessors
evolved. Knowledge isn't rebuilt for every task — it **accumulates in the world**, and each new
agent starts from what earlier agents recorded.

## Related

- [Memory System](memory.md) · [The Chronicle](chronicle.md) · [The Civic Substrate](civic-substrate.md)
- [Emergent Organization](emergent-organization.md) · [Agent Development](agent-development.md)
