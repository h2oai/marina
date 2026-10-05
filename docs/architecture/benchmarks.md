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

## One resolution path for defaults

Every default that earned promotion may move is read through `resolveDefault` (`src/engine/default-resolution.ts`). It consults five layers, in this order, and the first that answers wins:

1. **env** — the operator's explicit setting: an env var, or an explicit flag such as `--config`. It always wins.
2. **local slot** — `<slot>:<board>` when the choice is for a named board, else `<slot>` itself (a deployment slot such as `showcase:crew`). Only earned promotion writes it.
3. **family slot** — `<slot>:family:<family>` for each family the caller declares. `benchmark promote` and every other per-board filing refuse family slots: one board's holdout never sets a default for a whole family. Today only an upstream seed can fill one.
4. **upstream seed** — consulted only when no local slot answered. The hook is `setUpstreamSeedSource`; it stays empty until a learned-bundle importer registers one.
5. **built-in** — the caller's own default, which is today's behaviour.

A slot whose incumbent run was invalidated is skipped, and so is a value the caller cannot read (for example, a run whose target is not a configuration of that kind). The next layer answers instead; a value is never half-applied. With nothing promoted and no seed source, every read resolves to `env` or `built-in`, so behaviour is exactly as before.

**Tracing.** Every resolution is traced. It names the layer and key that answered, the incumbent run behind a slot answer, and why each earlier layer did not answer (`unset`, `invalidated`, `unreadable`). Three places carry it:

- the engine's `default_resolved` event (names and ids only, never content);
- the `defaults` Logger category;
- the `last resolutions` block in `benchmark defaults`.

**Read sites:**

| Default | Slot | Env (wins) | Built-in |
|---|---|---|---|
| Forecast formation, analysts (with planner and critic), checker (`verifier` with `verify`) and selection mode, on the in-world `forecast` command and `POST /v1/forecast` (`src/forecast/defaults.ts`) | `forecast-config`, family `forecast` | `MARINA_FORECAST_FORMATION`, `_ANALYSTS`, `_VERIFIER`/`_VERIFY`, `_SELECTION`; `_PLANNER`/`_CRITIC` win over a slot's planner and critic | `ensemble`, the installation's analysts, no checker, the built-in selection |
| A board's live forecast configuration, pick 1 (`liveConfig`, used by `bun run forecastbench` and `bun run metaculus`) | `forecast-config:<board>`, family `forecast` | `--config <label>` | the saved selection's pick, else the disclosed fallback |
| The `marina/verify` checker, when the model id names none (`src/net/model-api/verify.ts`; not consulted under a passthru pin) | `verify:checker` (an explicit `checker` field, or the checker of a `marina/verify:<p>+<c>` target) | `MARINA_VERIFY_CHECKER_MODEL`; a checker in the id wins over everything | the proposer (self-check) |
| The showcase crew model (`worlds/showcase.ts`) | `showcase:crew` | `MARINA_CREW_MODEL` | `seedAnswererCrew`'s default |

An earned value this installation cannot use never breaks a surface: a verify checker that is not a reachable upstream id is skipped, and a forecast configuration whose models cannot be wired falls back to the built-in (logged). A slot holds the challenger run's `target_json`: data, never code. Models still come only from the operator: from env, or from a promotion that an account holding `role.edit` filed on held-out evidence it did not author.

## Forecast selection files a promotion

`forecastbench select` and `metaculus select` (`runSelection` in `benchmarks/forecasting/cli.ts`) still write `selection.json`, which stays the run journal. They also file the decision through the one write path, `fileSlotPromotion` (`src/engine/benchmark-promotion.ts`), which the in-world `benchmark promote` uses as well. The decision goes to the board's slot `forecast-config:<board>`, under the operator key `operator`. The steps are:

1. **Choosing the challenger.** The challenger is the best measured, affordable candidate on the slot's selection split only: the pooled share of items better than the board's fallback, across its replicates. The holdout is read once, by the promotion attempt itself.
2. **Seeding.** If the slot is empty, the challenger seeds it. This needs `MARINA_PROMOTION_MIN_REPLICATES` replicates, checked before anything is written.
3. **Contesting.** If the slot has an incumbent, the challenger must earn the slot. That means the holdout interval above 0 and the gain past `promotionMargin(tried)`. Every attempt, refused ones included, is an append-only row that raises the bar for the next one.
4. **Contesting on the same items.** While a slot has a valid incumbent, the selection backtests on that incumbent's items (`maxItems` is ignored), so a contest pairs one item slice.
5. **Skipping.** In some cases the holdout stays unread and nothing is written. The result is recorded in `selection.json` under `promotion.outcome: skipped`, with the reason. This happens when:
   - the winner already is the default;
   - the incumbent was measured on a different benchmark, judge or item slice;
   - fewer than `MIN_HOLDOUT_ITEMS` fall in the holdout;
   - the challenger is not replicated.

The live run's pick 1 then resolves through `resolveDefault` as in the table above. Its disclosure line names the earned slot and the incumbent run.

## Route evidence: observe by default, families from roles

Spawn-time route evidence (`src/engine/benchmark-evidence.ts`, `MARINA_ROUTE_EVIDENCE`) defaults to `observe`. It records what the ledger would pick on the route decision and never changes a route; `on` applies the pick, and `off` skips the lookup.

When `MARINA_ROUTE_EVIDENCE_FAMILIES` is unset, the families come from the spawning role itself:

- the union of its traits' `families` capability (`trait create … families math,code`);
- expanded to the registered benchmarks tagged with those families (`src/engine/benchmark-families.ts`, data only);
- a declared name that is itself a benchmark counts as a family of one.

The route event's `evidence_family_source` (`configured` / `role`) says which source was used. A role that declares nothing still gets `no_family`.

## Notes

- `getPromotedDefault` reads one slot's raw value. Runtime defaults go through `resolveDefault`, which adds the env, family, upstream and built-in layers and the trace. Environment variables always win.
- Invalidation also retires the lessons citing `bench:<id>`, and any legacy per-item outcome notes earlier runners left for the run (see [memory.md](memory.md)).
