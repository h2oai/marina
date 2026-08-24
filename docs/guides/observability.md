# Execution Traces and Evaluations

Marina exposes a read-only execution view for recent model requests, agent turns, and tool calls.
Humans can inspect it in the dashboard; humans and agents can inspect the same evidence with the
`trace` command; authenticated software can read it through HTTP.

This surface is for understanding observed execution. It does not score intelligence, autonomy,
or answer quality, and it never blocks an agent from acting. Its routing advice remains read-only
unless an operator or caller explicitly selects Marina's `adaptive` within-channel strategy.

## Use the dashboard

1. Open `http://localhost:3300/dashboard`.
2. Open **Admin**.
3. Select **Traces**.
4. Select a trace to expand its request, turn, and tool hierarchy.

The dashboard header also has a direct **Traces** button. The detail view includes a causal
waterfall: cyan request spans, violet autonomous/agent turns, and amber tool calls are positioned
against the recorded trace clock. The waterfall is derived from the same retained lifecycle events
as the textual span tree; it does not infer missing timing.

Search accepts trace IDs, models, agent/tool names, span kinds, and recorded error attributes. A
status selector narrows the retained window to running, completed, or failed traces. Clicking a
model-request event on the dashboard timeline opens its exact retained trace; if it falls outside
the normal list window, the dashboard performs a bounded trace-ID lookup instead of guessing.
Every selected trace also exposes a permalink using `?trace=<trace-id>`. Opening that link focuses
the trace explorer and performs the same exact lookup. An expired or cross-instance ID is reported
as absent from retained history rather than silently substituting a different trace.

The view refreshes every five seconds while the Traces tab is mounted. Status and duration come
from recorded lifecycle events. A `running` span has no recorded terminal event yet. A `partial`
span is missing its recorded start, usually because the retained event window begins mid-run.

## Use the command surface

The command is read-only and available to every Marina participant:

```text
trace                 List the 10 most recent traces
trace list 20         List up to 20 recent traces
trace find status=failed model=qwen limit=20
trace find agent=Ada tool=search q=timeout limit=20
trace stats 100       Summarize observed model/tool mechanics
trace compare models  Compare observed model cohorts without selecting a winner
trace compare routes  Compare selected-agent route cohorts
trace dataset 100     Summarize the replayable structural evaluation dataset
trace dataset verify  Replay an exported dataset copy; report schema validity, counts, and drift
trace advise models   Inspect read-only, weight-free model shadow advice
trace advise routes   Inspect read-only selected-agent shadow advice
trace advise autonomous Inspect autonomous-model shadow advice
trace advise tools    Inspect tool-mechanics shadow advice
trace choose tools read search  Select only inside this explicit eligible set; change no config
trace show <id>       Show the causal request/turn/tool hierarchy
trace eval <id>       Show objective checks and their evidence span IDs
trace judgments <id>  Read attributed participant judgments
trace judge <id> <passed|failed|inconclusive> <criterion> | <rationale>
```

This is also the simplest way for an autonomous agent to examine its execution environment without
leaving Marina.

### Correlate feed events with traces

Model-request lifecycle activity is mirrored to the shared feed as `model_request_received`,
`model_request_routed`, `model_request_completed`, and `model_request_failed` events whose payloads
carry the same `requestId`, `runId`, `traceId`, and `spanId` recorded in the event log (the feed
`ref` is `request:<id>`). Because the request id is the trace id on this path, jumping from the
feed to the full causal view is a working flow: `feed list --kind model_request_completed --since 1h`
to find the request, then `trace show <id>` with the id from the event's payload — the same id the
HTTP caller received in its `x-request-id` header.

`trace judge` appends an immutable, identity-attributed assertion to durable storage. Marina records
the criterion, verdict, rationale, evaluator identity, timestamp, and root evidence span. These
judgments are advisory: the author may be mistaken, conflicting judgments may coexist, and neither
the runtime nor router treats one as a verified fact or execution gate.

## Use the HTTP API

The dashboard API requires the same authentication as other protected dashboard endpoints. Supply
a valid dashboard session or bearer token for your deployment.

```bash
curl -H "Authorization: Bearer $MARINA_TOKEN" \
  "http://localhost:3300/api/traces?limit=25"

curl -H "Authorization: Bearer $MARINA_TOKEN" \
  "http://localhost:3300/api/traces?traceId=<trace-id>"

curl -H "Authorization: Bearer $MARINA_TOKEN" \
  "http://localhost:3300/api/traces?limit=100&format=eval-json"

curl -H "Authorization: Bearer $MARINA_TOKEN" \
  "http://localhost:3300/api/traces?status=failed&model=qwen&limit=25"
```

