# Reproduction and Transparent Meshes

## Intellect descendants

`reproduce intellect` creates a new portable intellect identity and records its parents,
contributors, evidence, and selectively inherited, mutated, introduced, or excluded components.

```text
reproduce intellect <parent-id> | Specialist | Explore a cheap skeptical branch | [{"kind":"model","ref":"local/small","disposition":"introduced"},{"kind":"memory","ref":"pool:tradition","disposition":"inherited"}]
reproduce list
reproduce show <reproduction-id>
```

Model, harness, environment, and principal components produce a declared intellect instance that a
compatible runtime can activate. Memory, personality, architecture, tool, dataset, experiment,
fine-tune, and unfamiliar future component kinds remain attributable without requiring new schema.
The child is independent; lineage conveys neither ownership nor authority.

## Marina genomes and descendants

A genome is a canonical JSON manifest addressed by its SHA-256 content hash:

```text
genome create research | role:critic,score:debate,pool:tradition | marina.genome.v1 | narrow adversarial laboratory
genome show <sha256:hash>
```

Creating or launching a process is intentionally separate from describing cognition. The existing
`admin.destructive` safety boundary protects host process creation:

```text
marina-descend create <genome-hash> | odd-lab | <parent-world-ids> | recombination | test incompatible institutions | memory:graph
marina-descend start <descendant-id>
marina-descend stop <descendant-id>
```

The descendant runs through World Collective with an isolated database, assets directory, ports,
identity, and future. Its parent cannot silently promote, mutate, or govern it.

## Transparent meshes

Meshes are voluntary and may overlap. Stable IDs allow separate Marinas to recognize the same
declared mesh without a global registry.

```text
mesh create mesh:open-science | Open Science | charter:v1 | transparent.v1
mesh join mesh:open-science | {"history":"available","gaps":[]}
mesh publish mesh:open-science | result | {"claim":"unexpected"}
mesh show mesh:open-science
mesh leave mesh:open-science | pursuing a separate specialization
```

With `MARINA_FEDERATION_SIGNING_KEY`, membership, stream, witness, and translation claims are
signed. Another Marina can preserve the exact signed event:

```text
mesh export mesh:open-science <event-id>
mesh replicate mesh:open-science <event-token>
mesh witness mesh:open-science <event-id> disputed
```

Replication verifies the content hash and any supplied origin signature, then adds a distinct local
witness. Departure never removes the replica. Exact global ordering, truth, permission, ownership,
and merit are not inferred.

Incompatible meshes can use explicit translators without merging governance:

```text
mesh translate mesh:alpha | mesh:beta | intellect:polyglot | {"result":"finding"}
```

Detached operation remains the default and requires no mesh, blockchain, or registry.
