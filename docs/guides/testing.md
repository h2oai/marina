# Testing

## Isolated integration worlds

`createTestEngine()` from `test/engine-fixture.ts` supplies an independent in-memory
database, command registry and room without starting listeners or the tick timer:

```ts
const world = createTestEngine();
try {
  const { entityId, connection } = world.login("Ada");
  await world.engine.processCommand(entityId, "look");
  expect(connection.lastText()).toContain("Test Room");
} finally {
  await world.dispose();
}
```

Disposal stops agents, drains commands, closes service resources, then closes storage;
it is idempotent. Two fixtures can coexist in one process, including identical names
and command registrations. Use `{ storage: "disk" }` for WAL, reopen, external writer
and durability tests. An in-memory fixture shares one SQLite handle and is not a disk
durability test. Tests changing process-wide environment, trust profiles, provider
registries or clocks still need isolation; the helper never silently resets globals.

`Engine` is instanced, not a singleton. `test/engine-isolation.test.ts` also holds one
engine's asynchronous command open while another executes and shuts down, then checks
that the first remains usable. Sharding isolates ambient process configuration and
distributes work; it is not required to construct multiple engines. This does not make
arbitrary tests that change globals safe to run concurrently in one process.
Some built-in services also retain process-wide hosts, notably the challenge service
and its gate-refusal hook. The fixture tests prove world storage, command execution
and teardown isolation; they do not establish independent security/service policies
for multiple fully configured production worlds. Keep tests using those services in
separate workers until those hosts are explicitly owned by each engine.

## Reproducible property and security tests

`bun run test:properties` runs fast-check histories for context invalidation,
asynchronous command ordering and hostile context JSON. CI also runs these files in
the normal backend shards. Failures include a seed and shrink path. To expand a pass:

```sh
FC_SEED=20260928 FC_RUNS=1000 bun run test:properties
```

Replay a single failing property with its printed seed and path:

```sh
FC_SEED=123 FC_PATH='0:1:2' bun test test/context-cache-property.test.ts
```

The cache oracle models access decisions independently from cache internals; the
scheduler varies interleavings and checks per-resident FIFO even after failures.
Security generation covers malformed JSON, nested values, identity overrides and
budget boundaries. A clean fuzz run is evidence for these properties, not proof of
exhaustive security. `test:fast --check` is enforced in CI against the committed timing
snapshot and selection rule; new files need measurement before joining that fast list.

The public API explorer has a separate browser check: `bun run test:explorer`. It builds
the site and exercises schema expansion, templates, deep links, search and mobile layout.

Use `bun run test` for the backend and `bun run test:ui` for the dashboard.
The backend contains more than 4,500 tests and can take several minutes, depending
on available CPU and storage. A 120-second external cutoff is not a leak detector. This
guide covers the shorter loops and the conventions that keep them short. The
reference for file layout and rules is `test/README.md`.

## Commands

```bash
bun run test:fast              # pre-commit subset, ~10 s (parallel)
bun run test                   # full backend suite, four workers, progress + 15-minute watchdog
bun run test --parallel=2      # reduce contention on a small/shared machine
bun run test:serial            # full suite in one process (debugging order-dependent failures)
bun run test:shard 0 3         # one of three time-balanced CI buckets
bun run test:coverage          # full suite + coverage (text + coverage/lcov.info)
bun run check:coverage         # per-directory report from coverage/lcov.info
bun run typecheck && bun run lint
bun run test:ui                # frontend (Vitest on Node)
bun run test:browser           # build + six real discovery/memory/participation journeys
bun run docs:api --check       # generated builtin API reference matches current definitions
make help                     # optional task shortcuts, all delegate to package scripts
```

If your local `.env` enables live services, run the backend without loading it:
`bun --no-env-file scripts/test-backend.ts --no-env-file`. Invoke the runner directly:
the package script launches another Bun process which can reload `.env`. The first
flag applies to the runner and the second to its Bun test child. Shell-exported variables still apply;
mock-provider tests should scope every setting that can select a live backend with
`scopeProcessState()` rather than relying on an operator's configuration being absent.

The test wrappers forward everything after `--` to `bun test`
(`bun run test:fast -- --bail`, `bun run test:shard 1 3 -- --only-failures`).

