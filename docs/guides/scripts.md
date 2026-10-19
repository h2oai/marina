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
| `setup:cli` | Put `marina` on your `PATH` by linking it into Bun's global bin folder; prints the line to add when that folder is not on `PATH` (`--force` replaces another link). |
| `build:native` | Compile the `marina` dispatcher into a standalone `dist/marina` executable. See [Compatibility](compatibility.md). |
| `build:sdk` | Build the `@marina/agent-sdk` package into `src/sdk/dist`. |
| `create:agent <new-dir>` | Scaffold a minimal SDK agent project in a new directory (never overwrites files). |
| `monitor` | Outside health monitor: checks `/health`, alerts once per outage (`--desktop`, webhook), pings a heartbeat URL while healthy, installs nothing on the host. See [Operations](../operations.md). |
| `recovery create\|restore\|unlock` | Create or restore a private recovery bundle, or release the lease of a stopped database. See [Recovery](recovery.md). |

The terminal client is `bun run scripts/connect.ts <name>` (`-c "<command>"` for one-shot,
`--port 3400` or `--url ws://host:3400` for another instance). See [Connecting](connecting.md).

## Ask, forecast, compete

| Script | What it does |
|---|---|
| `forecast "<question>"` | Forecast any question with no server running: a probability or a number, with sources, verified figures, each analyst's answer and the cost. See [Forecasting](forecasting.md). |
| `arena <sub>` | Social Simulation Arena operator CLI: `keygen`, `registration`, `status`, `rounds`, `show`, `submit`, `backtest`, `evaluate`, `research`, `shadow run\|list\|score`, `discover`, `signals`. See [Arena](arena.md). |
| `forecastbench fetch\|estimate\|run\|write\|upload\|resolve\|select\|baseline\|learn\|status` | ForecastBench: forecast a round's 500 questions (resumable) with statistical priors for dataset questions, write the set file, choose up to 3 configurations by backtest, score the model-free priors (`baseline`), learn from backtest answers (`learn`); `upload` needs `FORECASTBENCH_GCS_FOLDER` and `--yes`. See [ForecastBench](forecastbench.md). |
| `deepresearch select\|run\|check\|score\|summary\|compare\|file\|export` | DeepResearch Bench I and II: cited research reports for each task (resumable, `--max-usd` hard stop), the optional cross-model fact pass, local scoring with the official evaluators behind a capped judge proxy, ledger and lessons; never sends anything. See [DeepResearch Bench](deepresearch-bench.md). |
| `metaculus select\|pass\|forecast\|resolve\|status\|timer` | Metaculus tournament bot: choose a configuration by held-out backtest, forecast open questions with a reasoning comment (`--dry-run` posts nothing), learn from resolved ones, write the 20-minute systemd units (never enabled). Needs `METACULUS_TOKEN`. See [Metaculus](metaculus.md). |
| `learned export\|import\|entitle\|verify\|diff\|keygen` | Signed `marina.learned.v1` bundles of lessons, defaults, ledger aggregates, adopted roles and ratified conventions: export (allow-list, scans, proprietary unless `--open`), verify against pinned keys, diff two versions, import (`MARINA_UPSTREAM=on`, trust `imported`; paid slices need `--entitlement`, your own private pack `--own`), entitle (sign an entitlement token). See [Learned bundles](learned-bundles.md). |
| `mind2web2 run\|cache\|judge\|score\|record` | Mind2Web 2: answer live-web research tasks with the research agent (`--cap-usd` required), export the pages it read in the judge's cache layout, run the official judge locally under a spend cap, score, and record to the ledger and lessons. Never submits. See [Mind2Web 2](mind2web2.md). |
| `repro doctor\|list\|<setup>` | Reproduce a published benchmark setup (`hle-verified`, `swebench-verified`, `tau2`, `futurex-backtest`, `arena-backtest`): prerequisite checks with fixes, `--dry-run` plans with estimated spend, replicated arms, a pooled comparison from the ledger. See [Reproduce](reproduce.md). |
| `leaderboards` | Print a markdown snapshot of the public-competition record — external submissions, arena filings, and the benchmark ledger — from the append-only tables. See [Leaderboards](leaderboards.md). |
| `futurex fetch\|run\|backtest\|watch\|learn\|status` | FutureX weekly prediction benchmark: download a batch, forecast every row and write the submission file, backtest resolved rows, learn from resolved weeks. Never submits. See [FutureX](futurex.md). |
| `swebench export\|subset\|run\|score\|file` | SWE-bench through the one-shot coding entry point: seeded subsets, runs per arm and replicate, scoring with the official harness, filing to the benchmark ledger. See [SWE-bench](swebench.md). |
| `browsecomp-plus run\|compare` | BrowseComp-Plus over a local corpus: runs formations with a hard `--max-usd` stop, judges answers, and compares two arms. See [BrowseComp-Plus](browsecomp-plus.md). |
| `longmemeval summary\|convert` | Summarize LongMemEval-V2 run folders and convert them into a ledger file. See [LongMemEval](longmemeval.md). |
| `arena:research capture\|run\|score` | Checkpointed arena research qualification on frozen inputs. Never signs or submits. See [Arena](arena.md). |
| `arena:portfolio` | Shadow comparison of arena formations on a disposable database. No signing, submission or route writes. See [Arena](arena.md). |
| `corpus build\|list\|search\|get\|embed\|vectors` | Build and inspect offline BM25 corpora that agents search with `web search engines:corpus:<name>`; optional dense vectors. See [Search](search.md). |
| `benchmark:import` | Import harness result files into a world's benchmark ledger; also regroups, invalidates or revalidates runs (`DB_PATH`). |
| `outcomes:settle` | Settle measured results onto the outcome path: ledger runs without an outcome, plus optional FutureX, arena and Metaculus resolutions. Files nothing. |
| `lessons backfill\|rank\|replay\|backfill-work` | Operator tools for the judged lesson pool: teach unlessoned ledger runs, rank and replay lessons, backfill lessons from recorded work (`DB_PATH`). |

