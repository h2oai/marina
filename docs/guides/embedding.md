# Embedding Marina

Run Marina from inside another application: the host starts it when needed (or keeps it running),
finds it through one file, talks to it over the usual protocols, and lets it go when idle. The
compiled `marina` binary and the source checkout behave the same way.

## The settings an embedder uses

| Setting | What it does |
| --- | --- |
| `MARINA_DATA_DIR=<dir>` | Everything the instance writes lives here: `marina.db`, keys, `assets/`, `scratch/`, model caches, and the settings editor's `.env`. Nothing is written to the working directory. Explicit path settings (`DB_PATH`, `ASSETS_DIR`, …) still win. |
| `WS_PORT=0` | Any free port. Internal self-calls follow the port actually bound. |
| `MARINA_SINGLE_PORT=true` | `/mcp` is served on the HTTP port and the log viewer stays off, so the instance uses one port. |
| `MARINA_IDLE_SHUTDOWN=15m` | Exit cleanly after 15 minutes with no external HTTP, WebSocket or MCP request. Health probes and Marina's own agents do not count; an open agent turn or background job postpones the exit. |
| `MARINA_PARENT_PID=<pid>` | Exit cleanly when that process is gone (an owner that died without stopping Marina). |
| `MARINA_SPEND_LEDGER=<file>` | Several instances (one per world, say) share one daily spend total and one `MARINA_DAILY_SPEND_CAP_USD`. |

## Finding a running instance

Once it is listening, Marina writes `<MARINA_DATA_DIR>/endpoint.json` (mode 600, replaced
atomically, removed on a clean exit):

```json
{
  "url": "http://127.0.0.1:42083",
  "mcpUrl": "http://127.0.0.1:42083/mcp",
  "pid": 336698,
  "apiKey": "mk_local_…",
  "version": "0.8.0",
  "world": "research",
  "startedAt": "2026-10-18T01:28:53.032Z",
  "idleShutdownMs": 900000
}
```

Treat a file whose `pid` is not running as absent. `apiKey` is present under the `local` profile
(the generated bearer for `/v1`, `/v1/memory` and `/mcp`); shared and public deployments bring
their own `MODEL_API_KEYS`. `marina endpoint --data-dir <dir>` prints the file with the key masked.

## Start on demand, reuse, let it go

1. Read `endpoint.json`; if its process is alive and `GET <url>/health` answers, use it.
2. Otherwise take a lock file in the data directory, check again, then start
   `marina start` detached with `MARINA_DATA_DIR`, `WS_PORT=0`, `MARINA_SINGLE_PORT=true` and
   `MARINA_IDLE_SHUTDOWN`, and wait for `endpoint.json` and `/health`.
3. Leave `MARINA_IDLE_SHUTDOWN` unset (or `0`) to keep it always on.

One world per instance: give each world its own data directory (`MARINA_WORLD=<slug>`), and the
same `MARINA_SPEND_LEDGER` so the cap covers them all. `marina worlds --json` lists the worlds
built into the binary.

## Protocols

- OpenAI-compatible `/v1` (chat, responses, forecast, memory) — see [Model API](model-api.md).
- MCP over HTTP at `mcpUrl`, or over stdio with `marina mcp-stdio --data-dir <dir>` for clients
  that only launch stdio servers.
- Agent Client Protocol for editors: `marina acp <name>` (targets `MARINA_URL`, else the instance
  in `MARINA_DATA_DIR`).