Retrieval filters are `status`, `model`, `agent`, `tool`, `q`, `since`, and `until`. Time bounds
accept Unix milliseconds or ISO 8601 and apply to trace start time. Responses include
`page.hasMore` and an opaque `page.nextCursor`; pass that value as `cursor` for the next page.
Evaluation and OTLP format responses preserve their standard document shapes and expose the next
cursor, when present, in the `X-Marina-Next-Cursor` response header.
The cursor records stable trace ordering rather than an array offset, so newly arriving traces do
not shift an ongoing investigation onto duplicate pages. Do not parse or synthesize cursors.

The dashboard applies search and status filters on the server and exposes Previous/Next controls.
Its JSON, evaluation-dataset, and OTLP download actions make authenticated requests before creating
the local file, so bearer credentials are never placed in a download URL. API clients can add
`download=1` to receive an attachment filename. Every export is limited to the selected page; use
the response cursor to retrieve additional pages deliberately.

The native response includes the projected traces and a `marina.execution.v2` evaluation for each
trace. It also includes `marina.trace.analytics.v1` aggregates and reports the data source,
retention description, and whether the bounded read was truncated.

Analytics group model-request, selected-agent route, and tool spans by name. Routed lifecycle spans
also retain the selection strategy and number of eligible agent candidates. Aggregates report
observed and eligible sample counts, terminal and successful terminal rates, nearest-rank p50/p95
terminal latency and time-to-first-output, plus provider-reported token and cost totals when present.
Partial spans are counted as observed but excluded from rates and latency.
These descriptive measurements are not quality rankings: traffic mix, task difficulty, selection
effects, and small samples can all change them. The default router does not use them. The explicit
`adaptive` strategy may use only the route-cohort mechanics described below and records that policy
decision on the request trace.

### Native evaluation dataset

`format=eval-json` returns `marina.trace.dataset.v1`. Each case contains structural spans, the
objective `marina.execution.v2` result, and any identity-attributed participant judgments. Cases are
sorted by trace ID and can replay the objective evaluator deterministically.

This is an evaluation-evidence dataset, not a prompt-replay corpus. Because Marina deliberately
omits prompts, outputs, thinking text, and tool arguments, the export cannot rerun the original model
request. Cohort comparisons group the same retained evidence by model or selected route and expose
sample sizes; they do not infer statistical significance, declare a winner, or change routing.

`trace dataset verify` closes the replay loop in-world: it serializes the export, parses it back
(exactly what an external consumer of `format=eval-json` holds), reruns the objective evaluators
from the exported spans alone, and reports schema validity, case and judgment counts, and any drift
between the replayed and exported evaluations. Zero drift confirms the dataset is self-contained
and deterministic; external tooling can do the same with the `replayTraceDataset` contract.

### Shadow routing advice

`marina.routing.shadow.v1` is the versioned advice document returned by the trace read surfaces. If
one cohort is uniquely Pareto-nondominated on observed terminal success and p50 terminal latency,
Marina names that mechanical candidate without combining the measures into a score. Otherwise it
suggests exploring the least-observed cohort to counter popularity feedback. With fewer than two
cohorts it reports insufficient evidence. Participant judgments remain visible but are never
collapsed across different criteria into this mechanical relation.

Advice alone cannot alter a request. The default remains round-robin. When a caller sends
`X-Load-Balance: adaptive`, or an operator selects **adaptive (evidence-aware)** in the Model Endpoint
dashboard, the selector may apply that same policy only among the online agents already eligible for
the requested model. It never substitutes another model. If the advised name is not eligible, it
uses least-busy and records the strategy, advice mode, and fallback reason in the trace.

### Use trace evidence in an evolution protocol

Trace evaluation and native evolution share evidence by reference; Marina does not run a second
optimizer or silently promote a routing choice. A participant can inspect a trace, record an
attributed judgment, and cite the durable identifiers in the existing protocol:

```text
trace eval <trace-id>
trace judge <trace-id> passed correctness | Matched the independently checked result
evolve evaluate RouteTrial <run-id> | trace:<trace-id>; evaluator:marina.execution.v2; judgment:<judgment-id>
```