## Memory service

| Script | What it does |
|---|---|
| `memory <sub>` | Standalone memory service admin: `init`, `serve`, `revoke`, `backup`, `restore`, `rotate-backups`, `compact-receipts`, transfers. See [Memory Service](memory-service.md). |
| `memory:mcp` | Memory as a stdio MCP server for coding clients. See [Memory extensions](memory-extensions.md). |
| `build:memory` | Build the browser memory SDK (`dist/memory.js`). |
| `memory:compatibility status\|upgrade <db>` | Report schema version, pending migrations and numeric-memory integrity without changing the database (`status`), or apply pending migrations (`upgrade`). See [Compatibility](compatibility.md). |

## Develop and test

| Script | What it does |
|---|---|
| `test` | Full backend suite, four workers, progress heartbeat and a 15-minute process deadline. |
| `test:ui` | Full dashboard suite on Node/Vitest, with four JSDOM workers. |
| `test:browser` | Build and run the six discovery, memory and participation browser journeys. |
| `test:explorer` | Build the documentation site and verify API explorer search, schemas, deep links and mobile layout in Chromium. |
| `test:properties` | Run shrinking, seeded cache invalidation, command scheduling/cancellation and context security properties (`FC_SEED`, `FC_RUNS`, `FC_PATH`). |
| `docs:api [--check]` | Generate builtin commands, live MCP tool schemas, published SDK declarations, HTTP dispatch references and API explorer data, or check them for drift. |
| `docs:env [--check]` | Regenerate `docs/reference/environment.md` from `config/environment.reference` alone (`docs:api` also does this). |
| `schema:check` | Check that the generated fresh-database schema baseline is current. |
| `test:mutation` | Stryker mutation tests over the cache and admission contracts. See [Testing](testing.md#mutation-testing-and-session-model-checks). |
| `check:model` | Model-check the bounded MCP session specification with TLC (needs Java 21). See [Testing](testing.md#mutation-testing-and-session-model-checks). |
| `check:a11y` / `test:a11y` | Dashboard accessibility lint contract; `test:a11y` adds a dashboard build and axe-core browser checks. See [Dashboard accessibility](dashboard-accessibility.md). |
| `check:context-performance --baseline <dir>` | Compare context-retrieval p99 latency against a base checkout. See [Testing](testing.md#context-latency-regression-gate). |
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
| `bench:compare <a> <b>` | Paired comparison of two harness result files or tier-0 directories: Wilson intervals, McNemar test, paired bootstrap, reported cost. |
| `eval:transfer --spec <file>` | Transfer report: a candidate configuration counts only when it improves on at least two independent suites (paired bootstrap + exact sign test, held-out items) with no significant regression. Ingests existing result files and benchmark ledgers (read-only); `--run` executes suite commands; `--inventory` lists every per-item result on disk and the pairs it offers. Writes markdown and JSON. See [Benchmarks](../../benchmarks/README.md#transfer-report). |
| `bench:tier0` | A small fixed hard slice (HLE verified gold, GPQA, FRAMES) for crew and formation sweeps against any endpoint. |
| `bench:native` | Native world tasks: print a seeded task, or run and score it against a live server. |
| `bench:participation-context` | Measure automatic-context retrieval latency on seeded records. See [Testing](testing.md#context-latency-regression-gate). |
| `qualify:coding` | Live Code Mode qualification on small fixture projects (`--directory`, `--budget-usd`). See [Testing](testing.md). |
| `qualify:agents:handoff` | Live, bounded resident handoff qualification (needs `OPENAI_API_KEY`, `--directory`). See [Execution evidence](execution-evidence.md). |
| `qualify:sdk` | Build, pack and install the SDK into a temporary consumer project and check its exports. |
| `qualify:server` | Build the server bundle and boot it from a temporary instance directory (assets, settings, SDK command, shutdown). See [Release qualification](release-qualification.md). |
| `qualify:native` | Build `dist/marina` and test it outside the checkout with only Git on `PATH`. See [Release qualification](release-qualification.md). |
| `qualify:investigations [dir]` | Key-free qualification of the investigation service on a disposable database: content and admission limits, recovery and erasure. Never calls a provider. |
| `qualify:investigations:live` | Bounded live investigation qualification (`--model`, `--budget-usd`); a dry run prints the plan, `--live` permits paid work. Never opens an existing database. |
| `qualify:investigations:replay <report>` | Replay the attempts saved by a live run in the browser, dashboard, chat, CLI and terminal workspace. Needs `dashboard:build` and Chromium. |
| `qualify:image <image>` | Check a packaged server container image (`CONTAINER_RUNTIME`, default `docker`). See [Compatibility](compatibility.md). |
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

Research probes and audits without a `package.json` alias run directly with
`bun run scripts/research/<name>.ts`. They use synthetic identities and disposable databases;
the ones marked *live* need an output directory outside the public checkout.

| Script | What it does |
|---|---|
| `memory-api-baseline` | Records observed memory API behavior (a probe, not a conformance test). |
| `memory-surface-audit` | Wider-surface audit over real authenticated route handlers; lists unresolved boundaries. |
| `memory-long-horizon-audit` | Long-horizon functional audit with simulated time, real handlers and compactor; no models. |
| `memory-retrieval-bench` | Reproducible local retrieval microbenchmark with result checks; no models. |
| `memory-embedding-review` | Boundary diagnostic for local embeddings; optional model-cache path, never downloads. |
| `bridge-translation-audit` | Functional observations of the Anthropic ↔ OpenAI translator; no provider calls. |
| `memory-extension-qualification` | *Live*: extension sockets, persistent restart and paired fresh agents. |
| `memory-handoff-qualification` | *Live*: agent-to-agent memory handoff (`--directory`, `--budget-usd`). |
| `memory-transfer-qualification <dir>` | *Live*: transfer between two memory servers. |

The shell launchers under `benchmarks/` (`build.sh`, `run.sh`, `launch-stack.sh`,
`launch-providers.sh`, `launch-synthesis.sh`, `launch-translators.sh`, `sweep.sh`,
`run-sweep.sh`, `sweep-translators.sh`) start the self-referential provider stack and sweep the
harness across substrates; each documents its usage in its header.

## Load and soak

| Script | What it does |
|---|---|
| `soak` | Flood: N concurrent WebSocket connections sending commands (`--connections --duration --rate`). |
| `soak:churn` / `soak:churn:local` | Bounded reconnect soak with rotating session tokens, against a server or a disposable local one. |
