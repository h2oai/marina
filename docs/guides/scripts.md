# Scripts Reference

Every `bun run <script>` in the root `package.json`, grouped by what you are trying to do. Most
scripts print their own `--help`; the linked guide is the long form.

## Run Marina

| Script | What it does |
|---|---|
| `start` / `dev` | Start the server (`src/main.ts`). On the local profile it prints a ready-to-use `OPENAI_BASE_URL` / `OPENAI_API_KEY` line. |
| `init` | Interactive first-run setup: writes `.env` (provider keys, profile, world). See [Getting Started](getting-started.md). |
| `code [dir]` | Folder-scoped Marina in agentic Code Mode for that directory — "Claude/Codex in any folder". See [Coding](coding.md). |
| `clean` | Delete the local database and scratch files. Irreversible; stop the server first. |
| `prune-agent-users` | Remove `users` rows left behind by agents that were removed or scaled down. |
| `build` | Bundle the server, the memory importer and the browser memory SDK into `dist/`. |
| `dashboard:dev` / `dashboard:build` | Vite dev server / production build for the dashboard. |
| `usecase-ui:dev` / `usecase-ui:build` | The example use-case UI (`examples/usecase-ui`). |

The terminal client is `bun run scripts/connect.ts <name>` (`-c "<command>"` for one-shot,
`--port 3400` or `--url ws://host:3400` for another instance). See [Connecting](connecting.md).

## Ask, forecast, compete

| Script | What it does |
|---|---|
| `forecast "<question>"` | Forecast any question with no server running: a probability or a number, with sources, verified figures, each analyst's answer and the cost. See [Forecasting](forecasting.md). |
| `arena <sub>` | Social Simulation Arena operator CLI: `keygen`, `registration`, `status`, `rounds`, `show`, `submit`, `backtest`, `evaluate`, `research`, `shadow run\|list\|score`, `discover`, `signals`. See [Arena](arena.md). |

## Memory service

| Script | What it does |
|---|---|
| `memory <sub>` | Standalone memory service admin: `init`, `serve`, `revoke`, `backup`, `restore`, `rotate-backups`, `compact-receipts`, transfers. See [Memory Service](memory-service.md). |
| `memory:mcp` | Memory as a stdio MCP server for coding clients. See [Memory extensions](memory-extensions.md). |
| `build:memory` | Build the browser memory SDK (`dist/memory.js`). |

## Develop and test

| Script | What it does |
|---|---|
| `test` | Full backend suite, parallel workers. |
| `test:serial` | The same suite in one process (for order-dependent debugging). |
| `test:fast` | Engine-free subset, ~10 s — the pre-commit loop (`--check` reports drift). |
| `test:shard I N` | Time-balanced shard I of N (CI runs 3). See [Testing](testing.md). |
| `test:coverage` / `check:coverage` | Suite with coverage, then the per-directory line floor (`--strict` gates). |
| `test:canvas:browser` | Build the dashboard and run the Playwright canvas suite. |
| `typecheck` / `lint` / `format` | `tsc --noEmit`, Biome check, Biome auto-format. |
| `check:versions` / `check:overrides` | Every `package.json` matches the root version; audit root `overrides`. |
| `prepack` | Dashboard and memory SDK build before packing. |

## Evaluate and qualify

These make claims measurable. Provider-backed ones spend money; each says so and most take a
budget flag. Write their reports outside the public checkout.

| Script | What it does |
|---|---|
| `bench` / `bench:ui` | Academic benchmark harness; web UI on port 3303. See [Benchmarks](../../benchmarks/README.md). |
| `eval-prompt` / `qualify:prompt` | Fast 15-item prompt A/B against a running model endpoint; `qualify:prompt` gates the answerer at ≥ 13. In-world: `benchmark run smoke`. See [Prompt architecture](agent-prompt-architecture.md). |
| `qualify:decisions` | Compare decision backends on labeled gate and route cases. See [decisions](../architecture/decisions.md). |
| `qualify:autonomy` / `qualify:evolution` | Autonomy and native-evolution qualification from readiness evidence. See [Autonomous quality loops](autonomous-quality-loops.md). |
| `trial:evolution` / `trial:evolution:local` | Run an evolution trial against a server, or against a disposable local one. See [Native evolution](native-evolution.md). |
| `qualify:flywheel` | Live Flywheel sandbox qualification. See [Flywheel live qualification](../integrations/flywheel-live-qualification.md). |
| `qualify:release` | The whole local release gate: versions, typecheck, lint, tests, dashboard, browser, site, audit. See [Release qualification](release-qualification.md). |
| `qualify:memory` | Black-box memory service proof over public HTTP and scoped keys. |
| `qualify:memory:benchmark` | Memory-delta benchmark (offline stub by default). |
| `qualify:paraphrase` | Paraphrase retrieval gate (hit@3 across lexical variants). |
| `qualify:memory:reliability` / `:storage` / `:sustained` / `:load` | Restart and fault recovery; real ENOSPC and read-only faults in a private mount; elapsed-time resident continuity; concurrent tenants with cancellation and retry. |
| `qualify:memory:assistance` / `:resident` / `:workflow` / `:task-workflows` / `:utility` / `:scale` / `:clients` | Research qualifications for memory assistance, residents, workflows, utility, synthetic scale, and installed coding clients. See [Memory assistance](memory-assistance.md). |

## Load and soak

| Script | What it does |
|---|---|
| `soak` | Flood: N concurrent WebSocket connections sending commands (`--connections --duration --rate`). |
| `soak:churn` / `soak:churn:local` | Bounded reconnect soak with rotating session tokens, against a server or a disposable local one. |
