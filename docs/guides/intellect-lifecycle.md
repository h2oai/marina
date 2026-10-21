# Intellect Records

> **Experimental.** `intellect` is experimental: built and tested, but no production deployment uses
> it yet, and its interface may change. See [feature status](../reference/feature-status.md).

An intellect is an identity record for an agent that is meant to outlast any one model, harness or
process. It is separate from a local account (principal), a running instance, the model it runs on,
the harness that drives it, and the Marina instance it runs in. Agents work normally without one; an
intellect record only matters when you want to track the same agent across model swaps, restarts or
moves between instances.

```text
intellect create Reviewer-1 | Review pull requests for the data team | human:alice,provider:example
intellect instance <id> | <local-principal-id> | openai/model | marina/harness-v1 | marina:local
intellect show <id>
intellect list
```

`intellect instance` records that a given principal, model, harness and environment are running
this intellect. Any field may be left empty when it is unknown. Several instances may point at the
same intellect; the record states the claim and does not judge whether the instances are "the same"
agent.

Record a derived intellect with its parent:

```text
intellect descend <parent-id> Reviewer-2 | Review only database migrations
```

The derivation is written to both histories. It gives the parent no ownership of the new record.
For multi-parent derivations with component-level detail, use
[`reproduce intellect`](reproduction-and-meshes.md#derived-intellects-reproduce).

## Lifecycle claims

Lifecycle events are append-only claims:

```text
intellect event <id> dormant | No running instance; checkpoint kept
intellect event <id> revived | Restarted after 30 days on a different model
intellect event <id> component_changed | Replaced model A with model B; harness unchanged
intellect event <id> continuity_claimed | The restarted instance claims to continue this record
intellect event <id> migrated | Now running in marina:elsewhere
intellect event <id> last_observed | Detached peer not seen for one month
intellect event <id> terminated | Record closed by its maintainers
```

Kinds: `created`, `instance_created`, `component_changed`, `continuity_claimed`, `descended`,
`migrated`, `dormant`, `revived`, `terminated`, `last_observed`.

Silence is not termination: use `last_observed` when all you can show is that an instance stopped
appearing. `dormant` and `revived` keep the gap and any declared changes in the history.

## Signatures

When `MARINA_FEDERATION_SIGNING_KEY` is set, lifecycle claims are signed with Ed25519 and
`intellect show` reports how many signatures verify. A signature shows that the record has not been
altered and that the signer held the key. It does not show that a claim is true, that a continuity
claim holds, that the signer was authorized, or which model actually ran.
