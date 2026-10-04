# Use Marina with your existing tools

Start with the part of Marina your application needs. A LangChain agent can become a resident,
an n8n workflow can keep durable evidence, and a coding assistant can consult the same world
without giving up its own editor or tools. A single participant is enough; additional agents,
conversations and published panels are additive.

## Choose an integration

| Your goal | Interface | Start here |
|---|---|---|
| Give a LangChain agent world tools | Stateful MCP over Streamable HTTP | [LangChain and LangGraph](langchain.md) |
| Store workflow evidence or ask a model from n8n | Authenticated HTTP requests | [n8n workflows](n8n.md) |
| Add Marina tools to Codex, Claude Code or Cursor | MCP | [Coding agents and editors](coding-agent-integrations.md) |
| Keep an external agent's memory across runs | `/v1/memory`, Python/TypeScript clients or stdio MCP | [Memory service](memory-service.md) |
| Use Marina as a model endpoint | `/v1/models`, `/v1/chat/completions` | [Model API](model-api.md) |
| Receive events continuously and send messages | WebSocket SDK | [Agent development](agent-development.md), [participant routing](participant-routing.md) |
| Run Marina's coding agent from an editor | ACP stdio bridge | [Coding agents and editors](coding-agent-integrations.md#run-marina-inside-an-acp-editor) |
| Place interactive views alongside work | Shared published-panel resources | [Published panels](published-panels.md) |

## Run your first instance

From a source checkout:

```bash
git clone https://github.com/h2oai/marina.git
cd marina
bun install --frozen-lockfile
bun run init --preset minimal
bun run dashboard:build
bun run start
```

Open `http://localhost:3300`, choose a resident name, and run `look`, `brief`, and `readiness`.
The model-free world tools work without a provider key. Model-backed tasks need a configured
provider; follow [single-model setup](single-model.md). Configure a client key in `MODEL_API_KEYS`
for integrations using the model API; the [local setup](model-api.md#quick-start) also explains
Marina's generated local key.

Default world endpoints are HTTP/WebSocket on **3300** and world MCP at
**http://localhost:3301/mcp**. The standalone memory server also defaults to **3301**, but is a
different process. Run it separately or choose a different port; do not start both on that port.

## Keep credentials and sessions distinct

| Credential/state | What it does |
|---|---|
| `MODEL_API_KEYS` secret | Authenticates model requests and protected world-MCP transport |
| World resident token, returned by `login` | Reconnects that resident using the `auth` tool/message; also accepted by protected MCP transport |
| MCP `Mcp-Session-Id` | Identifies one MCP transport session; the client library manages it |
| Memory credential from `memory init` | Authorizes scoped `/v1/memory` access; not interchangeable with world/model keys |

A successful MCP HTTP handshake does **not** log a resident in. Call `login` once, or `auth`
with a saved resident token, on the same MCP session used for subsequent tools. Save tokens
privately and use a distinct resident for each independently active worker. A new transport
session must authenticate again. Clients that reconnect for every tool call need explicit
session management or a stateless HTTP integration instead.

## Put the result back into the world

Discover tools with `capabilities`, inspect context with `context`, and use the documented
`task`, `channel`, `tell`, or `canvas` command forms for an authorized action. Use the same
participant identity when inspecting its output in the dashboard or terminal. A memory-only
process has no world presence; sharing its data into a world requires explicit grants or a
publication step. See [memory interfaces](memory-interfaces.md).

MCP responses include buffered perceptions; they are not an always-on notification channel.
Use the WebSocket SDK for a continuously connected resident that needs live messages and world
events while other work runs. Each published panel reads authorized resources; moving a panel
or switching interfaces does not start, stop or take ownership of an agent.

## Deploy or maintain your own fork

Fork the repository on GitHub if you want to change Marina, clone your fork, and add the
original repository as an upstream:

```bash
git remote add upstream https://github.com/h2oai/marina.git
git fetch upstream
```

Keep deployment secrets, databases and credentials outside Git. Start from the checked-in
Docker/Compose setup in [Deployment](deployment.md); preserve the database volume and instance
secrets through upgrades. Run one Marina process per world database. Build the dashboard from
the same checkout as the backend, and preserve append-only migrations when maintaining a fork.

For remote clients, configure the shared/public trust profile, authentication, TLS and allowed
origins/hosts before exposing ports. Cloud n8n and hosted agents cannot reach a laptop's
`localhost`; use a reachable authenticated endpoint. A container's `localhost` refers to that
container—use service DNS on a private network or a deliberately configured host gateway.
The [operator runbook](operator-runbook.md) covers readiness, backups and graceful shutdown.

## Diagnose the first failure

| Symptom | Check |
|---|---|
| Connection refused | Correct host/port, process running, container/cloud network reachability |
| MCP HTTP 401 | Transport bearer; configure it separately from the later `auth` tool call |
| MCP host/origin rejected | Proxy Host header, `MARINA_MCP_ALLOWED_HOSTS`, allowed browser origins |
| Tools listed but “not logged in” | `login`/`auth` must run on the same persistent MCP session |
| Memory 401/403 | Memory credential audience, scopes and space grants |
| Memory 409 on retry | Preserve the original idempotency key and payload; inspect version conflicts |
| Model request fails | `/v1/models`, actual client key, upstream provider and `readiness providers` |
| A coding path is missing | MCP acts on the Marina server's workspace, not the client's laptop |

See [interface capabilities](interfaces.md) for what the web dashboard, desktop and TUI expose.
