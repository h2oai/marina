# Autonomous Quality Loops

Marina can now learn from completed work and reconcile conflicting shared knowledge without waiting
for continuous operator scoring. These loops preserve agent autonomy: they change what receives
attention and how evidence is represented, but they do not prescribe an agent's plan or conclusions.

## Provenance-Aware Contradiction Resolution

Marina periodically compares active notes with the same normalized claim subject. Opposite-polarity
claims become a durable case when they come from different agents or involve shared memory pools.
The original notes remain intact.

```text
note conflicts
note conflicts resolved
note resolve 7 left The signed release record confirms the left claim
note resolve 8 both The claims describe different regions and are both locally valid
note resolve 9 neither The cited measurement was invalid for both claims
```

Resolution modes:

- `left` or `right` verifies the selected note and disputes the other.
- `both` verifies both notes when scope, time, or context makes them compatible.
- `neither` disputes both notes when neither is adequately supported.

Every resolution records the reviewing entity, rationale, timestamp, confidence adjustment, and
append-only verification entries. A typed `contradicts` edge remains in the knowledge graph, so later
agents can inspect both the disagreement and its adjudication.

The dashboard API offers equivalent authenticated surfaces:

```text
GET  /api/memory/contradictions?status=open
GET  /api/memory/contradictions?status=resolved
POST /api/memory/contradictions/:id/resolve
```

The POST body is `{ "resolution": "left", "rationale": "..." }`.

## Outcome-Based Attention Learning

Claiming a task starts an outcome session. Approval records success; rejection or lease expiry records
failure. Marina then adjusts the worker's durable attention threshold:

- Success: `+1`, capped at `75`, allowing slightly tighter filtering.
- Rejection or expiry: `-3`, floored at `20`, broadening context intake after failure.

The asymmetric update makes a failure more informative than one success. Terminal events are
idempotent: replaying an approval or rejection cannot train the same session twice. Directly
addressed events still pass the attention filter.

Operators retain explicit control:

```text
agent attention-mode Scout focused
agent attention-feedback Scout useful
agent attention-feedback Scout noise
agent status Scout
```

`agent status` displays the active threshold. Manual feedback supplements the automatic loop rather
than disabling it.

## Productivity Measurement

Productivity is measured at the outcome level, not by raw activity. A session spans task claim to
approval, rejection, or expiry and records:

- completed outcomes, successes, failures, and success rate;
- average and median completion latency;
- agent tool-call delta per outcome;
- direct messages involving the worker during the session, reported as handoffs;
- outcomes completed during the last seven days;
- daily 14-day trends and per-agent rankings.

```text
productivity
productivity agent Scout
productivity leaderboard
productivity trend
productivity primitives
productivity primitives Scout
```

`impact` is an alias for `productivity`. Before the first terminal task outcome, commands and the
dashboard correctly report an empty baseline rather than inferring productivity from message volume.

`productivity primitives` verifies whether participants actually use the shared world. Humans and
agents pass through the same canonical command evidence path. Agent model-tool calls are separate
provenance, so `think` or repeated tool selection cannot inflate meaningful activity. Arguments,
messages, prompts, memory text, and tool payloads are not stored. Summaries also compare meaningful
action volume in approved and failed task sessions.

The authenticated API is:

```text
GET /api/productivity
GET /api/productivity?entity=Scout
```

Responses contain `summary`, `leaderboard`, and `trend`. The Admin → Ops dashboard tab presents the
world summary alongside operational alerts and open contradiction count.

## Operational Behavior

The contradiction scan runs hourly as part of normal memory hygiene. Reading the contradiction API
or Ops inbox also refreshes cases, making new disagreements visible without waiting for the next
hourly interval. Failures in contradiction scanning or outcome telemetry never interrupt world ticks
or the underlying task lifecycle.

These records are durable and exportable. Schema version 58 adds `contradiction_cases`,
`productivity_sessions`, and privacy-safe `primitive_usage`, plus automatic attention counters on
agent configuration. Do not commit
generated `marina.db*` files; use Marina's export and snapshot tooling for state transfer.
