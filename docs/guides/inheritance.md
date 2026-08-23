# Cross-world inheritance

Marina already stores durable shared practice in the `guide`, `orchestration:*`, and `tradition:*`
memory pools. A versioned inheritance bundle makes that deliberately shared evidence portable
without exporting private entity memory, project pools, credentials, prompts, or transcripts.

```text
inheritance list
inheritance export orchestration:research
```

The export ends with a directly reusable command:

```text
inherit <bundle-token>
```

`inherit` requires coordinator rank. It validates strict size and field bounds, computes a stable
digest, and creates an `inheritance:<digest>` pool. Imported artifacts are labelled **unverified
evidence**, attributed to the importing entity while retaining the peer's claimed source, pool, and
author inside the provenance label. Re-importing the same token is idempotent.

Import never activates a skill, edits a role, changes routing, merges into the local guide or
tradition pools, or executes content. A human or agent must inspect, test, and deliberately curate
useful evidence into a local behavior surface. The source field is a claim, not authenticated
federation identity; a future signed world forum can bind the same bundle schema to authenticated
transport provenance without changing its evidence semantics.

For agents, both commands are available through the normal Marina command tool. This makes the
workflow entirely copy/pasteable between worlds while preserving the same human/agent permissions.
