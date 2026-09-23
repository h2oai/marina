# Model API

Use Marina as an OpenAI-compatible LLM endpoint. When your tools send requests, agents inside the world respond — with full access to their memory, coordination tools, and world context.

## Direct upstream defaults

Marina can also proxy directly to a configured provider when no model agent serves the route.
The built-in OpenAI default is `gpt-5.6-luna`; OpenRouter uses `openai/gpt-5.6-luna`. Existing
provider priority and operator-selected models still apply. Override a provider with
`MARINA_DEFAULT_OPENAI_MODEL` or `MARINA_DEFAULT_OPENROUTER_MODEL`; a configured database
`default_model` selects the provider/model before fallback. Keys authorize upstream calls;
configure `MODEL_API_KEYS` separately for clients calling Marina.

Luna on a default route uses `reasoning_effort: "none"` to keep short requests inexpensive.
Explicit reasoning settings take precedence, and a direct request naming the model keeps its
provider-default effort when omitted. OpenAI Luna requires `max_completion_tokens`; Marina
translates a legacy `max_tokens` field when no modern limit is supplied. Conflicting limits
remain subject to provider validation. Other model request contracts are preserved.

Use a higher reasoning effort explicitly when the task warrants it, and compare outcomes and
total tokens on your own workload. See the [official Luna model reference](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
for current capabilities and pricing.

---

## Quick Start

### 1. Start the Server

```bash
bun run start
```

### 2. Connect a Provider Agent

The provider agent bridges requests to an external LLM. This is an alternative to direct upstream
proxying with configured provider keys.

```bash
# Using a local Ollama instance
PROVIDER_URL=http://localhost:11434/v1 PROVIDER_MODEL=llama3 bun run src/sdk/examples/provider.ts

# Using OpenAI
PROVIDER_URL=https://api.openai.com/v1 PROVIDER_KEY=sk-your-key PROVIDER_MODEL=gpt-4 bun run src/sdk/examples/provider.ts
```

### 3. Send a Request

```bash
curl http://localhost:3300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"marina","messages":[{"role":"user","content":"hello"}]}'
```

You'll get a standard OpenAI-format response.

---

## Use with Your Tools

### aider

```bash
OPENAI_API_BASE=http://localhost:3300/v1 OPENAI_API_KEY=sk-any aider --model openai/marina
```

### Cursor / Continue.dev

Add a custom model provider in your IDE settings:

- **Base URL**: `http://localhost:3300/v1`
- **API Key**: any value (or a real key if you've set `MODEL_API_KEYS`)
- **Model**: `marina`

### LiteLLM (Python)

```python
import litellm

response = litellm.completion(
    model="openai/marina",
    api_base="http://localhost:3300/v1",
    api_key="sk-any",
    messages=[{"role": "user", "content": "hello"}],
)
```

### Ollama-compatible clients

Marina also serves Ollama-compatible endpoints:

```bash
curl http://localhost:3300/api/chat \
  -d '{"model":"marina","messages":[{"role":"user","content":"hello"}]}'
```

---

## Streaming

Request streaming with `"stream": true`:

```bash
curl http://localhost:3300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"marina","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

Responses arrive as Server-Sent Events in the standard OpenAI format.

### Responses API streaming

`POST /v1/responses` with `"stream": true` is incremental on both endpoint modes:

- **passthru** — the upstream is asked for chat-completions SSE (with `stream_options.include_usage`)
  and re-encoded as it arrives: each `delta.content` is one `response.output_text.delta`;
  `delta.tool_calls` fragments become `function_call` output items
  (`response.output_item.added` → `response.function_call_arguments.delta` …
  `response.function_call_arguments.done` → `response.output_item.done`); the trailing `usage`
  chunk lands on the record. The response cache is bypassed for streams.
- **agents** — every `model_response_chunk` the routed agent sends is one delta.

Event sequence, with a running `sequence_number`:

```
response.created → response.in_progress
→ response.output_item.added (message) → response.content_part.added
→ response.output_text.delta …                     (one per upstream/agent chunk)
→ response.output_item.added (function_call) → response.function_call_arguments.delta …
→ response.output_text.done → response.content_part.done → response.output_item.done
→ response.function_call_arguments.done → response.output_item.done   (per call, output order)
→ response.completed
```

The `response` payload of `response.completed` is byte-identical to the non-streaming body and to
`GET /v1/responses/:id`. An upstream transport failure mid-stream ends with `response.failed`
(`error.code: "upstream_error"`) and stores nothing; an agent timeout ends with `response.failed`
(`error.code: "timeout"`). A stream request answered whole (a cache hit, a provider that ignored
`stream`) still yields the standard sequence with a single delta.

### Responses API tools

`POST /v1/responses` in passthru mode forwards tools both ways (`src/net/responses-tools.ts`). The
Responses surface speaks flat function tools and typed input items; every upstream speaks
chat-completions, and the Anthropic proxy translates chat tools onward, so a Responses client with
tools works end-to-end against OpenAI-compatible **and** Anthropic upstreams.

| Responses request | Chat-completions request sent upstream |
|-------------------|----------------------------------------|
| `tools[{ type: "function", name, description, parameters, strict? }]` (flat) | `tools[{ type: "function", function: { name, description, parameters, strict } }]` |
| `tool_choice: "auto" \| "none" \| "required"` | same string |
| `tool_choice: { type: "function", name }` | `{ type: "function", function: { name } }` |
| `parallel_tool_calls` | `parallel_tool_calls` (Anthropic: `disable_parallel_tool_use` when `false`) |
| `input` string / `{ role, content }` / `{ type: "message", … }` (`input_text` / `output_text` / `text` parts) | `{ role, content: text }` |
| `input[{ type: "function_call", call_id, name, arguments }]` | `assistant.tool_calls[{ id: call_id, type: "function", function: { name, arguments } }]` (consecutive calls share one assistant message) |
| `input[{ type: "function_call_output", call_id, output }]` | `{ role: "tool", tool_call_id: call_id, content: output }` |

| Chat-completions reply | Responses output |
|------------------------|------------------|
| `message.tool_calls[{ id, function: { name, arguments } }]` | `{ type: "function_call", id: "fc_…", call_id: id, name, arguments, status: "completed" }` — `call_id` is the upstream id verbatim |
| `delta.tool_calls` fragments (stream) | `response.output_item.added` (`function_call`) → `response.function_call_arguments.delta` … `response.function_call_arguments.done` → `response.output_item.done` |

Tool-loop continuation works in both client styles. A client that manages its own state resends the
whole `input` list (message, `function_call`, `function_call_output`). A client that threads with
`previous_response_id` sends only the `function_call_output` items: the stored prior response
carries the calls, and they are re-attached as `assistant.tool_calls` ahead of the `role: "tool"`
results so the upstream sees every result paired with its call.

**Refused, never dropped.** Hosted Responses tool types have no chat-completions equivalent —
`web_search`, `web_search_preview`, `file_search`, `computer_use_preview`, `code_interpreter`,
`image_generation`, `mcp`, … — and are refused before any upstream call with
`400 { error: { code: "unsupported_parameter", param: "tools[i].type" } }`. A `tool_choice` type
outside `auto` / `none` / `required` / `function` is `param: "tool_choice.type"`; an input item type
outside `message` / `function_call` / `function_call_output` is `param: "input[i].type"`. A function
tool without a `name` (or a `function_call_output` without a `call_id`) is an ordinary 400 with the
offending `param`. Agents mode still refuses `tools` altogether (`param: "tools"`) — in-world agents
answer in text.

---

## Multi-Turn Conversations

Use the `X-Conversation-Id` header to maintain context across requests:

```bash
# First message
curl http://localhost:3300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Conversation-Id: my-session-1" \
  -d '{"model":"marina","messages":[{"role":"user","content":"What is Marina?"}]}'

# Follow-up — the agent remembers the previous exchange
curl http://localhost:3300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Conversation-Id: my-session-1" \
  -d '{"model":"marina","messages":[{"role":"user","content":"Tell me more about the memory system"}]}'
```

Conversation history is retained for the duration of the server session.

---

## Model Routing

The `model` field controls which agents handle the request. Different model IDs route to different channels:

| You Send | Routes To Channel | Use Case |
|----------|------------------|----------|
| `marina` | `model` | Default — general purpose |
| `marina:scholar` | `model-scholar` | Specialist scholar agents |
| `marina:code` | `model-code` | Coding specialist agents |
| `marina:<name>` | `model-<name>` | Any custom specialist |

To set this up, have your provider agent join the right channel:

```bash
# This agent handles "marina:scholar" requests
AGENT_NAME=Scholar MODEL_CHANNEL=model-scholar bun run src/sdk/examples/provider.ts
```

Multiple agents in the same channel means requests are load-balanced across them.

Choose the within-channel strategy with `X-Load-Balance`. The header is honored on the routes that
select a single agent: `POST /v1/chat/completions` (in the default `agents` endpoint mode),
`POST /v1/responses`, `POST /api/chat`, and `POST /api/generate`. When the header is absent, these
routes use the operator-configured strategy from **Admin → Model Endpoint** (default
`round-robin`). The `open` and `panel` endpoint modes fan out to all channel members by design —
no within-channel selection happens, so the header has no effect there.

- `round-robin` (default) rotates across eligible online agents.
- `least-busy` selects the eligible agent with the fewest in-flight requests.
- `adaptive` explicitly opts into Marina's observable evidence policy. It can select only among the
  online agents already eligible for the requested `model`; it never changes the requested model.
  A unique Pareto candidate or least-observed exploration candidate may be applied. If no advised
  candidate is eligible, Marina falls back to `least-busy` and records the reason in the trace.

```bash
curl http://localhost:3300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Load-Balance: adaptive" \
  -d '{"model":"marina","messages":[{"role":"user","content":"hello"}]}'
```

Adaptive routing is never enabled implicitly. Inspect its recorded strategy, evidence mode, and
fallback reason in **Admin → Traces** or with `trace show <id>`. Every agent-routed response —
streaming or not — returns the traced request identity in its `x-request-id` header; that value is
the trace id to pass to `trace show`.

---

## Memory injection, receipts and response cache

In **passthru** endpoint mode (Admin → Model Endpoint, or `setEndpointConfig({ mode: "passthru" })`)
Marina is a memory gateway in front of any upstream model: point an OpenAI SDK, the Anthropic
SDK, an Ollama client, or an editor (Cursor, Claude Code, Codex) at Marina's base URL and every
identified caller's requests are enriched with that caller's own Marina memory before they reach
the upstream provider.

### Surfaces

Injection behaves identically on all four proxy surfaces; only the *slot* differs, because each
protocol carries system context in its own place:

| Surface | Native slot the memory lands in |
|---------|--------------------------------|
| `POST /v1/chat/completions` | its own `system` message right after the caller's leading system/developer messages (index 0 when there are none) |
| `POST /v1/messages` (Anthropic) | appended as the LAST text block of `system` (a string system becomes a two-block array) |
| `POST /api/chat` (Ollama) | its own `system`-role message after the caller's |
| `POST /api/generate` (Ollama) | appended to the `system` string |
| `POST /v1/responses` | its own `system` message after the caller's `instructions` on the upstream chat body |

The caller's own system text always comes **first** and byte-identical; the memory block is the
volatile tail. That ordering is what lets provider prefix caches (and the Anthropic breakpoints
below) keep the stable prompt cached while the relevance-gated memory block changes.

The Ollama routes and `/v1/responses` proxy upstream in passthru mode (previously they only routed
to world agents). Ollama passthru always asks the upstream for a completed answer; a client that
requested Ollama's default streaming receives it as a buffered ndjson stream. `/v1/responses`
passthru translates Responses `tools`/`tool_choice` and `function_call`/`function_call_output` items
to chat tools upstream and renders upstream `tool_calls` as `function_call` output items (see
[Responses API tools](#responses-api-tools)), streams incrementally when asked (see
[Responses API streaming](#responses-api-streaming)), and keeps `previous_response_id` threading
through the conversation channel.

### Identity — who gets memory

The caller is mapped to a Marina entity fail-closed (`src/net/passthru-context.ts`):

- `MODEL_API_KEYS=secret:Alice` — a **bound** key, confined to entity `Alice` (lazily created).
- `MODEL_API_KEYS=secret:*` — an operator key that may name an **existing** entity with
  `X-Marina-Agent: <name>`. A header can never create an entity.
- Anything else collapses onto the shared anonymous `passthru` entity, which never receives
  injection, never has its transcripts captured, and never caches.

Injection is **on** for identified callers under the `local` trust profile. Elsewhere it is
opt-in: the entity property `passthruContext: true`, or — for bound keys only —
`X-Marina-Context: on`. A bound key can opt a single request out with `X-Marina-Context: off`;
name-mapped targets ignore the header entirely (their stored consent stands). The old behaviour
where a client-supplied `[marina:shared-world-context]` marker suppressed injection is gone.

### What is injected, in what order

The addendum comes from `buildUnifiedContext` (scope `all`) for the caller's latest user message,
plus the world sections the entity may read (member / `MARINA_PASSTHRU_SHARED_POOLS` pools, its
channels, the chronicle), framed as untrusted:

```
[marina:shared-world-context]
Untrusted, read-only Marina context; verify before acting:
Marina memory for Alice.
Own memory [skills] (…): …                ┐ stable — renders first so a provider
Own memory [trusted] (#12 imp=8 verified): … │ prefix cache (Anthropic/OpenAI) can hit
Own memory [evidence] (record r_1 v1): …   ┘
Own memory [proposal] (…): …               ┐
Own memory [unverified — own notes, …] (…): … │ volatile — renders last
Shared pool …  /  Channel …  /  Chronicle: … ┘
```

Tier order and separators are byte-stable across calls: the same memory state yields the same
bytes on every surface.

**Budget.** `MARINA_PASSTHRU_INJECT_BYTES` (default 2048, clamped 256–65536) bounds the whole
addendum including the framing lines. Override per bound key with the entity property
`passthruInjectBytes`. Items that do not fit are cut with a visible marker or dropped, and the
receipt flags `truncated: true`.

**Capture.** Each identified, injected exchange is recorded once in the caller's own memory as a
`[passthru] User/Assistant` observation (one pair per request). Identical exchanges are captured
once per entity per 24h window, so retries and replays do not multiply notes.

### Memory receipts

Every injected response carries `x-marina-memory-receipt` — compact JSON
(`marina.memory.receipt.v1`, ≤ 2 KB) listing the tiers, ids (record versions / source hashes for
durable evidence), bytes per tier, the budget, the bytes used, whether it was truncated, and any
degraded tiers. When the full receipt would exceed 2 KB the header carries
`{ schema, requestId, truncatedHeader: true }`; the full receipt is always on the trace:

```bash
curl -si http://localhost:3300/v1/chat/completions -H "Authorization: Bearer secret" \
  -d '{"model":"marina","messages":[{"role":"user","content":"what port does Amber use?"}]}' \
  | grep -i -e x-request-id -e x-marina-memory-receipt
```

The receipt's `requestId` equals the response's `x-request-id`; `trace show <id>` renders a
**Memory** section (entity, budget, used bytes, one line per tier with ids), and the native
`GET /api/traces` format exposes it as the span attribute `memoryReceipt`. Receipts are on in every
trust profile — YOLO applies to permissions, never to records.

### Response cache

An exact-match completion cache stored on the durable memory service's pinned result cache
(`cache_put` / `cache_get`, see [memory-service.md](memory-service.md)). Opt in per bound key with
the entity property `passthruResponseCache: true`, or under the `local` profile with
`MARINA_PASSTHRU_RESPONSE_CACHE=on`. `MARINA_PASSTHRU_RESPONSE_CACHE_TTL_MS` sets the entry
lifetime (default 1h).

- **Key**: SHA-256 of the canonicalized *effective* request — model identity, messages /
  instructions **after** injection, tools and sampling parameters. Stream flags and client tags
  are excluded. A different memory context is therefore a different key.
- **Pins**: the receipt's durable `[evidence]` records (by version) and captured sources (by content
  hash). The service refuses an empty pin set, so a completion is cached **only when at least one
  pinned record or source shaped the prompt** — legacy notes and proposals alone never cache.
  Revising or forgetting a pinned record, or any change to the space's evidence generation,
  invalidates the entry; forgetting deletes stored values.
- **Never cached**: streaming responses, tool-call responses, non-2xx responses, and anything from
  the shared anonymous identity. Identities are isolated by construction (one resident space per
  world account).
- **Hit**: the cached completion is returned with `x-marina-cache: hit`, a fresh `x-request-id`,
  and the *original* receipt of the request that produced it.
- **Expect** the first repeat after a *new* exchange to miss: the captured transcript adds an
  `[unverified]` line to the injected context, changing the effective request. From then on,
  identical requests hit.
- **Requires** the bound entity to have a durable world account (it has logged into the world at
  least once). Without one, injection still works from legacy tiers, and the cache is a silent miss.
- Semantic (similarity-based) caching is explicitly out of scope: the key is byte-exact so a hit
  can never change an answer.

---

## Authentication

By default, the API is open (no key required). To require authentication:

```bash
MODEL_API_KEYS=sk-key-1,sk-key-2 bun run start
```

Then include the key:

```bash
curl http://localhost:3300/v1/chat/completions \
  -H "Authorization: Bearer sk-key-1" \
  -H "Content-Type: application/json" \
  -d '{"model":"marina","messages":[{"role":"user","content":"hello"}]}'
```

---

## Available Endpoints

### OpenAI-compatible

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming, tool calling) |
| `POST` | `/v1/responses` | Responses API with server-side conversation state (`stream: true`, function tools) |
| `GET` / `DELETE` | `/v1/responses/:id` | Read / delete a stored response |
| `POST` | `/v1/messages` | Anthropic Messages (Claude Code, Anthropic SDKs) |
| `GET` | `/v1/health` | Liveness |
| `POST` | `/v1/embeddings`, `/v1/completions` | **Not served** — explicit 404 `{ error: { code: "not_found" } }` |

### Ollama-compatible

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tags` | List models (`name`, `model`, `digest`, `size`, `details`) |
| `GET` | `/api/version` | `{ "version": "<marina version>" }` |
| `GET` | `/api/ps` | Running models — the configured default route |
| `POST` | `/api/show` | Model details (`modelfile` / `parameters` / `template` are empty strings — Marina models are routes, not weights) |
| `POST` | `/api/chat` | Chat completion |
| `POST` | `/api/generate` | Text generation |
| `POST` | `/api/embed`, `/api/embeddings` | **Not served** — explicit 404 |

The `digest` in `/api/tags` is a stable SHA-256 of the model id, so Ollama clients that key their
cache on it see the same model across restarts.

---

## Compatibility contract

### Error envelope

Every error is the OpenAI nested shape with a **string `code`** SDKs can branch on
(`src/net/openai-errors.ts`):

| `code` | When |
|--------|------|
| `invalid_api_key` | 401/403 — missing, wrong or upstream-rejected credential |
| `model_not_found` | 404 for an unknown model id (`/v1/chat/completions`, `/api/show`) |
| `not_found` | 404 for anything else (unserved paths, unknown response id) |
| `context_length_exceeded` | 400 whose reason names the context window / prompt length |
| `rate_limit_exceeded` | 429 (Marina's per-IP limiter or the upstream) |
| `unsupported_parameter` | 400 for a parameter the route cannot honor — `param` names it |
| `invalid_request_error` | any other 400 |
| `upstream_error` | 502/503/504 from the provider chain |
| `server_error` | 500 |

`unsupported_parameter` replaces silent dropping. **Agents / open / panel modes** refuse
`tools`, `functions`, `n > 1` and a non-text `response_format` (in-world agents answer in text over
a channel). **Anthropic-backed passthru** refuses `n > 1`, `response_format: { type: "json_object" }`
(use `json_schema` — it is translated to Anthropic `output_config`), non-`function` tool types and
audio/file content parts.

### Tool calling on Anthropic-backed passthru

When the passthru upstream is Anthropic (`anthropic/<model>`), the OpenAI body is translated
faithfully (`src/net/anthropic-tools.ts`):

| OpenAI request | Anthropic Messages |
|----------------|--------------------|
| `tools[{type:"function", function:{name, description, parameters}}]`, legacy `functions[]` | `tools[{name, description, input_schema}]` |
| `tool_choice` `"auto"` / `"none"` / `"required"` / `{function:{name}}` | `{type:"auto"}` / `{type:"none"}` / `{type:"any"}` / `{type:"tool", name}` |
| `parallel_tool_calls: false` | `tool_choice.disable_parallel_tool_use: true` |
| `stop` (string or array) | `stop_sequences` |
| `max_tokens` / `max_completion_tokens` | `max_tokens` (default 4096) |
| `user` | `metadata.user_id` |
| `reasoning_effort: "minimal|low|medium|high|xhigh"`, or `thinking: "<level>"` / `{effort}` / `{type:"enabled", budget_tokens}` | `thinking: {type:"enabled", budget_tokens}` — budgets 1024 / 2048 / 8192 / 16384 (xhigh → 16384, pi-ai's table); `temperature` and `top_p` are **omitted** (Claude rejects them while thinking); `max_tokens` is raised to `budget + 1024` when the client's cap would not fit the budget, and a client cap that does fit clamps the budget to leave 1024 answer tokens. `reasoning_effort: "none"` / `thinking: {type:"disabled"}` = off |
| `response_format: {type:"json_schema", json_schema:{schema}}` | `output_config.format: {type:"json_schema", schema}` |
| system / developer messages | `system[]` text blocks, in order (memory injection is the first block) |
| user `text` / `image_url` parts | `text` / `image` blocks (data URLs → base64 source) |
| assistant `tool_calls` | `tool_use` blocks |
| `role: "tool"` results | `tool_result` blocks; consecutive results grouped into ONE user message |

| Anthropic response | OpenAI |
|--------------------|--------|
| every `text` block (thinking skipped) | `message.content` |
| `tool_use` blocks | `message.tool_calls`, `finish_reason: "tool_calls"` |
| `end_turn` / `stop_sequence` / `max_tokens` / `refusal` | `stop` / `stop` / `length` / `content_filter` |
| streaming `content_block_start`/`input_json_delta` | `delta.tool_calls[{index, id, function:{name, arguments}}]` fragments |
| `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `usage.prompt_tokens`; cached share in `prompt_tokens_details.cached_tokens`; raw `cache_read_input_tokens` / `cache_creation_input_tokens` kept |

`readiness providers` sends a **tool-call probe** to Anthropic and OpenAI providers in addition to
the text probe: one tiny tool, and the reply must contain a structured `tool_calls` entry naming it
with the nonce in its arguments. A provider that answers in text fails with `tool call dropped`.

### Prompt caching

- **`/v1/messages` clients** (Claude Code, Anthropic SDKs): when the upstream is Anthropic the
  client's native body is forwarded **verbatim** — `cache_control` on system, tool and message
  blocks, `thinking`, `tool_choice`, `metadata`. Memory injection lands as the LAST system block.
- **OpenAI-completions clients** (pi-ai with `cacheControlFormat: "anthropic"`, or any client that
  puts `cache_control` on system content parts or on a tool): the markers are carried onto the
  translated Anthropic `system` blocks and tools.
- **Auto-cache** — `MARINA_ANTHROPIC_AUTO_CACHE` (default `true` under the `local` trust profile,
  `false` otherwise) places `cache_control: { type: "ephemeral" }` breakpoints in this order,
  within Anthropic's limit of four (the client's own markers count against it):
  1. the **last stable system block** — the caller's own prompt (the block before the memory block
     when memory was injected, else the last block);
  2. the **last system block** (the memory block) — only when the client set no marker anywhere;
  3. the **last tool** — only when the client set no marker anywhere.

  A client's markers are always preserved; with any present, the proxy adds only breakpoint 1 and
  only if that block has none. A native `/v1/messages` body whose last system block is already
  marked is forwarded untouched.
- **OpenAI upstreams**: Marina forwards its traced `x-request-id` as a request header and leaves
  `prompt_cache_key` in the body untouched.
- Cache counters (`cache_read_input_tokens`, `cache_creation_input_tokens`,
  `prompt_tokens_details.cached_tokens`) land on the `model_request_lifecycle` completed event as
  `cacheReadTokens` / `cacheWriteTokens`, so `trace show <id>` shows cache hits per request.

### Cost and cache headers

Every proxied reply carries:

| Header | Value | Streams |
|--------|-------|---------|
| `x-marina-upstream-model` | the served `provider/model` (e.g. `anthropic/claude-sonnet-5`) | yes |
| `x-marina-cache-read-tokens` | cache-read input tokens | no |
| `x-marina-cache-write-tokens` | cache-write (creation) input tokens | no |
| `x-marina-cost-usd` | list-price cost of the call in USD | no |

Streams cannot carry token headers (they are sent before the usage is known); their tokens ride the
final SSE `usage` chunk and the lifecycle `completed` event. Cost is the upstream's own `usage.cost`
when it reports one (OpenRouter), else computed from pi-ai's built-in model catalog for the served
model; it is omitted — never `0` — for models the catalog does not list (local runtimes). The same
`costUsd` is on the lifecycle `completed` event, so agents running on `marina/default` are priced by
the model that actually served them.

Usage bodies extend `prompt_tokens_details` with `cache_creation_tokens` (cache writes) and, with the
same value, `cache_write_tokens` — the field pi-ai's OpenAI-completions client reads. Responses API
bodies mirror it as `usage.input_tokens_details.cache_creation_tokens`.

### Usage

`usage` is reported only when known: from the upstream in passthru mode, or summed from the
answering agent's traced `agent_turn_end` spans in agents mode. It is **omitted** (never zero-filled)
when no turn reported tokens.

---

## Troubleshooting

**"No agent available"** — No agent is connected to the target channel. Start a provider agent.

**Timeout after 30 seconds** — The agent is slow to respond. Check that your external LLM provider is reachable.

**401 Unauthorized** — Configure `MODEL_API_KEYS` and send a matching bearer token. For local
development only, restart with `MARINA_OPEN_API=true`; merely leaving the key list unset does not
open the API.

---

## Room Agent Routing

Room agents (spawned by world rooms) use model `marina/default` which routes through the local model API. The flow:

1. Room agent calls `http://localhost:3300/v1/chat/completions` with model "default" (with its tools)
2. Because the request carries the internal token, the model API **always** proxies it straight to
   the configured upstream (ANTHROPIC_API_KEY, OPENAI_API_KEY, … or the pinned passthru model) —
   in every endpoint mode. Marina's own agents are consumers of the upstream, never participants
   of the `agents` / `open` / `panel` routes, so they are never handed to another agent and never
   hit the agents-mode `400 unsupported_parameter: tools`.
3. Response returned to room agent, with `x-marina-upstream-model` and (non-streaming)
   `x-marina-cost-usd` headers; the lifecycle events carry `routeKind: "passthru"`,
   `routeReason: "internal"`.

Room agents authenticate via an auto-generated internal token — no `MODEL_API_KEYS` or `MARINA_OPEN_API` configuration needed.

This means one upstream API key (e.g., `ANTHROPIC_API_KEY`) powers all room agents in the world.
