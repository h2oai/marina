# Generalized Associations

An association is a named context in which people, intellects, organizations, tools, Marinas, or
entirely new kinds of participant can describe how they relate. It is an overlay: channels, groups,
crews, projects, Scores, markets, and other Marina primitives remain the places where their normal
work happens.

## Start simply

```text
association create Night Garden | People and intellects compare observations after dark
association join <id> | human:alice | field observer
association join <id> | intellect:lumen | notices weak signals
association show <id>
```

The `<kind>:<ref>` form is intentionally open. `human`, `intellect`, `instance`, `organization`,
`tool`, `provider`, `marina`, and `mesh` are useful conventions, not a closed ontology.

## Define the relationship

```text
association relate <id> | human:alice | reciprocal | challenges assumptions with | intellect:lumen
association relate <id> | marina:local | directed | publishes observations to | mesh:night-watch | {"cadence":"daily"}
```

Relationship semantics are participant-authored text. Marina records whether a claim is directed
or reciprocal but does not reduce relationships to a built-in list.

Terms change through supersession rather than mutation:

```text
association revise <id> | <relation-id> | human:alice | reciprocal | learns beside | intellect:lumen
```

Both claims remain observable; `association show` presents the latest unsuperseded claim.

## Compose existing Marina capabilities

```text
association link <id> | channel:research | conversation occurs in
association link <id> | crew:red-team | performs challenges through
association link <id> | project:alpha | advances
association link <id> | score:deliberation | sometimes coordinates with
association link <id> | market:forecast-1 | contests beliefs through
```

Links are provenance claims and can refer to remote or temporarily unavailable records. They do
not copy, own, or silently alter the linked primitive.

## Leave, branch, and continue

```text
association leave <id> | intellect:lumen | its experiment is complete
association event <id> branched | two incompatible methods will continue independently
association event <id> descendant_created | participants created a new intellect
association event <id> dissolved | this formation has completed its work
association event <id> continued | later participants resumed the context
```

Leaving and dissolution never erase prior events. The active state is a projection of the complete
append-only record, not a mutable membership row.

## Integrity and sovereignty

When `MARINA_FEDERATION_SIGNING_KEY` is configured, creation, participation, relationship, and link
records are signed. `association show` reports locally verifiable signatures. A signature proves
record integrity and key possession; it does not prove consent, truth, ownership, merit, or legal
rights. Detached Marinas may use the entire primitive without joining any mesh.

