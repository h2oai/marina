# Testing

Marina's backend suite is `bun test` over `test/*.test.ts` (302
files, ~4,000 tests). Run serially it takes about 340 s; this
guide covers the shorter loops and the conventions that keep them short. The
reference for file layout and rules is `test/README.md`.

## Commands

```bash
bun run test:fast              # pre-commit subset, ~10 s (parallel)
bun run test                   # full backend suite, parallel (~100 s on 16 cores)
bun run test:serial            # full suite in one process (debugging order-dependent failures)
bun run test:shard 0 3         # one of three time-balanced CI buckets
bun run test:coverage          # full suite + coverage (text + coverage/lcov.info)
bun run check:coverage         # per-directory report from coverage/lcov.info
bun run typecheck && bun run lint
cd dashboard && bun run test   # frontend (vitest)
```

Both wrappers forward everything after `--` to `bun test`
(`bun run test:fast -- --bail`, `bun run test:shard 1 3 -- --only-failures`).

**Parallel by default.** `test`, `test:fast` and `test:shard` run files in
`bun test --parallel` worker processes (one per core) with the per-test
timeout raised from 5 s to 15 s, because contended workers run slower than a
lone process. Measured 2026-09-24: `test:fast` 49.5 s → 8.9 s; full suite
~400 s → ~100 s; three consecutive full parallel runs 4083/4083. Pass
`--serial` to either wrapper (or use `test:serial`) to run in one process; an
explicit `-- --parallel=N` or `-- --timeout=MS` wins. Tests that spawn a child
`bun` process should set their own generous timeout.

## The fast loop

`scripts/test-fast.ts` runs an explicit list of 140 files that are
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
  the in-code `COMMAND_CATEGORIES` help map
- migration `version:` numbers are contiguous from 1 with no duplicates, in
  ascending array order (migrations are append-only)
- every `docs/architecture/*.md` is linked from `docs/architecture/README.md`,
  and every `docs/architecture/...` pointer in `CLAUDE.md` resolves
- every `MARINA_*` name in `.env.example` is read somewhere in `src/`,
  `scripts/` or `worlds/`

Each has a named allowlist next to it (`COMMANDS_DOCUMENTED_ONLY_IN_HELP`,
`ENV_VARS_COMPOSED_AT_RUNTIME`) carrying the reason. When one of these fails,
fix the doc or add an allowlist entry with a reason — do not loosen the
assertion.

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