**Parallel by default.** `test` uses four workers; `test:fast` and `test:shard` use
`bun test --parallel` worker processes with the per-test
timeout raised from 5 s to 15 s, because contended workers run slower than a
lone process. Measured 2026-09-24: `test:fast` 49.5 s → 8.9 s; full suite
~400 s → ~100 s; three consecutive full parallel runs 4083/4083. Pass
`--serial` to the fast/shard wrappers (or use `test:serial`) to run in one process; an
explicit `-- --parallel=N` or `-- --timeout=MS` wins. Tests that spawn a child
`bun` process should set their own generous timeout.

The full-suite wrapper prints progress every 30 seconds and a diagnostic naming
the last observed file if its 15-minute wall-clock deadline expires (exit 124).
This bounds a stuck runner; it does not assert which resource leaked. Debug the named
file separately and inspect awaited teardown. Keep large build/browser jobs separate
from the SQLite-heavy backend run on constrained machines.
The full-suite and CI shard wrappers also fail when known closed-database activity, telemetry or event-log
warnings appear, even if Bun reports passing assertions.

Plain root `bun test` also excludes frontend/desktop test workspaces via `bunfig.toml`.
It remains Bun's native runner, without the full-suite wrapper's progress watchdog.

## Dashboard runtime and browser tests

Install current Node 24 LTS alongside Bun for dashboard development. The dashboard's
`.node-version` selects Node 24 locally and in CI; `dashboard/package.json` declares
the supported range: Node 22.22.2+, 24.15.0+, or 26+ (excluding 23 and 25).
The installed JSDOM requires this newer baseline than Vitest's Node 22.12 minimum.
Bun manages packages; `bun run test:ui` (or `cd dashboard && bun run test`) explicitly
launches Vitest with Node. CI installs that runtime instead of relying on the runner
image's preinstalled version. See the [Vitest runtime requirements](https://vitest.dev/guide/).

Do not use `bun --bun run test` or `bun test` inside the dashboard: those force the
wrong runtime/runner. With Bun 1.4.2, Vitest 5.0.1 and JSDOM 30.1.1, both `vmThreads`
and `threads` fail JSDOM's EventTarget receiver check before setup files can run.
The config gives an actionable error before this initialization failure. Revisit
native Bun support when this integration passes the complete suite with the same
DOM assertions and mock isolation.

The dashboard uses four isolated VM workers with JSDOM and cleanup after every test.
Tests of lazy chunks should await `vi.dynamicImportSettled()` inside `act`, rather
than relying on import speed to beat a DOM query's timeout. Browser tests exercise
real focus, WebSockets, login/onboarding, autocomplete and memory correction.

Install a browser once with `cd dashboard && bunx playwright install --with-deps chromium`.
The config uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, local `/usr/bin/chromium` when
present, or Playwright's installed Chromium. `bun run test:browser` builds first.
CI runs the same six journeys and retains traces/screenshots on failure.

## Shutdown and generated adversarial cases

Use `scopeProcessState()` from `test/process-state.ts` for temporary trust profiles,
rate-limit bypass and environment overrides:

```ts
using state = scopeProcessState({
  trustProfile: "local",
  rateLimitBypass: true,
  env: { WS_HOST: "127.0.0.1" },
});
// Create the fixture, run the scenario, and await teardown inside this scope.
```

The scope restores the previous resolved profile (including an unresolved,
environment-derived profile), bypass flag, and the specified environment keys on
return or throw. An `undefined` environment value temporarily removes that key;
`trustProfile: null` temporarily clears the resolved profile. Other environment keys
are not captured. Nested scopes dispose in reverse order. These are still process-wide
overrides: run such tests serially within a worker, and use separate workers for
concurrent scenarios with different profiles.

For a fixture spanning `beforeEach`/`afterEach`, create a `using pending` scope at the
start of setup and transfer it with `pending.move()` only after setup succeeds.
In teardown, bind that transferred stack with `using` before any fallible cleanup.
This restores state on setup and teardown failures as well as failed assertions.
Do not reset to an assumed `shared` profile or `false` bypass in cleanup; that can
overwrite a caller's configuration. The participation load qualifier uses the same
scope, with asynchronous disposal of clients, adapter, engine and database.

