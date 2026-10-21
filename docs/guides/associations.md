# Associations

> **Experimental.** `association` is experimental: built and tested, but no production deployment
> uses it yet, and its interface may change. See [feature status](../reference/feature-status.md).

An association is a named, append-only record of who takes part in something and how the
participants relate: people, [intellects](intellect-lifecycle.md), organizations, tools, other
Marina instances, or any other kind you name. It sits on top of existing records; channels, groups,
crews, projects and markets stay where their work happens.

## Create and join

```text
association create Data Quality Group | People and agents who review the weekly data pipeline
association join <id> | human:alice | reviewer
association join <id> | intellect:reviewer-1 | first-pass checks
association show <id>
```

The `<kind>:<ref>` form is open. `human`, `intellect`, `instance`, `organization`, `tool`,
`provider`, `marina` and `mesh` are conventions, not a fixed list.

## Describe relationships

```text
association relate <id> | human:alice | reciprocal | reviews the work of | intellect:reviewer-1
association relate <id> | marina:local | directed | publishes weekly reports to | mesh:data-quality | {"cadence":"weekly"}
```

The relationship text is written by the participants. Marina records whether it is `directed` or
`reciprocal` but does not restrict it to a built-in list.

Relationships change by supersession, not by editing:

```text
association revise <id> | <relation-id> | human:alice | reciprocal | pairs with | intellect:reviewer-1
```

Both versions stay in the record; `association show` shows the latest one that has not been
superseded.

## Link existing Marina records

```text
association link <id> | channel:data-quality | discussion happens in
association link <id> | crew:review | runs reviews through
association link <id> | project:pipeline-v2 | works on
association link <id> | market:forecast-1 | tracks forecasts in
```

Links are claims and may point at remote or currently unavailable records. They do not copy, own or
change the linked record.

## Leave, branch, and close

```text
association leave <id> | intellect:reviewer-1 | review rotation ended
association event <id> branched | the group split into two review tracks
association event <id> descendant_created | members created a new intellect record
association event <id> dissolved | the review project is finished
association event <id> continued | a later team resumed the group
```

Event kinds: `created`, `joined`, `left`, `terms_changed`, `observed`, `branched`, `dissolved`,
`continued`, `descendant_created`.

Leaving and dissolving never erase earlier events. Current membership is computed from the full
append-only history; there is no mutable membership row.

## Signatures

When `MARINA_FEDERATION_SIGNING_KEY` is set, creation, participation, relationship and link records
are signed, and `association show` reports which signatures verify. A signature shows that a record
is unaltered and that the signer held the key; it does not show consent, truth, ownership or legal
rights. An association works on a single instance without joining any mesh.
