# Check what actually executed

A configured team, a successful answer, and paid model usage are different observations.
Use the evidence for the question you are asking:

| Question | Evidence |
| --- | --- |
| Was a model requested? | Upstream request attempts; failed attempts still count against a qualification budget |
| Did a model complete? | Completed model request lifecycle events with provider/model and usage |
| Did a resident work on this request? | Request-linked `agent_turn_end` events, including span links |
| Did residents exchange information? | Persisted requests/replies and a result that requires the exchanged information |
| Did collaboration help? | Comparable paired outcomes and independent replications against a simpler baseline |

`benchmark result <id>` shows trace-linked, window-only, unverified and unknown item counts.
Resident/model counts are unique items, not calls. A `marina/default` label is an agent's proxy
route; inspect the upstream lifecycle records for the resolved provider/model. Shared turns may
serve several concurrent requests. They establish involvement, not exclusive effort or causal
credit. `benchmark participants <benchmark>` reports association with outcomes.

`arena submissions` shows recorded formation steps when present. These are completion protocols;
they do not by themselves establish autonomous world-resident execution. Historical rows without
execution details remain unknown. Neither a configured roster nor zero recorded cost proves calls
occurred or did not occur. Statistical forecasts remain legitimate baselines.

## Preserve attribution when consolidating benchmark results

File results to the original running world's `/v1/benchmarks/runs` while its traces are available.
The server resolves participants from its own events. Remote participant claims are not trusted.
When importing local harness JSON that lacks those records, supply the original run database:

```bash
DB_PATH=ledger.db bun run benchmark:import result.json \
  --target-kind crew --target '{"crew":"answerer"}' \
  --source-db original-world.db --source-run original-run-id
```

Recover missing attribution on an already imported run:

```bash
DB_PATH=ledger.db bun run benchmark:import --attach-to imported-run-id \
  --source-db original-world.db --source-run original-run-id --dry-run
# Review the matched item count; omit --dry-run to attach the evidence.
```

The source opens read-only, in one snapshot, without migrations. A recovery requires exact matches
for the benchmark and every item ID, outcome, score and request trace ID. Conflicting participant
records abort the entire operation. Missing source evidence stays missing. Repeating the same
attachment is a no-op.

Migration 159 adds append-only evidence and provenance tables. Original run and item rows remain
unchanged, including scores, answer hashes, costs, validity, content hashes and replicate groups.
Readers project restored participants alongside original item outcomes. The evidence digest records
integrity of the normalized source attribution; it is not remote attestation. Only allowlisted
participant metadata is copied, never question, answer, prompt, credential or source configuration.
The source database must therefore be an operator-trusted artifact. Test recovery on a copy first.

## Run an opt-in live resident qualification

```bash
bun run qualify:agents:handoff --directory /private/new-handoff-attempt
```

This creates a disposable world. `OPENAI_API_KEY` must be available for the explicitly selected
`gpt-6-luna` route. It reserves at most $0.30 using conservative request-size pricing bounds,
allows at most 24 upstream attempts, and has a 180-second deadline. Reservations are not invoices.
No other upstream route or provider fallback is permitted. Do not point it at a production database.

The probe checks a zero-call arithmetic control and read-only novelty discovery, then starts two
native residents. One holds a fresh random fixture token. The other must request it through private
messaging and return it through the Model API. Passing requires the exact answer, persisted
messages, both residents linked to the request, completed upstream model calls, and clean shutdown.
An observer also sends a world command while the request is pending. Shutdown waits for terminal
upstream lifecycle events; cancelled follow-up calls remain visible as failures in the report. Reports and event records
remain in the new private directory, including failures. Do not publish those artifacts by default.

This qualifies one information handoff, not beneficial collaboration on hard tasks, unattended
reliability, or every deployment. Keep failed attempts and state changes between attempts. Inspect
`readiness autonomy`, `productivity`, task outcomes, and current traces on the world you actually
operate; a disposable probe does not establish its liveness.
