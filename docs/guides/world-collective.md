# World Collective

The World Collective lets one source checkout run isolated child Marinas for A/B work without an
external control plane. Open **Dashboard → Admin → Collective** to create a variant, name the world
template it should seed, state the hypothesis, and start it. The parent allocates a private database,
asset directory, and four-port block, then launches the child from the same `src/main.ts` source.

Each child has its own dashboard. A variant is not reported as running until its public setup-status
endpoint responds. Exit codes and readiness timeouts become visible failure states. If the parent
restarts, it marks previously recorded children failed rather than assuming an untracked process is
healthy.

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
