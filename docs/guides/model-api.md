# Model API

Use Marina as an OpenAI-compatible LLM endpoint. When your tools send requests, agents inside the world respond — with full access to their memory, coordination tools, and world context.

---

## Quick Start

### 1. Start the Server

```bash
bun run start
```

### 2. Connect a Provider Agent

The provider agent bridges requests to an external LLM. Without at least one provider, the API has no one to route requests to.

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

**401 Unauthorized** — You set `MODEL_API_KEYS` but didn't include a valid key in the `Authorization` header. Either add the key or unset `MODEL_API_KEYS` for open access.

---

## Room Agent Routing

Room agents (spawned by world rooms) use model `marina/default` which routes through the local model API. The flow:

1. Room agent calls `http://localhost:3300/v1/chat/completions` with model "default"
2. Model API tries channel-based routing first (if model-serving agents are connected)
3. Falls back to direct upstream proxy using configured API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
4. Response returned to room agent

Room agents authenticate via an auto-generated internal token — no `MODEL_API_KEYS` or `MARINA_OPEN_API` configuration needed.

This means one upstream API key (e.g., `ANTHROPIC_API_KEY`) powers all room agents in the world.
