# Economic, Simulation, and Change Records

> **Experimental.** `economy`, `lab` and `mutation` are experimental: built and tested, but no
> production deployment uses them yet, and their interfaces may change. See
> [feature status](../reference/feature-status.md).

These three commands keep append-only, attributable records. None of them moves money, runs a
simulation or applies a change by itself; they record what participants declare, with references to
the evidence. Records are signed with Ed25519 when `MARINA_FEDERATION_SIGNING_KEY` is set.

## Economic provenance (`economy`)

A contract records the terms of a piece of work around a goal reference (for example a task or a
[journey](journeys.md)):

```text
economy contract task:42 | {"deliverable":"market report","price_usd":250} | two independent reviewers | appeal:operator
```

Creating a contract also records an `offer` event. Later events are claims with references to what
caused them:

```text
economy event contract_… contribution | human:alice | artifact:report-12 |  |  |  | trace:7 | {"role":"analysis"}
economy event contract_… settlement | org:acme-finance | human:alice | 250 | currency:USD | invoice:INV-2026-0142 | artifact:report-12 | {"observed":true}
```

Event kinds: `offer`, `acceptance`, `funding`, `escrow`, `resource_use`, `contribution`,
`delivery`, `verification`, `counterexample`, `dispute`, `appeal`, `settlement`, `refund`,
`royalty`, `license`, `transfer`, `donation`, `attribution`.

`economy adapter` declares how an outside system (an invoicing tool, a payment processor, a ledger)
is referenced, observed or submitted to. Marina stores references only, never funds or credentials.
An event is a claim, not proof of payment, ownership, licensing or entitlement. Verification,
disputes, appeals and counterexamples are separate events, so the full history stays readable.

## Simulation run records (`lab`)

Start with a scenario manifest, stored under its SHA-256 hash:

```text
lab manifest {"world":"research","population":["intellect:reviewer-1"],"goal":"task:42"}
lab run sha256:… | recorded | recorded-response | seed-a | {"memory":"graph"}
```

`lab run` declares a run; it does not execute anything, and no result is recorded until someone
records it with `lab event`. `lab fork` records a variant run that branches from a named point of a
parent run without changing the parent. `lab replicate` declares a batch of runs with different
seeds, and `lab compare` packages runs and observations into a dataset without declaring a winner.

Every run declares one reproducibility level:

- `exact-engine`: the engine state can be replayed exactly.
- `recorded-response`: recorded model responses can be replayed, not regenerated identically.
- `behavioral`: behaviour is comparable under the stated conditions.
- `statistical`: conclusions need a population of runs.
- `conceptual`: the scenario tests an idea, not a reproducible mechanism.

Manifests may reference existing journeys, experiments, traces, snapshots, world manifests or mesh
events.

## Change records

`mutation` records a change to a named target: who proposed, adopted, rejected, branched or observed
it, the patch, the evidence, and any earlier changes it builds on.

```text
mutation record association association:<id> | adopted | added a weekly review step | {"cadence":"weekly"} |  | observation:9
mutation lineage association association:<id>
mutation list
```

Domains are free text (`role`, `association`, `charter`, `federation`, `reproduction`, `genome`,
`protocol`, …). Recording a change does not apply it: the affected subsystem keeps its own editors,
safety gates and approval rules. The record only gives every change one auditable history.

To derive a new [world manifest](reproduction-and-meshes.md#world-manifests-genome) from an existing
one, apply a JSON patch:

```text
mutation genome sha256:… | allow two-parent derivation | {"reproduction":{"method":"recombination"}} | experiment:12
```

This stores the new manifest under its own hash and records a `branched` change linking parent and
child. `marina-descend create` can then start a child world from it.

## Export and federation

All economic, simulation and change records are included in Marina export/import. Federation
manifests advertise them under the protocol ids `economic.provenance.v1`,
`simulation.manifest.v1` and `civilization.mutation.v1` (fixed wire identifiers), so an instance
that runs on its own can keep these records locally and share them through a mesh later.
