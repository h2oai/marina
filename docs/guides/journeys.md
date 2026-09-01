# Journeys

A journey keeps an original desire connected to the work and evidence it inspires. It is a thin
correlation layer: tasks remain tasks, projects remain projects, and traces remain traces.

## Start a journey

```text
journey create Understand whether Spain fits my family
```

For the simplest entry, use the equivalent ordinary-language front door:

```text
desire Understand whether Spain fits my family
```

When an AI provider is available, Marina follows preservation with an attributed initial grounding
turn: a concise interpretation and either one material question or one proposed first action. A
proposed action is not reported as completed work. Without a provider, the journey remains
`expressed` and fully usable through human and world actions.

Marina preserves the desire and assigns it a durable `journey_...` identifier. Use `latest` when
you mean your most recently created journey:

```text
journey show latest
journey list
journey list all
```

Journeys are visible to participants in the Marina. `journey list` shows your own; `journey list
all` shows the shared record.

## Correlate canonical work

Link a journey to an existing record instead of copying that record:

```text
journey link latest task 42 pursues
journey link latest project market-research coordinates
journey link latest trace req-7 evidence_for
```

Supported kinds are shown by `help journey`. Repeating the same kind, reference, and relationship
is idempotent.

## Record evidence

Evidence is append-only and attributed to the participant who records it:

```text
journey record latest grounding | The decision criteria are now explicit
journey record latest action_started | Comparison work began | task:42
journey record latest challenge | The market-size assumption is disputed
journey record latest result | A conditional recommendation is available | artifact:report-12
journey record latest continuation | Revisit after the next quarterly release | watch:revenue
```

Adding a reference with an event also creates an `evidence_for` correlation.

## Progress, results, and return

```text
journey progress latest
journey result latest
journey changes latest
```

`progress` shows attributed meaningful events rather than routine engine activity. `result` selects
explicit result evidence or linked task submissions, keeps provisional submissions labeled
partial, resolves supported canonical records, and preserves newer challenges or waiting evidence.
`changes` advances a cursor for the viewing participant and can truthfully report that nothing
meaningful changed.

Add context or correct an interpretation without rewriting the original desire:

```text
journey steer latest Prioritize school access over commute time
```

## Truthful state

Journey state is derived, never directly set. The projection can report `expressed`, `grounding`,
`ready`, `active`, `waiting`, `challenging`, `useful_result`, `continuing`, or `dormant`.

- An open linked task is `ready`, not `active`.
- Claimed or in-progress linked work is `active`.
- Newer explicit evidence such as `waiting` or `dormant` supersedes stale work status.
- Every displayed state includes its reason and evidence references.

This means a scaffold or correlation alone cannot masquerade as work in progress.

## Compatibility and limits

The feature is additive. Existing commands and APIs do not require a journey, and deleting or
editing canonical work is outside the journey layer. Phase 2 projects live status from linked tasks
and projects; other correlation kinds contribute traceability but do not yet supply automatic live
state. Result projection currently resolves tasks, notes, board posts, Chronicle entries, coding
artifacts, and canvas nodes when explicitly correlated. Cognitive provenance, intellect identity,
federation, economics, and simulation are separate optional layers that can reference the same
journey without changing its source-of-truth semantics.
