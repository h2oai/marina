# Benchmark Ledger, Earned Promotion and Invalid Runs

**When to read this:** you are changing the in-world `benchmark` command, the run ledger (`src/engine/benchmark-ledger.ts`, `src/persistence/db-benchmarks.ts`), replicate pooling, earned promotion of defaults, or run invalidation. `CLAUDE.md` → Key Files states the invariants; this page holds the mechanics. Related: [persistence.md](persistence.md) (ledger migrations), [memory.md](memory.md) (lessons and outcome notes retired on invalidation), [`docs/guides/testing.md`](../guides/testing.md) (harness and filing).

## The `benchmark` command and the ledger

The in-world command is `benchmark list/run/sweep/runs/result/leaderboard/frontier/compare/participants/reference/orchestrations`. Sweep (rank 4+) fans out across every live `marina:<crew>` channel. The ledger (migration 146: run cost/n/CI/slice/judge/target plus append-only `benchmark_items`, ids only and never case content) is ranked by `src/engine/benchmark-ledger.ts`; the operator imports outside results with `bun run benchmark:import`. Defaults change only by earned promotion (migration 147, `src/engine/benchmark-promotion.ts`, `benchmark defaults|challenge|promote`):
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

## Notes

- `getPromotedDefault` is the reader for a slot's promoted value; no production code path reads a promoted default yet, so a promotion is recorded but changes no runtime behaviour until a caller adopts it. Environment variables always win.
- Invalidation also retires the lessons citing `bench:<id>` and the per-item outcome notes the runner deposited for the run (see [memory.md](memory.md)).
