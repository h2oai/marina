# Benchmark Ledger, Earned Promotion and Invalid Runs

**When to read this:** you are changing the in-world `benchmark` command, the run ledger (`src/engine/benchmark-ledger.ts`, `src/persistence/db-benchmarks.ts`), replicate pooling, earned promotion of defaults, run invalidation, or how runs teach. `CLAUDE.md` → Key Files states the invariants; this page holds the mechanics. Related: [persistence.md](persistence.md) (ledger migrations), [memory.md](memory.md) (lessons retired on invalidation), [`docs/guides/testing.md`](../guides/testing.md) (harness and filing).

## The `benchmark` command and the ledger

The in-world command is `benchmark list/run/sweep/runs/result/leaderboard/frontier/compare/participants/reference/orchestrations` (plus `defaults/challenge/promote`, `invalidate/revalidate` and `purge-content-notes`, below). Sweep (rank 4+) fans out across every live `marina:<crew>` channel. The ledger (migration 146: run cost/n/CI/slice/judge/target plus append-only `benchmark_items`, ids only and never case content) is ranked by `src/engine/benchmark-ledger.ts`; the operator imports outside results with `bun run benchmark:import`. Defaults change only by earned promotion (migration 147, `src/engine/benchmark-promotion.ts`, `benchmark defaults|challenge|promote`):
  - The challenger must win on the slot's hashed holdout split (same benchmark, judge and items).
  - The paired interval must be above 0, and the gain must clear `promotionMargin(tried)`.
  - It needs `role.edit`, and is never the challenger's own author.
  - The challenger needs `MARINA_PROMOTION_MIN_REPLICATES` replicates (default 2), checked before the holdout is read. Every pooled replicate must be the challenger's own benchmark, target, slice and judge (else refused, before the holdout); the incumbent pools only its own configuration; the promoter may author none of the pooled runs.
  - The history is append-only.
  - Replicate groups (migration 148, `src/engine/benchmark-replicates.ts`, statistics in `benchmarks/replicate-stats.ts`) pool repeated runs of one target, slice and judge. A named `replicate_group` is used, else an automatic identity group.
    - `benchmark compare` adds a two-stage (runs, then items) bootstrap and flags single runs as "not replicated".
    - `benchmark replicates <run>` shows one group.
    - The harness takes `--replicates N` / `--group`.
    - `--regroup` writes an append-only `benchmark_run_regroups` row per moved run (migration 155).
    - Filing is idempotent: `content_hash` covers stable fields only (no wall-clock), so a resumed harness or repeated `file` step re-files nothing.
  - Read with `getPromotedDefault` (see Notes); environment variables win.
  - Invalid runs (migration 153): `benchmark invalidate|revalidate <run> reason:<text>` (`role.edit`; revalidate never by the run's author) or `benchmark:import --invalidate <run> --reason` set status `invalid` with an append-only `benchmark_run_validity` row; items are never deleted. A run whose items are more than `MARINA_BENCHMARK_MAX_FALLBACK_RATE` (0.25) fallbacks is recorded invalid automatically. Invalidating an incumbent never frees its slot: a challenger must beat the best earlier valid incumbent on the holdout (re-seed from replicates only if none is valid), and the invalidator can neither promote into the slot nor author the challenger. Every ranking reader reads only `completed` runs; `runs`/`result` show invalid ones with the reason.

## How runs teach: judged lessons, never item text

No benchmark path writes an item's question, expected answer or model answer to memory. A memorised answer would contaminate every later run of the same benchmark and bypass the judged lesson loop.

- **One outcome per run.** A run teaches through the outcome-learning loop in `src/learning/`, and every path feeds it the same way:
  - The in-world runner calls `noteBenchmarkRun` from `BenchmarkRunner.recordHarnessResult` for a valid, scored run.
  - `bun run benchmark:import --learn` and `POST /v1/benchmarks/runs` call it after recording a ledger run.
- **What the outcome carries.** `benchmarkRunOutcome` in `src/learning/intake.ts` builds the outcome from:
  - the run's `bench:<id>` ref, score, n and judge;
  - its cost per item and execution evidence;
  - the comparison with the best other run on the same slice;
  - the run's weakest categories, as labels with correct/total counts (`categoryAccuracy`).

  The harness result's `question`, `expected` and `actual` fields are never read on this path.
- **How the outcome is judged.** A writer model turns the outcome into one general rule; the writer never sees an item. The judge's `leak_free` question rejects any rule that restates a case. A judge outage leaves the lesson `unverified`, which is never promoted. Invalid and failed runs teach nothing. Agents read the results with `lessons <topic> domain:benchmark`.
- **What `benchmark:<name>` pools hold now.** The pools keep only the seeded per-benchmark guide notes. Seeded crew roles point agents at `benchmark result` and `lessons`, and tell them never to write an item's question, answer or identifying details to any pool.
- **Legacy pools.** Before this rule, the runner wrote up to 60 per-item notes per run into `benchmark:<name>` (`WRONG|OK … Q: … | expected=|answer=…`). `benchmark purge-content-notes` finds them (author `benchmark-runner`, or that shape) in every `benchmark:*` pool:
  - By default it is a dry run that reports counts per pool and never shows content.
  - `confirm:yes` needs `role.edit`. It retires the notes through `note delete`'s audited path, so canonical records are revised, never erased, and no row is deleted directly. It also logs one `benchmark_content_notes_retired` feed event.
  - The pools themselves stay.
- **Guard.** `test/benchmark-no-content-memory.test.ts` holds the rule in two ways:
  - It feeds sentinel item text through the runner, the import composition and the filing endpoint, then asserts that the text appears in no database table, no lesson and nothing the lesson writer saw.
  - It statically forbids memory-write calls in the runner, ledger, command, filing, import, harness, adapter and scoring files.

  Out of the guard's scope by design: `benchmarks/memory/` and `benchmarks/modes/memory.ts`, which measure memory itself with synthetic material, and `benchmarks/native/`, which seeds each task's own inputs into per-instance pools.

## Notes

- `getPromotedDefault` is the reader for a slot's promoted value; no production code path reads a promoted default yet, so a promotion is recorded but changes no runtime behaviour until a caller adopts it. Environment variables always win.
- Invalidation also retires the lessons citing `bench:<id>`, and any legacy per-item outcome notes earlier runners left for the run (see [memory.md](memory.md)).
