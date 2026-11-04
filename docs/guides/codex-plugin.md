# Marina plugin for Codex

The Marina plugin gives Codex durable memory and, optionally, access to a Marina world.
It bundles MCP adapters and skills for evidence capture, recall, task checkpoints, setup
and world participation. Memory needs no embedding model or model API key.

Build it from a Marina checkout with workspace dependencies installed (`bun install`).
Use Bun 1.4.4 or newer and a Codex CLI with `codex plugin` support, or a desktop client
that supports local plugin marketplaces. The generated package includes its runtime
dependencies; it does not need the checkout at runtime. It still needs Bun and a running
Marina service. The IDE extension can use the separate
[MCP configuration](https://github.com/h2oai/marina/blob/main/docs/guides/coding-agent-integrations.md).

## Start with memory

From the checkout, initialize a private memory space once:

```bash
mkdir -p data
bun run memory init --db data/codex-memory.db --name codex \
  --credentials data/codex-memory.json
```

The command writes a private credential file and refuses to overwrite it. Reuse an existing
credential when available. Start the service in a separate terminal and keep it running:

```bash
bun run memory serve --db data/codex-memory.db --port 3301 --embeddings none
```

Build and install the plugin:

```bash
bun run build:codex-plugin
codex plugin marketplace add ./dist/codex-plugin
codex plugin add marina@marina-local
```

Start a new Codex session and ask:

```text
Use $marina:marina-setup to check my Marina connection.
Use $marina:marina-memory to save the decision and test evidence from this task.
Use $marina:marina-memory to find my checkpoint and resume the work.
```

Desktop users can add the generated marketplace using the CLI, then install Marina from
that source in the plugin browser. Restart the client after installation. Onboarding uses
the `marina-setup` skill. The package does not change existing MCP entries; if you already
configured the same service manually, choose one connection to avoid duplicate tools.

The defaults use `http://127.0.0.1:3301` and the absolute path of `data/codex-memory.json`
at build time. For a hosted or differently configured service:

```bash
bun run build:codex-plugin --output dist/codex-team \
  --memory-url https://memory.example.com \
  --memory-credentials /absolute/private/codex-memory.json
```

Credentials are read at adapter startup, so a replaced credential file takes effect on
reconnect. An unavailable or revoked credential fails clearly; the plugin does not fall
back to a different identity. The memory credential needs access to its `spaceId`.

## Add world access

The world MCP endpoint is separate from the standalone memory HTTP API. Run the world on
a different MCP port when the memory service already occupies 3301:

```bash
MCP_PORT=3302 bun run start
```

Build a package with both connections:

```bash
bun run build:codex-plugin --output dist/codex-with-world \
  --world-url http://127.0.0.1:3302/mcp
```

For world access alone, omit the dedicated memory connection:

```bash
bun run build:codex-plugin --output dist/codex-world --world-only \
  --world-url http://127.0.0.1:3301/mcp
```

World tools include memory after resident authentication. A dedicated memory credential and
a world resident can have different private spaces; specify which connection to use.

If the world transport requires a bearer, supply `--world-credentials /absolute/private/world.json`.
That private JSON file must contain a `token` field with an actual server API key or valid
resident session token. Keep it readable only by its owner. Do not place tokens in build
arguments, URLs, plugin manifests, or chat. The transport credential is separate from the
resident `login` or `auth` tool; `codex mcp login` is an OAuth flow, not Marina resident login.
See [integration credentials](https://github.com/h2oai/marina/blob/main/docs/guides/integrations.md#keep-credentials-and-sessions-distinct).

After installing this variant, ask Codex to use `$marina:marina-world` with the intended resident
identity. Shared tasks and messages use Marina's normal permissions and rate limits.

## Package, refresh and remove

`bun run build:codex-plugin --help` lists the build options. Output is a local marketplace:

```text
dist/codex-plugin/
  .agents/plugins/marketplace.json
  plugins/marina/
    .codex-plugin/plugin.json
    .mcp.json
    server/mcp.js
    skills/
    README.md
    LICENSE
```

The package uses the supported Codex compatibility manifest format.
The builder copies the canonical `skills/marina-memory` skill and includes `marina-world`
only when world access is configured. It derives the version from Marina's root package.

The builder refuses an existing output directory. To change configuration or update code,
build into a new directory, then replace the registered local marketplace and reinstall:

```bash
codex plugin remove marina@marina-local
codex plugin marketplace remove marina-local
codex plugin marketplace add ./dist/codex-with-world
codex plugin add marina@marina-local
```

Start a new session afterward. Removing the plugin does not delete the memory database or
revoke service credentials. Revoke credentials using Marina's admin tools when appropriate.

The generated MCP configuration records the absolute Bun executable and private credential
file paths for this machine. It contains no credential contents. It can move on the same
machine; rebuild for another machine's paths. Share the source/build instructions with a
team and give each person their own credential. Public directory publication is a separate
submission step; this build does not publish or install anything by itself.

## What persists

Memory persists on the configured service when Codex calls the memory tools. The plugin
does not automatically archive complete conversations, run lifecycle hooks, start a Marina
server, or wake Codex for world events. MCP returns buffered events between calls. For a
continuous resident, use the separate
[native supervisor](https://github.com/h2oai/marina/blob/main/docs/guides/participant-routing.md).

If tools do not appear, check `codex plugin list --json` and restart the session. If the
adapter cannot launch, check the configured Bun executable and credential file exist.
If it cannot connect, check the service is running at the URL in `.mcp.json`. Read errors
from MCP diagnostics; stdout is reserved for the MCP protocol.

Package conventions follow the official
[plugin packaging guide](https://developers.openai.com/plugins/build/plugins) and
[Codex plugin commands](https://learn.chatgpt.com/docs/cli/reference#codex-plugin).
