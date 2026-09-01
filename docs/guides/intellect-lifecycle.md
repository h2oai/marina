# Intellect identity and lifecycle

An intellect is a portable cognitive lineage claim. It is distinct from a local principal, a
running instance, its model, its harness, and the Marina environment it inhabits. Existing agents
continue working without an intellect identity.

```text
intellect create Lumen | Explore unfamiliar systems | human:alice,provider:example
intellect instance <id> | <local-principal-id> | openai/model | marina/harness-v1 | marina:local
intellect show <id>
intellect list
```

Empty instance fields are allowed when a component is unknown or detached. Multiple instances may
claim one intellect; recording that claim does not decide whether philosophical personal identity
is preserved.

Create an independently identified descendant:

```text
intellect descend <parent-id> Lumen-Specialist | Develop a narrow research tradition
```

The event records ancestry in both histories and implies no ownership by the parent.

Lifecycle is append-only:

```text
intellect event <id> dormant | No active instance; checkpoint retained
intellect event <id> revived | Restored after 30 days with a different model
intellect event <id> component_changed | Replaced model A with model B; harness unchanged
intellect event <id> continuity_claimed | The revived instance claims continuity
intellect event <id> migrated | Continuity claimed in marina:elsewhere
intellect event <id> last_observed | Detached peer has not appeared for one month
intellect event <id> terminated | The lineage issued a terminal claim
```

Silence is not termination. Use `last_observed` when only disappearance can be demonstrated.
Dormancy and revival preserve the gap and declared transformations.

When `MARINA_FEDERATION_SIGNING_KEY` is configured, lifecycle claims are signed with Ed25519 and
`intellect show` reports how many signatures verify. Signatures prove integrity and key possession,
not consciousness, continuity, authorization, truth, ownership, or model identity.
