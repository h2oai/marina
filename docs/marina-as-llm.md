# Marina as an LLM endpoint

Marina serves an OpenAI- and Ollama-compatible HTTP API on the **same port as the
WebSocket server** (`WS_PORT`, default `3300`). Any OpenAI SDK, LobeChat,
OpenWebUI, or another Marina instance can use it as a model provider.

```
baseURL:  http://<host>:3300/v1
model:    marina           # → the instance's configured default model
auth:     Authorization: Bearer <token>
```

On startup Marina logs the exact baseURL / model / auth to paste into a client
(category `model-api`).

## 1. Is the endpoint functional?

Setting a default model is **not** sufficient on its own. A `/v1/chat/completions`
request is served when **either**:

1. an in-world agent is logged into the **`model` channel** (it acts as the
   provider — see [the provider bridge](#5-bridge-an-external-or-remote-model-in)), **or**
2. the **direct-upstream proxy** finds an API key for the chosen provider.

So a working external endpoint needs all three of:

| Need | How |
| --- | --- |
| A default model | `MARINA_DEFAULT_MODEL` env, or the dashboard Admin model picker (DB `default_model`, which overrides the env) |
| A provider key for it | env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or dashboard **Admin → Keys**. Without one you get `503 "No upstream LLM providers configured"`. |
| Caller auth | `MODEL_API_KEYS` (comma-separated bearer tokens), or `MARINA_OPEN_API=true` for local dev |

Two distinct "defaults" exist:

- `MARINA_DEFAULT_MODEL` (env, default `marina/default` — the self-referential
  loopback: this instance's own `/v1`, which routes to whichever upstream
  provider actually has a key) — what new agents spawn with and the
  last-resort fallback. No vendor is hardcoded; set a concrete
  `provider/model-id` to pin one.
- DB `default_model` (Admin model picker) — overrides the env var and is what the
  proxy honors for `marina` / `default` requests.

## 2. Quick start (local)

```bash
# minimal dev setup
export ANTHROPIC_API_KEY=sk-ant-...        # an upstream key
export MARINA_OPEN_API=true                # dev-only: skip caller auth
bun run start
```

```bash
# call it like OpenAI
curl http://localhost:3300/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"marina","messages":[{"role":"user","content":"hi"}]}'
```

For anything non-local, drop `MARINA_OPEN_API` and set `MODEL_API_KEYS`:

```bash
export MODEL_API_KEYS=sk-marina-abc123
# clients then send:  Authorization: Bearer sk-marina-abc123
```

## 3. Wire an agent to THIS instance

Agents on the same instance use the `marina` provider — this is what room agents
do, and it authenticates automatically with the internal token:

```
agent spawn alice model marina role scholar goal "..."
# aliases: marina/default, or a named channel variant: marina/scholar
```

`resolveModel("marina")` → `http://localhost:<WS_PORT>/v1`.

## 4. Wire an agent to ANOTHER Marina instance

Append `@<host-or-url>` to the `marina` model and (usually) a key:

```
# on instance A, target instance B's endpoint
agent spawn alice model marina@https://gpu.box:3300/v1 key remoteMarina role scholar
```

- The host can be a full URL (`https://gpu.box:3300/v1`), a scheme+host
  (`https://gpu.box`), or a bare `host:port` — Marina normalizes it to
  `<scheme>://<host>[:port]/v1`, defaulting to `http://` and appending `/v1`.
- **Auth:** a remote instance does **not** accept the local internal token. Add
  the remote's `MODEL_API_KEYS` token via **Admin → Keys** (provider `marina`)
  and pass it with `key <name>`. With no key the agent only works against a
  remote running `MARINA_OPEN_API=true` (and warns at spawn).

## 5. Bridge an external or remote model in

The inverse of #4: make an *external* model answer requests on a Marina
`model` channel, so local agents using `model: marina` are served by it. Run a
provider bridge (logs in, joins the `model` channel, forwards `model_request`s):

```bash
WS_URL=ws://localhost:3300 \
PROVIDER_URL=http://localhost:11434/v1 \   # any OpenAI-compatible upstream (e.g. Ollama)
PROVIDER_MODEL=llama3 \
PROVIDER_FORMAT=openai \
bun run src/sdk/examples/provider.ts
```

See `src/sdk/examples/provider.ts` (and `smart-provider.ts` for a memory-aware
variant) for the full set of env knobs.

## Surfaces served

`/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/health`, and the
Ollama routes `/api/tags`, `/api/chat`, `/api/generate` — all on `WS_PORT`.
Model-id aliases for drop-in clients are configured via `MARINA_COMPAT`
(see `src/net/compat-profiles.ts`).