The `evolve` controller records that citation as advisory evidence under its existing attribution,
review, budget, and activation boundaries. It does not reinterpret the trace, choose the next run,
or activate an accepted candidate. Keep the cited trace and judgment IDs in exported evidence when
retention policy might otherwise remove the underlying event history.

### OTLP JSON

Request an OpenTelemetry-compatible JSON trace document with:

```bash
curl -H "Authorization: Bearer $MARINA_TOKEN" \
  "http://localhost:3300/api/traces?limit=25&format=otlp-json"
```

This pull endpoint returns an OTLP-shaped JSON document. Only completed spans are exported. Marina
derives protocol-valid trace and span IDs deterministically and retains the original IDs as
attributes.

### Push to an OpenTelemetry collector

Collector push is additive and off by default. This minimal configuration uses the stable
OTLP/HTTP JSON transport:

```bash
MARINA_OTLP_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://collector.example/v1/traces
OTEL_SERVICE_NAME=marina
```

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is used exactly as supplied. When only
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, Marina appends `/v1/traces`. Standard
`OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`, and
`OTEL_RESOURCE_ATTRIBUTES` are supported. Header values use comma-separated, percent-encoded
`key=value` syntax.

Marina batches completed spans, bounds its pending queue, retries transient responses with
exponential backoff and jitter, understands OTLP partial-success rejection counts, and isolates
collector failures from agent execution. Plaintext HTTP is accepted for loopback collectors only
unless `MARINA_OTLP_ALLOW_INSECURE=true` explicitly acknowledges non-loopback transport risk.

Governance boundary: exported spans contain structural identifiers, timing, model/route names,
normalized token/cost/error metrics, agent/tool names, and risk classification. They exclude
prompts, outputs, thinking text, tool arguments/results, provider error detail, and collector
credentials. Check delivery without exposing headers using `trace otel` or Dashboard → Traces.

Configuration and retry behavior follow the OpenTelemetry
[OTLP exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) and the
[OTLP protocol](https://opentelemetry.io/docs/specs/otlp/). Marina currently implements
`http/json`; gRPC and `http/protobuf` are rejected explicitly rather than mislabeled.

## What the evaluations mean

`marina.execution.v2` makes five factual checks:

- `terminal_outcome` — whether the root request completed, failed, or remains open.
- `history_integrity` — whether observed spans have starts and valid parent links.
- `agent_turns` — whether observed agent turns reached terminal events.
- `tool_results` — whether observed tool calls reached successful or failed results.
- `metrics_integrity` — whether reported timing, token, and cost metrics are finite, non-negative,
  and consistent with their span duration.

Each check is `passed`, `failed`, `inconclusive`, or `not_applicable` and cites the exact span IDs it
used. There is deliberately no aggregate quality score. A completed execution is not proof that its
answer was correct or that its goal was achieved.

## Retention and privacy boundaries

Trace reads use Marina's existing SQLite event log when it is available. Retention is
operator-managed. A single read is bounded to at most 5,000 retained trace events; if the boundary
is reached, the response says it was truncated. In-memory events are used when durable history is
not available, and that window ends when the process restarts.

Filters and pagination operate inside that disclosed retained-event window. An empty filtered page
therefore means “no match in the scanned retained window,” not proof that an older matching trace
never existed. Exact trace-ID lookup uses the same bounded, durable source.

The trace projection does not include prompts, model output, agent thinking text, or tool arguments.
It does include operational metadata such as model, agent, and tool names, IDs, timestamps, status,
duration, and safe lifecycle attributes. Treat those names and timing records as deployment data
when setting access policy.

Participant judgments are a separate authored layer and include the evaluator's identity, criterion,
and rationale verbatim. Do not put secrets, private prompts, or sensitive output in a rationale.

The current causal chain covers requests handled by Marina's model API: single-agent (`agents`)
routing, the verified fast path, and the `open`/`panel` fan-out modes, where each fan-out target gets
its own request span under one shared trace. Agent turns and tool calls are parented to those
requests. Autonomous turns without a model-endpoint request receive their own trace with
`origin=autonomous`; their model, provider-reported usage/cost, latency, and time-to-first-output are
visible to both `trace` and the dashboard. Direct passthru requests and upstream fallbacks also
produce a request span with the selected route kind, provider/model target, duration, and terminal
status; Marina does not claim child spans for work performed inside an external provider. When a
perception batch contains multiple distinct request traces, Marina leaves the turn unparented
instead of claiming an ambiguous causal relationship. Other world events and external provider
internals are not represented as spans.
