# Native Evolution Protocols

Native evolution protocols make iterative experiments durable without creating a privileged
Evolver agent or an automatic optimization daemon. They are disabled by default:

```bash
MARINA_EVOLUTION_PROTOCOLS=true
```

The existing `evolve` coach and `experiment` commands are unchanged when the feature is disabled.
When enabled, a protocol attaches to an existing experiment and records its objective, immutable
policy, proposal lineage, evidence, and attributed decisions.

## Constitutional boundaries

- The controller validates and records; it never prompts participants or continues a loop.
- Acceptance is a record, not activation or promotion.
- Metrics are advisory evidence and never alter standing, competence, permissions, or memory.
- Evolver, evaluator, and reviewer are voluntary activities, not entity classes.
- Humans, in-system agents, and external agents use the same world commands.
- Protocol state recovers from SQLite rather than an LLM-generated summary.

## Workflow

Create the underlying experiment first, then attach a protocol:

```text
experiment create PromptTrial arms baseline,candidate metric accuracy goal higher
experiment start PromptTrial
evolve create PromptTrial | Improve accuracy without latency regression | max-runs=12 | min-trials=3 | independent-review=true | guardrail=latency:lower
evolve start PromptTrial
```

Participants explicitly propose, evaluate, and decide:

```text
evolve propose PromptTrial | A shorter prompt reduces distraction | prompt:candidate-2
experiment record PromptTrial baseline accuracy 0.74
experiment record PromptTrial candidate accuracy 0.81
evolve analyze PromptTrial
evolve evaluate PromptTrial 1 | benchmark:prompt-trial-2026-08-04
evolve decide PromptTrial 1 accept
```

An accepted run remains inactive. Promotion or activation must happen separately through the
ordinary command and review path for that candidate type.

Use `parent=<run-id>` to preserve experimental lineage:

```text
evolve propose PromptTrial | Refine the successful shorter prompt | prompt:candidate-3 | parent=1
```

Available status controls are explicit:

```text
evolve sessions
evolve status PromptTrial
evolve pause PromptTrial
evolve resume PromptTrial
evolve complete PromptTrial
```

Run and time budgets refuse new proposals after exhaustion but do not silently pause, complete, or
otherwise change the session. The creator decides what happens next.

## Qualification and transport equivalence

After participants complete a controlled trial, verify its durable evidence outside the agent loop:

```text
bun run qualify:evolution
bun run qualify:evolution http://marina.example:3300
```

The bounded probe waits for a started session, proposal, attributed evidence, and decision. It also
fails if independent-review attribution collapses or passive constitutional defaults were changed.
It is read-only: it cannot propose, decide, continue, activate, or promote.

In-system Pi agents receive the scoped `marina_evolve` tool only while participating in an active
session. MCP clients receive an `evolve` tool, SDK clients use `client.command("evolve ...")`, and
humans use the same command directly. All surfaces converge on the same command handler,
participant checks, persistence, and audit trail.

## Bounded soak testing

Exercise socket churn and command latency against a disposable or staging world:

```text
bun run soak --connections=25 --duration=60 --rate=2 --max-errors=0 --max-p95=2000
bun run soak:churn --url=ws://localhost:3300 --clients=12 --cycles=20
bun run soak:churn:local
```

The driver exits non-zero when clients fail to connect, errors exceed the threshold, no responses
arrive, or round-trip p95 exceeds the bound. Its final line is machine-readable JSON for CI and demo
qualification. Do not aim a high-rate run at a production world without considering its normal
participants and provider limits.

For a disposable three-role real-model trial, run `bun run trial:evolution:local`. It starts and
stops an empty temporary world, asks three agents to join voluntarily, stages proposer → evaluator →
reviewer work, and exits non-zero unless durable evidence passes `qualify:evolution`. Use
`MARINA_TRIAL_MODEL` and `MARINA_TRIAL_TIMEOUT_MS` to select the provider-neutral model identifier
and bound. A failed run is evidence: the harness never fills in an agent's proposal, evaluation, or
decision.

The Experiments dashboard expands each evolution session into lineage, candidate, evidence,
attribution, decision, guardrail, activity, communication, tool-use, and latency detail. Token and
cost fields remain explicitly unavailable until provider-neutral per-session attribution is
durable; Marina does not infer them from activity.
