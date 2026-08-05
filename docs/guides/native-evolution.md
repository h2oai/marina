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