Always await asynchronous adapter `stop()`, then stop/drain the engine before closing
SQLite. Await `processCommand()` even for a synchronous handler: completion can still
record activity and telemetry after the handler returns. The MCP suite exercises
that ordering; `shutdown-drain.test.ts` starts a real
server, sends SIGTERM during a command, and checks committed state after restart.
Do not suppress closed-database warnings to make teardown appear clean.

`participation-fuzz.test.ts` uses fixed-seed generated inputs for whitespace and
modifier equivalence, command composition/schema bounds and hostile context JSON.
Failures are reproducible by case. These are bounded property-style checks, not a
claim of exhaustive fuzzing. Keep network input limits and execution authorization
in place even when generated cases pass.

## The fast loop

`scripts/test-fast.ts` runs an explicit list of 139 files that are
cheap (≤ 1.5 s measured) and self-contained (no engine boot, no listening
server). It is the loop to run before every commit; the full suite and the
shards run in CI.

Refresh the list whenever tests are added, split or renamed:

```bash
bun run scripts/test-fast.ts --check   # drift report + ready-to-paste array
```

## Sharding in CI

`scripts/test-shard.ts <index> <total>` partitions every test file
deterministically using `test/timing.json` (slowest-first onto the lightest
bucket; unknown files fall back to a name hash), then runs `bun test` on that
bucket. `--list` prints the buckets and asserts that together they cover every
file exactly once:

```bash
bun run scripts/test-shard.ts --list 3
```

The CI job runs the three shards as a matrix so wall time drops to roughly
one third; lint and typecheck run once.

## Coverage

Coverage is **opt-in and non-blocking**. `bun test` is unchanged; nothing in the
PR CI matrix measures or gates on it. The point is to notice a large regression,
not to chase a number.

```bash
bun run test:coverage     # full suite with --coverage; writes coverage/lcov.info
bun run check:coverage    # per-directory line coverage from that lcov
```

`bunfig.toml` holds the settings: `coverageSkipTestFiles` (coverage of a test
file measures the test, not the code under test), the `text` + `lcov` reporters,
and `coverageDir = "coverage"` (gitignored).

### Two different numbers

They measure different things, and both are reported:

| Number | Source | 2026-09 full run |
|---|---|---|
| Bun's "All files" row | unweighted **mean of per-file percentages** | 84.60% lines / 85.59% functions |
| `check:coverage` overall | **line-weighted** total parsed from `lcov.info` | 78.6% lines |

A 2,000-line module at 40% counts 2,000 lines in the weighted total but a single
file in the mean, which is why the weighted number is the lower (and more
honest) one. The floor is **75%**, measured the weighted way.

### Why the floor is not `coverageThreshold`

`bunfig.toml` deliberately sets no `coverageThreshold`. Measured on bun 1.4.2:

- the documented table form (`{ line = 0.9, function = 0.9 }`) is parsed and
  then ignored — `{ line = 0.99 }` still exits 0 on a 12%-covered run;
- the scalar form is enforced **per file**, not against the aggregate. A run
  reporting `All files 12.50 | 17.41` exits 1 under a `0.05` scalar, because
  some individual file is below 5%.

This tree has source files at 2-4% lines (rarely exercised worlds, media
providers, venue clients), so no positive scalar both passes today and means
anything tomorrow. The floor therefore lives in `scripts/check-coverage.ts`,
which measures the repo aggregate and only fails under `--strict`;
`bun run test:coverage` stays green. Revisit if Bun grows a global threshold.

### `scripts/check-coverage.ts`

Parses `coverage/lcov.info` and prints line coverage per directory, a "watched
surfaces" block for the directories where a regression hides easily behind a
healthy repo-wide average (`src/net/model-api/`, `src/net/dashboard-api/`,
`src/persistence/interfaces/`, `src/persistence/db-*.ts`, `src/agent/tools/`),
and the ten least-covered files of 40+ lines.

```bash
bun run check:coverage                       # report only, always exits 0
bun run check:coverage -- --strict           # exit 1 below the floor
MARINA_COVERAGE_MIN_LINES=80 bun run check:coverage -- --strict
bun run scripts/check-coverage.ts other/lcov.info --min 70 --strict
```

