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
| `forecastbench fetch\|estimate\|run\|write\|upload\|resolve\|select\|baseline\|status` | ForecastBench: forecast a round's 500 questions (resumable) with statistical priors for dataset questions, write the set file, choose up to 3 configurations by backtest, score the model-free priors (`baseline`); `upload` needs `FORECASTBENCH_GCS_FOLDER` and `--yes`. See [ForecastBench](forecastbench.md). |
| `deepresearch select\|run\|check\|score\|summary\|compare\|file\|export` | DeepResearch Bench I and II: cited research reports for each task (resumable, `--max-usd` hard stop), the optional cross-model fact pass, local scoring with the official evaluators behind a capped judge proxy, ledger and lessons; never sends anything. See [DeepResearch Bench](deepresearch-bench.md). |
| `metaculus select\|pass\|forecast\|resolve\|status\|timer` | Metaculus tournament bot: choose a configuration by held-out backtest, forecast open questions with a reasoning comment (`--dry-run` posts nothing), learn from resolved ones, write the 20-minute systemd units (never enabled). Needs `METACULUS_TOKEN`. See [Metaculus](metaculus.md). |
| `learned export\|import\|entitle\|verify\|diff\|keygen` | Signed `marina.learned.v1` bundles of lessons, defaults, ledger aggregates, adopted roles and ratified conventions: export (allow-list, scans, proprietary unless `--open`), verify against pinned keys, diff two versions, import (`MARINA_UPSTREAM=on`, trust `imported`; paid slices need `--entitlement`, your own private pack `--own`), entitle (sign an entitlement token). See [Learned bundles](learned-bundles.md). |
| `mind2web2 run\|cache\|judge\|score\|record` | Mind2Web 2: answer live-web research tasks with the research agent (`--cap-usd` required), export the pages it read in the judge's cache layout, run the official judge locally under a spend cap, score, and record to the ledger and lessons. Never submits. See [Mind2Web 2](mind2web2.md). |
| `repro doctor\|list\|<setup>` | Reproduce a published benchmark setup (`hle-verified`, `swebench-verified`, `tau2`, `futurex-backtest`, `arena-backtest`): prerequisite checks with fixes, `--dry-run` plans with estimated spend, replicated arms, a pooled comparison from the ledger. See [Reproduce](reproduce.md). |
| `leaderboards` | Print a markdown snapshot of the public-competition record — external submissions, arena filings, and the benchmark ledger — from the append-only tables. See [Leaderboards](leaderboards.md). |

## Memory service

| Script | What it does |
|---|---|
| `memory <sub>` | Standalone memory service admin: `init`, `serve`, `revoke`, `backup`, `restore`, `rotate-backups`, `compact-receipts`, transfers. See [Memory Service](memory-service.md). |
| `memory:mcp` | Memory as a stdio MCP server for coding clients. See [Memory extensions](memory-extensions.md). |
| `build:memory` | Build the browser memory SDK (`dist/memory.js`). |

## Develop and test

| Script | What it does |
|---|---|
| `test` | Full backend suite, four workers, progress heartbeat and a 15-minute process deadline. |
| `test:ui` | Full dashboard suite on Node/Vitest, with four JSDOM workers. |
| `test:browser` | Build and run the six discovery, memory and participation browser journeys. |
| `test:explorer` | Build the documentation site and verify API explorer search, schemas, deep links and mobile layout in Chromium. |
| `test:properties` | Run shrinking, seeded cache invalidation, command scheduling/cancellation and context security properties (`FC_SEED`, `FC_RUNS`, `FC_PATH`). |
| `docs:api [--check]` | Generate builtin commands, live MCP tool schemas, published SDK declarations, HTTP dispatch references and API explorer data, or check them for drift. |
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
| `qualify:participation:load --directory PATH [--participants 16 --records 64 --operations 30]` | Real local MCP HTTP concurrency, private automatic context, FULL SQLite durability, bounded overflow and recovery; emits report.json without model calls. |
| `bench:context` | Offline old/new term-statistics comparison on 1,000 canonical records; verifies equal results and reports median/p95, without caching retrieved memory. |
| `eval-prompt` / `qualify:prompt` | Fast 15-item prompt A/B against a running model endpoint; `qualify:prompt` gates the answerer at ≥ 13. In-world: `benchmark run smoke`. See [Prompt architecture](agent-prompt-architecture.md). |
| `qualify:decisions` | Compare decision backends on labeled gate and route cases. In-world (the world's own backend): `decision qualify`. See [decisions](../architecture/decisions.md). |
| `qualify:autonomy` / `qualify:evolution` | Autonomy and native-evolution qualification from readiness evidence. In-world views: `readiness autonomy`, `evolve qualify`. See [Autonomous quality loops](autonomous-quality-loops.md). |
| `trial:evolution` / `trial:evolution:local` | Run an evolution trial against a server, or against a disposable local one. See [Native evolution](native-evolution.md). |
| `qualify:flywheel` | Live Flywheel sandbox qualification. See [Flywheel live qualification](../integrations/flywheel-live-qualification.md). |
| `qualify:release` | The whole local release gate: SBOM, versions, typecheck, lint, tests, dashboard, browser, site, audit. See [Release qualification](release-qualification.md). |
| `sbom [path]` | Generate and check the CycloneDX repository dependency inventory with pinned Syft. See [Supply-chain verification](supply-chain.md). |
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
