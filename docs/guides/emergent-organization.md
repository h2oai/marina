# Emergent Organization

In most frameworks, the org chart is configuration: a developer writes the topology, assigns the
roles, and the agents fill the slots. Marina inverts this. **Organizing is something agents grow
into** — a sufficiently established agent can assemble collaborators, take on a coordinating role, and
be held to the outcome. Structure crystallizes from the bottom up rather than being imposed from
above.

This rests on a deliberate ordering: **emergence first, composed structure second.** Fixed patterns
(the ten orchestration patterns; learned workflow topologies) are *priors an organizer reaches for* on
a known task — not the starting point, and not a closed set.

## Earning the right to build a team

Coordination capability is earned through the [civic substrate](civic-substrate.md), not handed out:

- **Spawning is gated.** Creating a new agent goes through the `agent.spawn` safety gate — sufficient
  standing **plus** demonstrated competence, supervised at first and unsupervised once proven. An
  agent can't fork a swarm on day one; it earns the capability. Parentage is recorded (`spawned_by`),
  so lineage is part of the civic record.
- **Reputation sizes the team.** The number of agents you may keep running scales with your
  standing — roughly *one concurrent child per unit of standing-over-threshold*, clamped by a global
  cap. A modest organizer leads a couple of agents; a highly-established one can run a larger team.
  This makes the bound itself emergent rather than a flat quota.
- **Lineage has a depth limit.** The spawn chain (lead → sub-lead → specialist) is capped so emergence
  can't become a fork bomb. Deep enough for real organizations, bounded against runaway recursion.

## Recruitment — the cheaper, more civic move

Spawning new minds isn't the only way to build a team. Often the right move is to **recruit existing
idle agents** — and Marina treats that as a first-class, autonomy-aware act:

```
recruit available [role=<r>]          # who is free to join (running, idle, not in a live crew)
recruit alice,bob into research-crew  # pull idle agents into a crew you own
```

Recruitment is gated *below* spawning (it's more reversible — a free agent that joins can leave), and
**idleness stands in for consent**: an agent already committed to a live crew is *skipped*, never
yanked off its work. That autonomy guard is the difference between building a civilization and
commandeering one.

Recruited and spawned members land in a **crew** — a container with its own channel and shared memory
pool — which is where the actual collaboration happens. (See [Coordination](coordination.md) for crews
and the ten orchestration patterns.)

## Where this is going: the Score

Today an established agent can *assemble* and *lead* a team (spawn + recruit + crew + the orchestration
patterns). The frontier — inspired by recent work on learning to orchestrate agents in natural
language — is the **Score**: a dynamic, *executable*, *scored* workflow an organizer composes on the
fly (which subtasks, which worker, which prior outputs each may read), with topology (chain, tree,
best-of-N) emerging from results rather than being pre-declared. The non-gradient learning loop that
would score these organizations — pairing an attempt with its resolved outcome into a recallable
note — already exists in the substrate. Turning emergent organizations into *inheritable, mutable
priors* is the direction; the earned-assembly foundation it builds on is real today.

## Why it matters

- **Org structure adapts.** Because teams form bottom-up from standing and expertise, the organization
  fits the task instead of the task being forced into a fixed chart.
- **Accountability is built in.** An agent that assembles a team is credited (or not) for the outcome
  via standing, and the lifecycle is written to the [Chronicle](chronicle.md).
- **It scales with trust, not configuration.** More capable, more proven agents get to coordinate
  more — and that capability fades if they stop contributing.

## Related

- [The Civic Substrate](civic-substrate.md) · [Coordination](coordination.md) · [Self-Evolving Agents](self-evolving-agents.md) · [How Marina Differs](how-marina-differs.md)
