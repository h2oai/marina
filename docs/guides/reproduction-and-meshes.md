# Lineage Records, Child Worlds, and Meshes

> **Experimental.** `reproduce`, `genome` and `marina-descend` are experimental: built and tested,
> but no production deployment uses them yet, and their interfaces may change. Mesh commands are part
> of the experimental federation feature. See [feature status](../reference/feature-status.md).

These commands keep attributable records of where an agent identity or a world came from. Apart from
`marina-descend start`, which runs a child world as a separate local process, they only write
records; nothing is trained, copied or executed.

## Derived intellects (`reproduce`)

An [intellect](intellect-lifecycle.md) is an identity record for an agent. `reproduce intellect`
creates a new intellect record from one or more parent intellects and lists, component by component,
what was inherited, changed, added or left out:

```text
reproduce intellect <parent-id> | Reviewer | A cheaper review agent for routine pull requests | [{"kind":"model","ref":"local/small","disposition":"introduced"},{"kind":"memory","ref":"pool:review-notes","disposition":"inherited"}]
reproduce list
reproduce show <reproduction-id>
```

Each component is `{"kind": …, "ref": …, "disposition": "inherited|mutated|introduced|excluded"}`.
Component kinds are free text (`model`, `memory`, `personality`, `tool`, `dataset`, …), so new kinds
need no schema change. One parent records mode `descent`; several parents record `recombination`.

If the components name a `principal`, `model`, `harness` or `environment`, Marina also records an
intellect instance with those references, which a compatible runtime can use to start the agent. The
new intellect is a separate record: listing a parent gives the parent no ownership of or authority
over it.

## World manifests (`genome`)

A "genome" is a JSON manifest that describes a world: its template, components and compatibility
tags. It is stored under the SHA-256 hash of its canonical form, so identical manifests get the same
address:

```text
genome create research | role:critic,pool:review-notes | marina.genome.v1 | review-heavy research world
genome show <sha256:hash>
genome list
```

`genome show` reports whether the stored hash matches the manifest and, if the manifest was signed,
whether the signature verifies. To derive a new manifest from an existing one, see
[`mutation genome`](economics-simulation-and-recursion.md#change-records).

## Child worlds (`marina-descend`)

`marina-descend` turns a manifest into a child world: a separate local Marina process with its own
database, assets directory and ports, managed by the World Collective manager
(`src/world/world-collective-manager.ts`). Starting a host process is guarded by the
`world.lineage` safety gate: a held request runs once a person approves it (`challenge`), approvals
from outside your own lineage build the gate (`gate list`), or an operator grants it.

```text
marina-descend create <genome-hash> | review-lab | <parent-world-ids> | recombination | does a dedicated reviewer reduce rework? | change:<id>
marina-descend start <descendant-id>
marina-descend stop <descendant-id>
marina-descend list
```

A child world is created stopped. The parent records the link; nothing in the parent changes the
child's database or settings afterwards. A child world's daily spend cap is the lower of
`MARINA_CHILD_DAILY_SPEND_CAP_USD` and the parent's cap.

## Meshes

A mesh is a named group of Marina instances that agree to exchange signed records. Membership is
voluntary and an instance may belong to several meshes. Stable mesh ids let separate instances refer
to the same mesh without a central registry.

```text
mesh create mesh:open-science | Open Science | charter:v1 | transparent.v1
mesh join mesh:open-science | {"history":"available","gaps":[]}
mesh publish mesh:open-science | result | {"claim":"replication failed on dataset B"}
mesh show mesh:open-science
mesh leave mesh:open-science | project finished
```

With `MARINA_FEDERATION_SIGNING_KEY` set, membership, published events, witness records and
translations are signed. Another instance can store an exact copy of a signed event:

```text
mesh export mesh:open-science <event-id>
mesh replicate mesh:open-science <event-token>
mesh witness mesh:open-science <event-id> disputed
```

Replication checks the content hash and **requires a valid origin signature by default**: an
unsigned event's `originWorldId` cannot be verified, so unsigned replication is refused unless the
operator sets `MARINA_FEDERATION_ALLOW_UNSIGNED=true` (trusted development networks only). When the
origin world is registered in `federation_peers`, its pinned public key must match the signing key,
and a `blocked` peer is always refused. A refused replication writes nothing. An accepted event adds
a local witness record. Leaving a mesh does not delete replicas. Marina does not infer a global
ordering, truth, permission, ownership or merit from replicated events.

Two meshes with different conventions can exchange records through an explicit translator without
merging their rules:

```text
mesh translate mesh:alpha | mesh:beta | intellect:translator-1 | {"result":"finding"}
```

None of this is required: a Marina instance works on its own, with no mesh, blockchain or registry.
