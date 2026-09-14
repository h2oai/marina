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
| `POST /v1/chat/completions` | first `system` message (prepended; created when absent) |
| `POST /v1/messages` (Anthropic) | the `system` field (string or block array) |
| `POST /api/chat` (Ollama) | first `system`-role message |
| `POST /api/generate` (Ollama) | the `system` string |
| `POST /v1/responses` | the `instructions` string |

The Ollama routes and `/v1/responses` proxy upstream in passthru mode (previously they only routed
to world agents). Ollama passthru always asks the upstream for a completed answer; a client that
requested Ollama's default streaming receives it as a buffered ndjson stream. `/v1/responses`
passthru is text-only (Responses tool schemas are not translated) and keeps `previous_response_id`
threading through the conversation channel.

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
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming) |

### Ollama-compatible

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tags` | List models |
| `POST` | `/api/chat` | Chat completion |
| `POST` | `/api/generate` | Text generation |

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

1. Room agent calls `http://localhost:3300/v1/chat/completions` with model "default"
2. Model API tries channel-based routing first (if model-serving agents are connected)
3. Falls back to direct upstream proxy using configured API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
4. Response returned to room agent

Room agents authenticate via an auto-generated internal token — no `MODEL_API_KEYS` or `MARINA_OPEN_API` configuration needed.

This means one upstream API key (e.g., `ANTHROPIC_API_KEY`) powers all room agents in the world.
