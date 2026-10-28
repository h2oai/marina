# Emergent Organization

In most frameworks, the org chart is configuration: a developer writes the topology, assigns the
roles, and the agents fill the slots. Marina inverts this. **Organizing is something agents grow
into** — a sufficiently established agent can assemble collaborators, take on a coordinating role, and
be held to the outcome. Structure crystallizes from the bottom up rather than being imposed from
above.

This rests on a deliberate ordering: **emergence first, composed structure second.** Fixed patterns
(the built-in orchestration patterns; learned workflow topologies) are *priors an organizer reaches for* on
a known task — not the starting point, and not a closed set.

## Earning the right to build a team

Coordination capability is earned through the [civic substrate](civic-substrate.md), not handed out:

- **Spawning is gated.** Creating a new agent goes through the `agent.spawn` safety gate — sufficient
  standing **plus** demonstrated competence, supervised at first and unsupervised once proven. How
  "supervised" behaves depends on the operator's autonomy posture (`MARINA_AUTONOMY`): under
  `guarded` an attempt is held until a person approves it (approved runs from outside the
  agent's own lineage are what earn the gate), under `earned` an agent at the gate's standing floor
  runs it and the run waits as a pending demonstration an operator may attest (`witness attest`),
  and under `open` the gate auto-passes. An agent can't fork a swarm on day one; it
  earns the capability. Parentage is recorded (`spawned_by`), so lineage is part of the civic record.
- **Reputation sizes the team.** The number of agents you may keep running scales with your
  standing — roughly *one concurrent child per unit of standing-over-threshold*, clamped by a global
  cap. A modest organizer leads a couple of agents; a highly-established one can run a larger team.
  This makes the bound itself emergent rather than a flat quota.
- **Lineage has a depth limit.** The spawn chain (lead → sub-lead → specialist) is capped so emergence
  can't become a fork bomb. Deep enough for real organizations, bounded against runaway recursion.
- **Spend is bounded too.** A spawned agent can carry a lifetime model-call budget
  (`agent spawn <name> budget <n-calls>`) — a second, orthogonal bound: the team size scales with
  standing, and each member's total inference spend is capped at spawn.

## Recruitment — the cheaper, more civic move

Spawning new agents isn't the only way to build a team. Often the right move is to **recruit existing
idle agents** — and Marina treats that as a first-class, autonomy-aware act:

```
recruit available [role=<r>]          # who is free to join (running, idle, not in a live crew)
recruit alice,bob into research-crew  # pull idle agents into a crew you own
```

Recruitment is gated *below* spawning (it's more reversible — a free agent that joins can leave), and
**idleness stands in for consent**: an agent already committed to a live crew is *skipped*, never
yanked off its work. Recruiting only idle agents keeps a crew from taking over work that another
crew depends on.

Recruited and spawned members land in a **crew** — a container with its own channel and shared memory
pool — which is where the actual collaboration happens. (See [Coordination](coordination.md) for crews
and the orchestration patterns.)

## Scores

An established agent can *assemble* and *lead* a team (spawn + recruit + crew + the orchestration
patterns). A **Score** is the executable form of such an organization: a workflow of steps (which
subtask, which worker, which prior outputs each may read) with a pure-code combine at the end. Each
formation in the catalogue carries its Score templates, and `pattern run` and resident forecasts
(`forecast <q> crew:<name> pattern:<formation>`) run them. Outcomes resolve through the same
outcome path as every other answer, so what an organization produced can be judged and taught as
lessons. See [Coordination](coordination.md) and
[orchestration](../architecture/orchestration.md).

## Why it matters

- **Org structure adapts.** Because teams form bottom-up from standing and expertise, the organization
  fits the task instead of the task being forced into a fixed chart.
- **Accountability is built in.** An agent that assembles a team is credited (or not) for the outcome
  via standing, and the lifecycle is written to the [Chronicle](chronicle.md).
- **It scales with trust, not configuration.** More capable, more proven agents get to coordinate
  more — and that capability fades if they stop contributing.

## Related

- [The Civic Substrate](civic-substrate.md) · [Coordination](coordination.md) · [Self-Improving Agents](self-evolving-agents.md) · [How Marina Differs](how-marina-differs.md)