The nightly workflow runs `test:coverage` + `check:coverage` in a
`continue-on-error: true` job and uploads `coverage/lcov.info` as an artifact.

## Documentation contract tests

`test/docs-contract.test.ts` has two halves. The first is a stale-string
blocklist — it fails when a doc still shows a command or rank ladder that no
longer exists. The second half is structural and positive: it reflects over the
live registries and fails when something new lands **undocumented**.

- every `SAFETY_GATES` id appears in `docs/architecture/civic-substrate.md`
- every command `registerBuiltinCommands()` registers resolves to a source file
  under `src/engine/commands/`, and appears in `docs/guides/commands.md` or in
  its own command definition's category and usage metadata
- migration `version:` numbers are contiguous from 1 with no duplicates, in
  ascending array order (migrations are append-only)
- every `docs/architecture/*.md` is linked from `docs/architecture/README.md`,
  and every `docs/architecture/...` pointer in `CLAUDE.md` resolves
- every `MARINA_*` name in `config/environment.reference` is read somewhere in
  `src/`, `scripts/` or `worlds/`, and every key in `.env.example` is also in the
  reference
- the reverse: every `MARINA_*` variable read in `src/`, `scripts/` or `worlds/`
  (outside `src/sdk/examples/`) is in the reference, or in
  `ENV_VARS_OUTSIDE_SERVER_CATALOG` with the reason it is not a server setting
- `docs/reference/environment.md` matches what
  `scripts/generate-environment-reference.ts` renders from the reference

Each has a named allowlist next to it (`COMMANDS_DOCUMENTED_ONLY_IN_HELP`,
`ENV_VARS_COMPOSED_AT_RUNTIME`, `ENV_VARS_OUTSIDE_SERVER_CATALOG`) carrying the
reason. When one of these fails,
fix the doc or add an allowlist entry with a reason — do not loosen the
assertion.

## Script and load-test knobs

Read by scripts, never by the server (so not in `config/environment.reference`):

