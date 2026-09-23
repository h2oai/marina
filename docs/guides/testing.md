# Testing

Marina's backend suite is `bun test` over `test/*.test.ts` (302
files, ~4,000 tests). Run serially it takes about 340 s; this
guide covers the shorter loops and the conventions that keep them short. The
reference for file layout and rules is `test/README.md`.

## Commands

```bash
bun run test:fast              # pre-commit subset, ~43 s
bun run test                   # full backend suite
bun run test:shard 0 3         # one of three time-balanced CI buckets
bun run typecheck && bun run lint
cd dashboard && bun run test   # frontend (vitest)
```

Both wrappers forward everything after `--` to `bun test`
(`bun run test:fast -- --bail`, `bun run test:shard 1 3 -- --only-failures`).

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
- **Unique DB paths and ports per file** so split files and shards can run in
  parallel processes.
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
