# World Collective

The World Collective lets one source checkout run isolated child Marinas for A/B work without an
external control plane. Open **Dashboard → Admin → Collective** to create a variant, name the world
template it should seed, state the hypothesis, and start it. The parent allocates a private database,
asset directory, and four-port block, then launches the child from the same `src/main.ts` source.

Each child has its own dashboard. A variant is not reported as running until its public setup-status
endpoint responds. Exit codes and readiness timeouts become visible failure states. If the parent
restarts, it marks previously recorded children failed rather than assuming an untracked process is
healthy.

## From inside the world

Operators (rank 5 with `admin.destructive`) can do the same without the dashboard, and use a child
once it runs:

```text
world create trial1 empty | does scout-v2 answer better than scout?
world start trial1
world seed-role trial1 scout-v2      # the role and its traits, losslessly (role export → role import)
world run trial1 benchmark list      # any world command, run inside the child as you
world run trial1 readiness           # includes the child's own Daily spend ($50 cap)
world stop trial1
```

`world run` posts to the child's command endpoint on loopback under your name, so the child's audit
trail names who acted. A child resolves its own trust profile: on a single-operator machine it is
`local` and your commands run ungated there; on a shared profile you need rank in the child too.
`role export <name>` / `role import <bundle>` also move roles between any two Marinas; import only
creates — an existing role, or a same-named trait with different content, is refused.

## Reproducible comparison

Create a baseline and candidate from the same world template. Change one independent variable through
normal Marina configuration or agent work, run the same task/eval corpus in both, then compare their
traces, judgments, structured logs, artifacts, and evidence-chain heads. The variant hypothesis is a
label, not proof; promotion remains a deliberate operator decision.

**Promote** requires a concise rationale and one or more exact trace, artifact, or checkpoint
references. The decision receives a tamper-evident evidence receipt and records exactly one preferred
candidate. This requirement governs rollout preference, not agent execution: experiments and child
world autonomy continue without it. Promotion does not replace, merge, or restart the parent world
and does not silently copy memory between databases. A running preferred candidate remains running;
a stopped one remains stopped. This separation avoids confusing rollout state with process liveness.

## Spend

Every child world starts with its own daily spend cap — $50 unless the parent sets
`MARINA_CHILD_DAILY_SPEND_CAP_USD` — enforced inside the child on everything it pays upstream
(model calls, benchmark runs, decisions, forecasts). The child's `readiness` shows today's spend;
at the cap its model calls are refused until 00:00 UTC. The parent's own budget
(`MARINA_DAILY_SPEND_CAP_USD`) is separate.

## Boundaries

- Source launch is available when Marina is running from a checkout containing `src/main.ts`. Packaged
  applications expose the records but report source launch unavailable.
- Children inherit the parent's environment except for their identity, world, storage, ports, and
  disabled agent auto-respawn. Review inherited provider and authentication settings before starting.
- The parent only stops subprocesses it launched during its current lifetime. It never kills a PID
  recovered from the database.
- This is local process isolation, not a container, VM, tenant boundary, or cross-host federation.
- Cross-world memory transfer remains explicit. Do not treat matching display names as federated
  identity; principal IDs are issuer/world scoped until signed federation exists.
