# Benchmark Ledger, Earned Promotion and Invalid Runs

**When to read this:** you are changing the in-world `benchmark` command, the run ledger (`src/engine/benchmark-ledger.ts`, `src/persistence/db-benchmarks.ts`), replicate pooling, earned promotion of defaults, run invalidation, or how runs teach. `CLAUDE.md` → Key Files states the invariants; this page holds the mechanics. Related: [persistence.md](persistence.md) (ledger migrations), [memory.md](memory.md) (lessons retired on invalidation), [`docs/guides/testing.md`](../guides/testing.md) (harness and filing).

## The `benchmark` command and the ledger

The in-world command is `benchmark list/run/sweep/runs/result/leaderboard/frontier/compare/compare-run/participants/reference/orchestrations` (plus `defaults/challenge/promote`, `invalidate/revalidate` and `purge-content-notes`, below). Sweep (rank 4+) fans out across every live `marina:<crew>` channel. The ledger (migration 146: run cost/n/CI/slice/judge/target plus append-only `benchmark_items`, ids only and never case content) is ranked by `src/engine/benchmark-ledger.ts`; the operator imports outside results with `bun run benchmark:import`. Defaults change only by earned promotion (migration 147, `src/engine/benchmark-promotion.ts`, `benchmark defaults|challenge|promote`):
  - The challenger must win on the slot's hashed holdout split (same benchmark, judge and items).
  - The paired interval must be above 0, and the gain must clear `promotionMargin(tried)`.
  - It needs `role.edit`, and is never the challenger's own author.
  - The challenger needs `MARINA_PROMOTION_MIN_REPLICATES` replicates (default 2), checked before the holdout is read. Every pooled replicate must be the challenger's own benchmark, target, slice and judge (else refused, before the holdout); the incumbent pools only its own configuration; the promoter may author none of the pooled runs.
  - The history is append-only.
  - Replicate groups (migration 148, `src/engine/benchmark-replicates.ts`, statistics in `src/stats/replicates.ts`) pool repeated runs of one target, slice and judge. A named `replicate_group` is used, else an automatic identity group.
    - `benchmark compare` adds a two-stage (runs, then items) bootstrap and flags single runs as "not replicated".
    - `benchmark replicates <run>` shows one group.
    - The harness takes `--replicates N` / `--group`.
    - `--regroup` writes an append-only `benchmark_run_regroups` row per moved run (migration 155).
    - Filing is idempotent: `content_hash` covers stable fields only (no wall-clock), so a resumed harness or repeated `file` step re-files nothing.
  - Read with `getPromotedDefault` (see Notes); environment variables win.
  - Invalid runs (migration 153): `benchmark invalidate|revalidate <run> reason:<text>` (`role.edit`; revalidate never by the run's author) or `benchmark:import --invalidate <run> --reason` set status `invalid` with an append-only `benchmark_run_validity` row; items are never deleted. A run whose items are more than `MARINA_BENCHMARK_MAX_FALLBACK_RATE` (0.25) fallbacks is recorded invalid automatically. Invalidating an incumbent never frees its slot: a challenger must beat the best earlier valid incumbent on the holdout (re-seed from replicates only if none is valid), and the invalidator can neither promote into the slot nor author the challenger. Every ranking reader reads only `completed` runs; `runs`/`result` show invalid ones with the reason.

## Statistics (`src/stats/`)

Every interval and test the ledger, route evidence, outcomes, promotion and the harnesses report comes from one module, `src/stats/` (core code never imports from `benchmarks/`):
- `paired.ts`: `wilsonInterval` (and the raw `wilsonBounds` under it), `mcnemarExact`, `mulberry32`, `pairedBootstrap`.
- `replicates.ts`: replicate pooling and the two-stage replicate comparison (`poolGroup`, `comparePooled`, `seedFromIds`).
- `bootstrap.ts`: `bootstrapMean`, `twoStageBootstrap`, `resampleMeans`, the `lcg32` PRNG and the `percentileFloor` / `percentileCeil` index rules.

`benchmarks/stats.ts` and `benchmarks/replicate-stats.ts` re-export it for compatibility. The harness copies (transfer, deepresearch, longmemeval, FutureX, forecast selection, genbench, `learned` export, arena-wiki backtest) are thin calls onto it; `test/stats-equivalence.test.ts` holds each bit-identical to its frozen original in `test/fixtures/stats-legacy.ts` (never edit the fixture to make it pass). A new statistic goes in `src/stats/`, not in a harness.
## What a run measures: residents, controls and judges

Before 2026-10 a bare `benchmark run mmlu-pro` measured the upstream model. The runner called
`/v1` with the internal token, and an internal caller takes the passthru branch unless the id
names a live crew channel. Now (`src/engine/benchmark-target.ts`):

- **`crew:<name>`** measures the residents serving `marina:<name>`. The crew's `model-<name>`
  channel must have an online member; otherwise the run is refused and never falls back to
  the bare model.
- **No target: the world's serving crew.** This is the one crew (not dissolved) whose endpoint
  has an online member. In a world with no crew records, it is the one live `marina:<name>`
  endpoint. When there is none, or several, the run is refused, and the message says what to
  pass. A refusal is less surprising than a silent bare-model run, or than picking one of
  several crews.
- **`model:<id>`** measures the bare model as a **control**: config `targetKind: "model"`,
  `control: true`, and the start message and feed event say so. `model:marina:<name>` (the older
  spelling) is the crew `<name>`.
- `sweep` fans out over every live endpoint, as before. `compare-run` stays an instrument
  comparison on one model (default `marina`), so its runs are controls.

**Crew runs on the ledger.** A crew run always gets a run key, so its requests are the run's
own and never the internal token's. It files as `target_kind: "crew"` with target
`{crew, formation, model, …}`. Each item's participants are resolved from its trace exactly as
for a filed run (`resolveParticipants`), so the residents' work reaches route evidence per
participant and role. The run's cost is the harness's usage report plus the participants'
reported costs. A crew's residents spend on their own turns, outside the key, so the key's
spend is not the run's cost; a `cap:` on a crew run bounds only the requests the key itself
makes.

**Judges.** Judge-scored benchmarks (`benchmarkUsesJudge`: short-answer, HLE, judge-scored
free-form) are never graded by their target (`src/engine/benchmark-judge.ts`, used by the runner
and the harness). The judge is `judge:` / `--judge-model`, else `MARINA_BENCHMARK_JUDGE_MODEL`,
else `marina/default`. A judge that names the target is refused at start. Aliases of the default
model count, including the concrete model `marina/default` routes to. `self-judge:on` /
`--self-judge` is the explicit opt-in: the run config records it, and the ledger judge reads
`<model> @ <endpoint> [self-judge]`, so a self-graded run never pairs or pools with an
independently graded one. Benchmarks that no judge grades record no judge.

**One registry.** `src/engine/benchmark-registry.ts` declares every benchmark once. The harness
(`benchmarks/registry.ts` adds the loaders), the in-world `BENCHMARKS` and the web UI
(`benchmarkCatalog()`) derive from it, and `test/benchmark-registry.test.ts` fails on drift.

**Native runs and formation adherence.** `bun run bench:native` runs fully in-world (crew
dispatch, pools, formations). A live run scores formation adherence over its window and files a
`crew` run (benchmark `native-<task>`, oracle judge, adherence in the config) into the server's
ledger. Adherence is scored from the live `CREW_BRIEFS` (`adherenceSteps` in
`benchmarks/formation-adherence.ts`):
- A hand-written deterministic check counts only while its anchor phrase (`BRIEF_ANCHORS`) is
  still in the brief.
- Every brief clause no check covers becomes a judge question.
- An edited brief therefore re-derives its steps, and no stale copy can score the old protocol.

**Deliberate controls stay as they were:** the tier0 direct-provider arm (now explicitly
`--self-judge`), the repro kit's plain-server arms, the fixed-formation forecast backtests, the
memory benches and the official graders.

## Arms, caps and run keys

`benchmark run <name> arm:bare|on|full|<members> cap:<usd>` measures one **arm**: the passthru instruments the run's requests get.
- `bare` sends `none`.
- `on` sends the identified-caller default stack.
- `full` sends `full`.
- A member list (`lessons,obligations`) is sent as given.

The arm and the cap are part of the run's configuration and its hash, so two arms are two configurations that `benchmark compare` can pair. A bare-model control with neither keeps the old behaviour: the harness uses the internal token, which gets no instruments.

Given an arm, a cap or a crew target, the runner mints a **run key** (`src/engine/benchmark-run-keys.ts`), a short-lived `/v1` credential held only in this process, and hands it to the harness child in its environment, never argv. A third-party harness can send only a base URL and a key, so the key carries what the run needs:

- **The arm's `x-marina-stack`** is added to every request that names none.
- **The eval context `x-marina-eval: benchmark=<name>; mode=measure|live`** is added the same way, so leakage rule 2 applies.
- **Spend attribution:** every upstream call in a run-key request counts toward the run, through the request's async context. Once the cap is spent, the key refuses with 429 `run_budget_exhausted`.
- **A transport guard:** after five consecutive upstream *network* failures (not HTTP errors), the key refuses with 503 `run_transport_failed`, so a broken connection fails the run in seconds rather than retrying until the budget is gone.

The key is revoked when the run ends. A run stopped by its key is recorded **invalid** with the reason, so no ranking reads it. A run key authenticates whether or not `MODEL_API_KEYS` is set, has no name-map authority, and can be confined to one entity (`entityName`).

## Paired comparisons as one command

`benchmark compare-run <name> arms:<a>,<b> cap:<usd> [replicates:N] [limit: seed: model: judge: concurrency: partition:]` (rank 4, `src/engine/benchmark-compare-run.ts`) runs two arms as one paired comparison:

- **Replicates default to 2** (at most 10). One run cannot separate a small effect: identical runs of one arm have moved by more than the effects being measured. `replicates:1` runs, with a warning.
- **Pairing.** Each replicate starts both arms at the same time, with the same items, seed, judge, model and server code, so a provider's bad patch lands on both. Replicates run one after another.
- **Spend.** `cap:` is required. It covers the whole comparison and is split equally across the runs, each enforced by its run key.
- **Arms** are named like `benchmark run arm:`; inside one arm, members are joined by `+` (`arms:bare,lessons+obligations`).
- **Ledger.** Each arm's runs file under the replicate group `cmp:<id>:<arm>`. `benchmark compare-run status <id>` rebuilds the report from the ledger alone, so it survives a restart; `replicates` and `compare` read the same runs.
- **Report.** Per arm: pooled accuracy with a Wilson 95% interval over item-attempts, spend, cost per success, and the `model@source` it measured. Then the paired two-stage bootstrap of A − B and the range of single-pair McNemar p. The Wilson intervals pool replicates and so understate run-to-run variance; the paired interval is the test. Arms that ran different models or code, items or judges are flagged as unpaired.
- **Feed events:** `benchmark_compare_started|completed|failed`. The owner gets the report when the last run finishes.

In-world runs record their per-item outcomes (item id, verdict, latency, cost, trace id; never question or answer text) and ledger columns when they complete, so `compare`, `replicates` and pooling read them like imported runs. A run key's measured spend is the run's cost; without one, the harness's usage report is. The run's target is `{model, stack, source}` (a crew run adds `crew` and `formation`): `source` is the server's git revision (`-dirty` with local changes), so runs on different code never pool as replicates. A bare run records no `stack` and stays model evidence for route selection; an instrumented arm is not counted as evidence for the model alone.

## Transfer: the two-evaluation rule

A paired win on one board is not yet a capability: a configuration built against one evaluation
can fit that evaluation. `bun run eval:transfer --spec <file>` (`scripts/eval-transfer.ts`,
library `benchmarks/transfer/`) judges a candidate env overlay against a baseline across several
suites and says `transfers` only when it improves significantly on at least two independent suite
groups and regresses significantly on none.

- **Core is benchmark-free** (`core.ts`): suites are per-item scores, higher is better. Per suite,
  items pair by id (replicates averaged), a seeded paired bootstrap gives the interval of the mean
  delta and an exact sign test gives p. An improvement needs both (interval low > margin, p < α);
  a regression needs either. Suites sharing a `group` count once.
- **Adapters own the formats** (`adapters.ts`): generic `items` records (one file may hold every
  arm by `variant` and replicate runs by `replicate`; field options map other record formats),
  harness results, the benchmark ledger (`ledger.ts`: runs by label, id, group or date, read
  without writing — immutable open, or a temporary copy when a `-wal` holds rows), FutureX clean
  backtests (leak-audit-flagged rows excluded), `arena evaluate` / `shadow paired-score` reports,
  and τ², BrowseComp-Plus, LongMemEval and paired-run presets.
- **Replicates**: averaged per item; `bootstrap: two-stage` resamples runs then items, the same
  cluster bootstrap as forecasting selection.
- **Inventory** (`inventory.ts`, `--inventory`): finds every per-item result and ledger on disk,
  lists per suite the variants and the pairs that share items, with ready suite entries.
- **Held out by default**: only the `holdout` side of the promotion split (`itemSplit`, slot
  `transfer:<group>`) counts, or a time split on each item's evidence cutoff; `all` is labelled.
- **No spend by default**: it ingests existing files; a suite's `run` command executes only under
  `--run`.
- **The right versions** (`versions.ts`): result files, BrowseComp-Plus query files, FutureX
  `score.json`, ForecastBench `selection.json` and `arena evaluate` reports carry
  `marina: {commit, dirty, describe}` from the writer's git (`benchmarks/run-version.ts`); filed
  and backtest ledger runs keep it in `config_json.marina`, and in-world runs name their code in
  `source`. By default every source of both arms must come from one clean commit; mixed commits
  are `version-mismatch`, unstamped or dirty sources `version-unknown` — both reported, neither
  counted (as an improvement or a regression). A commit behind `origin/main` (local git only) is a
  warning. `versions: {baseline, candidate}` declares a deliberate release-vs-release or
  regression test; `--allow-unversioned` lets old unstamped files count, labelled.

Format, options and how to add a suite: [benchmarks/README.md](../../benchmarks/README.md#transfer-report).

## The reproduction kit, from inside the world

`bun run repro` (`benchmarks/repro/`) is the kit for suites that need more than one harness call: isolated Marina servers per arm, third-party CLIs (τ², SWE-bench Verified, HLE through a judge, FutureX and arena backtests), a spend estimate refused above `--budget-usd`, and pooled replicate comparisons. The `benchmark kit` subcommand runs it from any surface (`src/engine/benchmark-kit.ts`):

| Command | Does |
|---|---|
| `benchmark kit [list]` | The setups, their arms and smoke/full sizes |
| `benchmark kit doctor [setup]` | Prerequisites, each with its fix |
| `benchmark kit <setup> … dry-run` | The plan and its estimate; no model call |
| `benchmark kit <setup> arms:a,b replicates:N limit:N budget:<usd> [model: checker: judge: domain: split: effort: user-effort: task-ids: seed:]` | A background job (rank 4, `budget:` required) |
| `benchmark kit status [id]` | Jobs since this server started; one job's status and log tail |

- **Argument safety:** only the allowlisted options are passed, each value one plain token, as an argv array (never a shell). `--run-dir` and `--ledger` are never caller-controlled.
- **Ledger:** the job's runs file into **this world's DB** (`DB_PATH`), so `benchmark runs`, `compare`, `replicates` and promotion read them like any run.
- **Run directory:** `MARINA_BENCHMARK_KIT_DIR` (default `kit-runs/` beside the DB) holds servers, scratch and the log `kit.log`.
- **Feed events:** start and finish are `benchmark_kit_started|completed|failed`.

## How runs teach: judged lessons, never item text

No benchmark path writes an item's question, expected answer or model answer to memory. A memorised answer would contaminate every later run of the same benchmark and bypass the judged lesson loop.

- **One outcome per run.** A run teaches through the outcome-learning loop in `src/learning/`, and every path feeds it the same way:
  - The in-world runner calls `noteBenchmarkRun` from `BenchmarkRunner.recordHarnessResult` for a valid, scored run.
  - `bun run benchmark:import` (by default; `--no-learn` opts out) and `POST /v1/benchmarks/runs` call it after recording a ledger run.
- **A durable record of every run.** `noteBenchmarkRun` also writes one `outcomes` row per completed, valid, scored run (`src/outcomes/benchmark.ts`), whether or not a learner is armed in that process:
  - The row is subject `bench:<id>`, kind `benchmark`, `eval_mode = measure` (never live evidence).
  - It holds the score as `quality` and refs `family:<benchmark>` and `method:<target kind>:<model, model+stack or formation>`, the same tagging as arena settles.
  - It has no delivery consumers, so the lesson still comes only through the path above.
  - The hourly `outcome-autoresolve` job sweeps up runs another process wrote (ledger importers), and the backlog.
  - `bun run outcomes:settle` does the same on demand, and optionally runs `futurex learn`, `arena settle` and `metaculus resolve`.
- **What the outcome carries.** `benchmarkRunOutcome` in `src/learning/intake.ts` builds the outcome from:
  - the run's `bench:<id>` ref, score, n and judge;
  - its cost per item and execution evidence;
  - the comparison with the best other run on the same slice;
  - the run's weakest categories, as labels with correct/total counts (`categoryAccuracy`).

  The harness result's `question`, `expected` and `actual` fields never reach the outcome's text or the writer. The runner passes them only as hashed fingerprints (`caseGuardFromItems`, `src/learning/leak-guard.ts`) for the mechanical item check.
- **What a run's lesson says.** A run-level lesson is a general rule about method, configuration or model choice: the kind of work (the run's family descriptions), the configurations compared (formation and the model in each role, `describeTarget`), which one won, and the aggregate result as evidence strength. For example: "On answers that need searching or retrieving evidence first, the read-swarm formation (lead …, reader …) outperformed the ensemble:4 formation (…) (93.3% vs 86.7% on the same items and judge, n=30); prefer the former for similar work." `benchmarkRunRule` writes this rule mechanically, so a run teaches even with no writer. The writer (`MARINA_LESSONS_WRITER`) starts from it as a draft and is prompted for aggregate outcomes: it may name models and settings and cite aggregate numbers, and must never include item ids, question text, answers or the details of any single item. Execution evidence (trace coverage, observed residents) is passed as measurement notes, never as the finding.
- **How the outcome is judged.** Before any judge reads a lesson, a mechanical check (`itemLeak`) rejects one that names a ledger item id or an id-shaped token, quotes 4–6 consecutive words of an item's text (hashed shingles), or states an item's answer. Answers are matched against the runner's hashed answers and against the ledger's keyed `answer_hash` of the run's items; aggregate numbers are removed before matching, and words the outcome itself supplied never count. A writer rule that fails the check is discarded and the mechanical rule stands in for it (`writer_note` in provenance). A lesson that still fails is rejected, and its audit record keeps the reason but not the text. The judge's `leak_free` question means "no item content that would let a future run memorise answers": aggregate scores, model names and configuration descriptions are not leaks. A judge outage leaves the lesson `unverified`, which is never promoted. Invalid and failed runs teach nothing. Agents read the results with `lessons <topic> domain:benchmark`.
- **What `benchmark:<name>` pools hold now.** The pools keep only the seeded per-benchmark guide notes. Seeded crew roles point agents at `benchmark result` and `lessons`, and tell them never to write an item's question, answer or identifying details to any pool.
- **Legacy pools.** Before this rule, the runner wrote up to 60 per-item notes per run into `benchmark:<name>` (`WRONG|OK … Q: … | expected=|answer=…`). `benchmark purge-content-notes` finds them (author `benchmark-runner`, or that shape) in every `benchmark:*` pool:
  - By default it is a dry run that reports counts per pool and never shows content.
  - `confirm:yes` needs `role.edit`. It retires the notes through `note delete`'s audited path, so canonical records are revised, never erased, and no row is deleted directly. It also logs one `benchmark_content_notes_retired` feed event.
  - The pools themselves stay.
- **Guard.** `test/benchmark-no-content-memory.test.ts` holds the rule in two ways:
  - It feeds sentinel item text through the runner, the import composition and the filing endpoint, then asserts that the text appears in no database table, no lesson and nothing the lesson writer saw.
  - `test/lesson-leak-guard.test.ts` checks that a mechanical run lesson passes a deterministic rubric judge, and that lessons naming an item id, quoting question text or stating an answer fail before the judge is asked.
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

## Runs teach, and measurement stays honest

- **Every scored run teaches.** Filing over HTTP and `benchmark:import` (by default; `--no-learn` opts out) feed each newly recorded valid run to the judged lesson loop: one outcome per run (ids, scores, counts, cost per item, judge label), compared only with runs on the same slice and judge completed by then, with `scope: config`, the run's task `families` (the harness result's `config.families`, else `src/learning/families.json`) and its target `subjects` (formation, short model names). Trusted lessons the judge finds transferable are mirrored into the cross-board `lessons:meta` pool that every work surface recalls ([memory.md](memory.md) → Outcome lessons).
- **Backfill.** Runs filed before imports learned are taught once with `DB_PATH=<db> bun run lessons backfill [--dry-run] [--limit N] [--relearn-rejected]`: valid scored runs only, `resolvedAt` = the run's completion, idempotent (a run that already has its lesson is skipped). `--relearn-rejected` also re-learns runs whose lessons were all rejected under an earlier learner version (see [memory.md](memory.md) → Backfill). Back up the database first.
- **Self-exclusion (`x-marina-eval`).** The harness sends `x-marina-eval: benchmark=<dataset>; mode=<measure|live>` on every target call, never on judge calls (`asJudge`). Under `--lessons-mode measure` (the default) a Marina target recalls no lesson learned from the same benchmark, so the score is general Marina on this board; `--lessons-mode live` uses every lesson (a live entry). The mode is recorded in the run's `config.lessons_mode`, so measure and live runs never share a configuration hash.
- **Served lessons per item.** `--lessons` asks a plain passthru target to inject lessons (`x-marina-lessons: on`); verify and crew targets recall them anyway. Each item records the lesson ids the target returned in `x-marina-lessons` (`lessons`, and `lessonsObserved` for observe mode); filing stores them in `benchmark_item_lessons` (migration 160: run, item, lesson id, `served` or `observed`, regime; ids only, at most 16 per item, append-only), read with `getBenchmarkItemLessons(run)`. This is the evidence later per-lesson accounting uses.

## Notes

- `getPromotedDefault` reads one slot's raw value. Runtime defaults go through `resolveDefault`, which adds the env, family, upstream and built-in layers and the trace. Environment variables always win.
- Invalidation also retires the lessons citing `bench:<id>`, and any legacy per-item outcome notes earlier runners left for the run (see [memory.md](memory.md)).
