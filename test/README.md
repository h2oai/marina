# Backend tests

Bun test files live flat in this directory as `test/<area>.test.ts` (one file per
concern; split a file by `describe` block once it passes ~1 s or ~1,000 lines).
Shared fixtures are in `test/helpers.ts` (`MockConnection`, `stripAnsi`,
`cleanupDb`, `grantAllGates`, `until`) plus per-family helpers such as
`test/websocket-helpers.ts`.

## Three loops

| Loop | Command | What runs | Wall (serial, 2026-09-23) |
|---|---|---|---|
| Fast (pre-commit) | `bun run test:fast` | 140 cheap, self-contained files | ~43 s |
| Full | `bun run test` | every `test/*.test.ts` (302 files, ~4,000 tests) | ~340 s |
| Sharded (CI) | `bun run test:shard <i> <n>` | one time-balanced bucket of the full suite | ~115 s per shard at n=3 |

`test:fast` and `test:shard` are thin wrappers (`scripts/test-fast.ts`,
`scripts/test-shard.ts`) around `bun test <files>` with the standard
`--path-ignore-patterns` for the dashboard / desktop / demo trees. Anything after
`--` is forwarded to `bun test`, e.g. `bun run test:fast -- --bail`.

### Fast loop

`scripts/test-fast.ts` carries an explicit `FAST_FILES` array. A file qualifies
when **both** hold:

1. its measured total in `test/timing.json` is ≤ 1,500 ms, and
2. it does not boot an engine or a server — heuristic: the source contains none
   of `new Engine(`, `startServer`, `Bun.serve`, `WebSocket`.

The array is checked in (deterministic, reviewable in diffs). Missing files are
skipped with a warning so a rename never breaks the loop. To refresh it:

```bash
bun run scripts/test-fast.ts --check   # prints drift + a ready-to-paste array
bun run scripts/test-fast.ts --list    # what would run, with per-file ms
```

### Sharding

`scripts/test-shard.ts <index> <total>` partitions **all** `test/*.test.ts`
files deterministically:

- files present in `test/timing.json` are assigned slowest-first to the
  lightest bucket (LPT greedy; ties break on sorted file name);
- files missing from the snapshot fall back to `fnv1a(path) % total` and are
  weighted at the median measured time.

`--list` prints every bucket with estimated seconds and **asserts** the buckets
are disjoint and cover every file exactly once:

```bash
bun run scripts/test-shard.ts --list 3
bun run scripts/test-shard.ts 0 3      # run one shard locally
```

### `test/timing.json`

Bun's native `--timings` snapshot (`{ "version": 1, "files": { "<path>": <ms> } }`),
one entry per file. It only affects *balance* — a stale snapshot never drops a
file. Regenerate after adding, splitting or materially speeding up a file:

```bash
bun run test -- --timings test/timing.json --update-timings
bun run scripts/test-fast.ts --check                 # then refresh FAST_FILES
```

Take the snapshot from a quiet machine on a clean tree; commit the JSON.

## Rules

- **No real sleeps ≥ 500 ms — poll a condition.** When a test is *waiting for
  something to happen* (a message, a socket close, a row), use
  `until(() => cond, { timeoutMs, intervalMs: 20 })` from `test/helpers.ts`.
  It returns as soon as the condition holds and throws past the timeout, so the
  happy path never pays the worst case. A real `Bun.sleep` is only right when
  the test asserts that something does **not** happen within a window (e.g. "no
  notification after revocation" in `memory-knowledge-graph.test.ts`).
- **One engine per file, not per test, where the tests are read-only** — engine
  boot plus schema migration is the dominant per-test cost in the slow files.
- **Unique DB paths and ports per file.** Split files must not share
  `test_*.db` names or listen ports with their siblings (the shards run them in
  parallel jobs, and `bun test --parallel` runs them in parallel processes).
- Use `test/helpers.ts` fixtures; cast branded ids in tests (`"e_1" as EntityId`).
- `bunx biome format --write test/<file>` before committing.

## Layout notes

- `integration-websocket|telnet|persistence.test.ts` — split from the former
  `integration.test.ts` (2026-09-23).
- `websocket-bind|server|hardening.test.ts` + `websocket-helpers.ts` — split
  from the former `websocket.test.ts` (2026-09-23).
- `test/fixtures/` — shared data fixtures; `test/load/` — load scripts, excluded
  from `tsc` and not test files.