| Variable | Default | Read by |
|---|---|---|
| `MARINA_CHURN_CLIENTS`, `MARINA_CHURN_CYCLES` | `12`, `20` | `bun run soak:churn:local`: concurrent clients and connect/disconnect cycles |
| `MARINA_CHURN_MAX_ERRORS`, `MARINA_CHURN_MAX_P95_MS` | `0`, `2000` | `bun run soak:churn:local`: failure thresholds |
| `MARINA_COVERAGE_MIN_LINES` | `75` | `bun run check:coverage -- --strict` (see [Coverage](#coverage)) |

Release-gate knobs (`MARINA_QUALIFY_*`, `MARINA_FLYWHEEL_LIVE_*`, `MARINA_TRIAL_*`,
`CONTAINER_RUNTIME`, `EVAL_TIMEOUT_MS`) are listed in
[Release qualification](release-qualification.md#script-knobs).

## Logging fences

`console.*` bypasses every sink the operator configured: the structured-log
table behind `/api/logs`, the log viewer, the OTLP exporter, and the secret
redaction in `redactLogData`. Two static fences keep it out:

- `test/adapter-logging.test.ts` — `src/agent/lean-agent-adapter.ts`
- `test/net-logging.test.ts` — all of `src/net/**` and `src/integrations/**`

Log through a module `Logger` with the module's own category (`ws`, `mcp`,
`telnet`, `discord`, `telegram`, `feed`, `main`, ...) and fold extra values into
the structured `data` argument rather than string-concatenating them. The one
deliberate exception is the multi-line boot banner in `src/main.ts`: the
Logger's text sink stamps `[iso] LEVEL [category]` on every entry, which would
mangle a banner. `test/net-logging.test.ts` pins it to exactly one call.

## Regenerating `test/timing.json`

The snapshot is Bun's own `--timings` format, so one flag refreshes it:

```bash
bun run test -- --timings test/timing.json --update-timings
```

Do this on a quiet machine on a clean tree, then re-run
`scripts/test-fast.ts --check` and commit both changes. A stale snapshot only
affects balance — it never drops a file from a shard.

## Writing tests that stay fast

- **Poll, don't sleep.** No real `Bun.sleep`/`setTimeout` ≥ 500 ms in a test
  that is waiting for a condition. Use `until(() => cond, { timeoutMs, intervalMs: 20 })`
  from `test/helpers.ts`; it resolves the moment the condition holds. Keep a
  real sleep only for negative assertions ("nothing arrives within N ms").
- **Boot one engine per file** when the tests are read-only; per-test engine
  boot (schema migrations + world seed) dominates the slow files.
- **Unique DB paths and ports per file** — the suite runs files in parallel
  worker processes, so a fixed shared path or port is a race.
- **Split by `describe`** once a file passes ~1 s or ~1,000 lines; move shared
  fixtures into `test/<family>-helpers.ts`.
- Never reach the network: the model-API and adapter tests use mocked `fetch`
  (`test/provider-probe.test.ts` is the pattern).

## Where time goes (2026-09-23 snapshot)

| # | file | total ms | tests | why |
|---|---|---|---|---|
| 1 | memory-transfer.test.ts (now split) | 16,381 | 9 | one 14 s test moves 2,000+ records / 1.5 MiB through the real service with restart-resume |
| 2 | websocket.test.ts (now split) | 15,274 | 44 | engine + server boot per test, 100 sequential sockets in the per-IP limit test (5.3 s), 100 ms drain in every `afterEach` |
| 3 | sdk.test.ts | 9,511 | 11 | engine + server per test; `tellAndAwait` round trips take ~1.6 s inside the SDK/engine (one is a deliberate 1.5 s timeout assertion) |
| 4 | code-command.test.ts | 7,574 | 77 | engine per test + real workspace file I/O |
| 5 | mcp-server.test.ts | 7,350 | 81 | engine + MCP server per test |
| 6 | model-api.test.ts | 7,329 | 83 | engine + HTTP server per test, mocked upstream round trips |
| 7 | memory-advanced.test.ts | 6,323 | 14 | 4.6 s test indexes 10,000+ records |
| 8 | gateway.test.ts | 6,078 | 53 | two engines + relay per test |
| 9 | agent-runtime.test.ts | 6,024 | 60 | agent spawn/lifecycle with stub model per test |
| 10 | memory.test.ts | 5,827 | 54 | engine per test, FTS-backed recall |
| 11 | shell.test.ts | 5,326 | 35 | engine per test + real subprocesses |
| 12 | memory-reliability.test.ts | 4,985 | 10 | 3.7 s test archives 160 messages through lossy acknowledgements |
| 13 | chronicle.test.ts | 4,729 | 48 | engine per test |
| 14 | knowledge.test.ts | 4,703 | 49 | engine per test |
| 15 | unified-context.test.ts | 4,679 | 19 | durable service + legacy notes fixture per test |

Full serial run: 3,993 tests across 296 files in 341 s (bun 1.4.2, 2026-09-23;
`prompt-budget.test.ts` excluded — it failed to load on a bare `typebox` import
from an unrelated in-flight change). Sum of per-file time is 342.5 s, so the
suite is CPU/IO-bound in the tests themselves, not in bun's harness.
The only real sleeps >= 500 ms were `Bun.sleep(200)` x 3 per telnet test and
`Bun.sleep(1200)` in `memory-knowledge-graph.test.ts`; the latter is a negative
assertion (no notification after revocation) and stays. The `setTimeout(resolve,
2000)` fallbacks in the old `integration.test.ts` never fired on the happy path.

Causes, in order of weight: per-test engine/DB boot in `beforeEach`, real-time
waits (multi-second sleeps and interval-driven loops such as staleness timers,
lease expiry and rate-limit refill), and end-to-end HTTP/WebSocket round trips.

## Mutation testing and session model checks

`bun run test:mutation` uses pinned Stryker with its [command test runner](https://stryker-mutator.io/docs/stryker-js/configuration/#testrunner-string)
to mutate `context-cache.ts` and `mcp-admission.ts`, running the actual Bun/SQLite contract
and integration tests for each variant. The dedicated CI job requires a 100% score;
`/tmp/marina-mutation/mutation.json` identifies surviving mutants. The scope is these two
modules, not repository-wide mutation coverage. Investigate survivors; do not lower the
threshold to make a broken test suite pass. Stryker operates on sandbox copies, never the
working sources. Typechecking runs separately because TypeScript 7 no longer provides
the legacy JavaScript compiler API that Stryker's config rewriter expects.

`bun run check:model` checks the bounded [MCP session model](../../specs/README.md), then
requires deliberately broken models to produce the expected counterexamples. It needs
Java 21 and downloads a checksum-pinned TLC release unless `--jar` is supplied. Both
commands have dedicated Make targets. These checks complement implementation tests;
finite-state model checking is not a proof of the entire running application.

## Context latency regression gate

`bun run bench:participation-context --output /tmp/context.json` measures the complete
`buildUnifiedContext` call at 1,000 and 10,000 seeded background records across eight
tenants, plus a five-tier fixture. One in 100 background records matches the task terms.
Each scale warms up 20 times, then records 250 cold
retrievals and 1,000 cache hits. Cold runs invalidate through a real SQLite write outside
the timed section. The harness asserts cache hit/miss behavior, byte budgets, expected
evidence, tenant isolation and post-withdrawal visibility. Token-rate throttling is
bypassed only inside this disposable benchmark process. Unique fixture writes skip dedup;
write throughput is not measured. Disk SQLite uses the test helper's NORMAL setting;
production FULL durability remains unchanged. See the [operator runbook](operator-runbook.md#compare-checkpoint-thresholds-on-representative-storage)
for concurrent MCP/FULL-durability WAL qualification.

CI prepares the PR base (or previous pushed commit) and runs the **same candidate workload**
against both source trees and the candidate's installed dependencies. Three rounds alternate
base/candidate order. `bun run check:context-performance --baseline /path/to/base` compares
the median of their per-run p99s; each must stay below base × 1.5 plus 2 ms for cold reads
or 0.5 ms for warm reads, and below independent budgets of 250/20 ms respectively. These
allowances tolerate shared-runner noise while gating material regressions. JSON artifacts
retain each run's p50/p95/p99 and sample counts for historical comparison. Inspect noisy
failures on a quiet runner before changing limits. This is a retrieval regression test,
not a universal capacity SLA, write benchmark or representative production load test.

The benchmark script accepts `--root`, `--records`, `--samples` and `--match-every` for diagnosis. CI's
comparison uses fixed scales/sample counts and rejects missing or malformed measurements.
A separate candidate run makes all 10,000 records match and requires cold/warm p99 below
500/20 ms. This catches broad-query regressions without repeatedly running an already-slow
historical query plan. An independent load test still exercises admission and FULL SQLite writes.

## Accessibility

Run `bun run test:a11y` for the dashboard lint contract and axe-core browser checks.
See [dashboard accessibility](dashboard-accessibility.md) for coverage, content-dependent
media exceptions, and the manual keyboard and screen-reader checklist.

## Live coding smoke qualification

With `OPENAI_API_KEY` configured, run the native Marina worker against disposable Git fixtures:

```sh
bun run qualify:coding --directory /tmp/marina-coding-check --budget-usd 1 --scenarios bugfix,feature,refactor
```

Use a new private directory outside the source checkout. The script creates its own world and
participants, uses a fixed model with a conservative upstream spending reservation (maximum $2),
and never connects to a running world. It asks the worker to edit, verify a captured candidate,
inspect the receipt and submit through normal coding tools. It then independently checks the
result, preserves the original acceptance tests, and performs canonical owner review. World
messages must still arrive while coding runs. Reports and traces remain in the supplied directory.
Failures, missing credentials and timeouts are failures; this is a small functional smoke test,
not a general coding-quality benchmark. The default scenario is `bugfix`; `--timeout-ms` controls
the deadline per scenario (default 240000, maximum 600000).

For a multi-package exercise with nested project instructions and workspace dependencies:

```sh
bun run qualify:coding --directory /tmp/marina-coding-workspace-check --budget-usd 2 --scenarios workspace --timeout-ms 360000
```

The `workspace` fixture requires coordinated pricing and checkout changes, regression tests
in both packages, and candidate verification after frozen-lockfile dependency preparation.
The harness checks that the worker received the applicable nested instructions, preserves
the original acceptance tests and configuration, and independently checks rounding, invalid
inputs, order and mutation behavior. Dependency preparation uses captured workspace packages;
it does not install into your checkout. This remains a bounded functional exercise, not a
claim of reliability on arbitrary repositories.
