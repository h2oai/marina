# Marina Benchmark Harness

Benchmarks for validating Marina as an LLM endpoint and measuring its memory system's impact.

## Quick Start

```bash
# Start Marina + provider agent
bun run start &
bun run src/sdk/examples/provider.ts &

# Smoke test (10 questions)
bun run benchmarks/harness.ts --benchmark mmlu-pro --limit 10

# List all benchmarks
bun run benchmarks/harness.ts --list

# View past results
bun run benchmarks/harness.ts --results
```

## Baseline benchmarks

Standard automated benchmarks for Marina as an LLM endpoint.

| Benchmark | Questions | Type | Metric |
|-----------|-----------|------|--------|
| `mmlu-pro` | ~12,000 | 10-choice MC | Accuracy per subject |
| `ifeval` | 541 | Instruction following | Strict/loose accuracy |
| `truthfulqa` | 817 | MC (multiple correct) | Normalized accuracy |
| `humaneval` | 164 | Python code gen | pass@1 |

```bash
bun run benchmarks/harness.ts --benchmark mmlu-pro --mode passthrough
bun run benchmarks/harness.ts --benchmark ifeval --mode passthrough
bun run benchmarks/harness.ts --benchmark truthfulqa --mode passthrough
bun run benchmarks/harness.ts --benchmark humaneval --mode passthrough  # requires Python 3.10+
```

## Tier 0 — Small Hard Slice for Crew and Formation Sweeps

`bun run bench:tier0` runs a fixed, deterministic slice of hard sets against one target and
writes one result JSON per set, plus `summary.json`, to
`benchmarks/results/tier0-<label>-<timestamp>/` (or `--out-dir`).

| Set | Items | Source | Scoring |
|-----|-------|--------|---------|
| `hle-verified-gold` | 40 (`--hle N`) | [`skylenage-ai/HLE-Verified`](https://huggingface.co/datasets/skylenage-ai/HLE-Verified) `train` split, `Verified_Classes = Gold subset`, items without an image | MC: exact letter. Short answer: normalized exact match, else the strict equivalence judge |
| `gpqa` | 40 (`--gpqa N`) | [`Idavidrein/gpqa`](https://huggingface.co/datasets/Idavidrein/gpqa) `gpqa_diamond` (gated — needs `HF_TOKEN`) | Exact letter; options shuffled per seed |
| `frames` | 20 (`--frames N`, `0` skips) | `google/frames-benchmark` (closed book) | Substring match, else the 1–10 judge (≥ 7) |

```bash
bun run bench:tier0 --endpoint marina:<crew>                  # a crew on http://localhost:3300 (--base to change)
bun run bench:tier0 --endpoint openrouter/<vendor>/<model>    # one model, direct (OPENROUTER_API_KEY)
bun run bench:tier0 --endpoint http://host:port --model <id>  # any OpenAI-compatible /v1
```

- **Determinism.** The same `--seed` (default `42`) selects the same items and, for GPQA, the
  same option order (`shuffleChoices`: per-item permutation seeded by `(seed, item id)`). The
  cache keeps GPQA unshuffled, so a cached file never fixes the answer position.
- **Judge.** Judge-scored items use `--judge-model` / `--judge-endpoint`. A run never grades
  itself: the harness default is `MARINA_BENCHMARK_JUDGE_MODEL`, else `marina/default`, and a
  judge that names the target is refused unless `--self-judge` opts in (recorded as
  `config.judge.self_judge`, ledger judge marked `[self-judge]`). `marina:<crew>` targets are
  judged by `marina/default`, so every crew in a sweep shares one judge. The
  `openrouter/<vendor>/<model>` direct arm is the deliberate control with no Marina in its path:
  it keeps grading with the target, now through an explicit `--self-judge`. A judge that fails is
  recorded as `judge: "error"` on the item and scored wrong. For a crew, keep the judge on the
  crew's own server: `--judge-model openrouter/<vendor>/<model>` reaches that upstream through
  Marina's passthru in every endpoint mode, so judge calls are traced and costed like any
  other call.
- **Timeout.** `--timeout <ms>` bounds each request (the harness flag of the same name, else
  `HARNESS_TIMEOUT_MS`, else 600 s). `marina:<crew>` targets default to 900 s: a crew
  deliberating on a hard item takes minutes, and a client that gives up first scores an answer
  still on its way as wrong. The server bounds the same request with `MODEL_REQUEST_TIMEOUT_MS`
  (600 s by default) — raise both for longer runs. Latency stays in every item.
- **Dead target.** After two consecutive timeouts on an endpoint, each request first probes
  `<endpoint>/health`. Any HTTP reply means slow-but-alive, and the run continues. No reply
  within 10 s fails the remaining items at once with `target unresponsive`, re-probing at most
  once a minute, instead of spending the full timeout on each one. Any answered request
  clears the state.
- **Keys** reach each harness child as `MARINA_BENCH_API_KEY`, never on the command line.
- **Ledger.** A `marina:<crew>` target files every finished set into its own server's
  benchmark ledger (`POST /v1/benchmarks/runs`) as a `crew` run. Each item carries its
  `traceId`, the target's `x-request-id`, and the server resolves who worked on the item from
  its trace and event log. Then `benchmark compare | frontier | participants` rank it in-world.
  - **Other targets** file only with `--file-to <marina-url>`, as a `model` run.
  - **Overrides:** `--no-file` turns filing off. `--target-kind`, `--target` and `--label`
    override what is recorded.
  - **Filing key:** `MARINA_LEDGER_API_KEY`, else the target key when filing into the
    target's own server.
  - **What is sent:** only ids, outcomes, scores, latency, cost, judge verdict and trace id,
    never case text.
  - **Attribution:** each participant says how it was found. `trace` is exact, for the agent
    that received the request. `window` covers crew-mates' untraced turns inside the
    request's window; it is `shared`, and its cost is not charged, when another request to
    the crew overlapped. Run crews at `--concurrency 1` for exclusive windows.
  - **Failure:** a filing failure is printed and never fails the run.
- **Replicates.** `--replicates N` runs the whole preset N times on the same items and judge
  (`--replicate-concurrency C` at once).
  - Each replicate writes `rep-<i>/`.
  - Every filed run carries one replicate group (`--group <key>`, else a fresh
    `rep:<label>:<time>`).
  - The summary adds the pooled view per set: mean accuracy over replicates, each run's
    accuracy, between-run SD, and unanimous and pairwise agreement.
  - In-world, `benchmark compare` pools the groups with a two-stage bootstrap (runs, then
    items), and `benchmark promote` needs replicates (`MARINA_PROMOTION_MIN_REPLICATES`,
    default 2).
  - `harness.ts` takes the same `--replicates` / `--group`; each run writes
    `<file>.rep<i>.json`.
- **Failure.** A set that cannot run (for example GPQA without `HF_TOKEN`) is reported as
  `FAILED` with the reason; the other sets still run and the exit code is 1.
- **Cost.** Each item records the usage its endpoint reported: tokens from `usage`, dollars
  from Marina's `x-marina-cost-usd` header or OpenRouter's `usage.cost`. Unreported cost
  prints `n/a` and is never estimated. Judge dollars are kept separately from answer dollars.

The individual sets also run alone, e.g.
`bun run bench --benchmark hle-verified-gold --limit 40 --seed 42`.

**Multimodal HLE.** `hle-verified-gold-mm` is the complement: the Gold items whose record
has an image. The image is sent as an `image_url` part after the question (same scoring),
so the endpoint must accept images. A `marina:<crew>` endpoint receives it on the canvas
(`inbox:<model id>`) with the node named in the prompt; `marina/verify:` passes it to the
checker as well. Images stay in the gitignored dataset cache, and the ledger records item
ids only.

### Paired comparison

```bash
bun run bench:compare <runA.json> <runB.json>   # two result files
bun run bench:compare <tier0-dirA> <tier0-dirB> # every set present in both directories
bun run bench:compare a.json b.json --json      # machine-readable
```

Items are paired by id (unpaired ids are counted and left out). For each arm: accuracy with
its 95 % Wilson interval, dollars total and per item, and tokens. For the pair: McNemar's
exact test on the discordant counts, and a paired bootstrap (10,000 resamples, `--seed`,
`--resamples`) of accuracy(B) − accuracy(A) with a 95 % percentile interval.

### Transfer report

A capability counts only when it improves results on **at least two independent evaluations**,
not just the one it was built for, and makes none significantly worse. `eval:transfer` checks
that rule for a baseline and a candidate configuration (env-knob overlays) across a list of suites:

```bash
bun run eval:transfer --spec transfer.json                 # ingest existing result files (no spend)
bun run eval:transfer --spec transfer.json --out reports/x # writes reports/x.md and reports/x.json
bun run eval:transfer --spec transfer.json --split all     # every item, not just the held-out half
bun run eval:transfer --spec transfer.json --run           # also run suites that have a `run` command
bun run eval:transfer --spec transfer.json --bootstrap two-stage # resample replicate runs, then items
bun run eval:transfer --spec transfer.json --allow-unversioned # also count result files with no commit stamp
bun run eval:transfer --adapters                           # list the suite adapters
bun run eval:transfer --inventory [root…] --out inv        # find every per-item result on disk
```

```json
{
  "baseline":  { "label": "verify-off", "env": { "MARINA_FORECAST_VERIFY": "off" } },
  "candidate": { "label": "verify-on",  "env": { "MARINA_FORECAST_VERIFY": "on" } },
  "stats": { "alpha": 0.05, "resamples": 10000, "seed": 1, "minItems": 10 },
  "suites": [
    { "name": "futurex-past", "group": "futurex", "adapter": "futurex",
      "baseline": ["runs/off/cheap-date-filtered-lessons-off-r1"],
      "candidate": ["runs/on/cheap-date-filtered-lessons-off-r1", "runs/on/cheap-date-filtered-lessons-off-r2"] },
    { "name": "forecastbench", "group": "forecastbench", "adapter": "ledger",
      "arms": { "baseline": "mech-verify", "candidate": "mech-verify+PC" },
      "options": { "benchmark": "forecastbench-backtest" },
      "baseline": ["data/ledger.db"], "candidate": ["data/ledger.db"] },
    { "name": "arena-numeric", "group": "arena", "adapter": "arena-evaluate",
      "arms": { "baseline": "baseline", "candidate": "nowcast" },
      "baseline": ["arena-eval.json"], "candidate": ["arena-eval.json"] },
    { "name": "hle", "group": "hle", "adapter": "harness",
      "run": { "command": ["env", "MARINA_BENCH_RESULT_FILE={out}", "bun", "run", "bench", "-b", "hle-verified-gold"], "replicates": 2 } }
  ]
}
```

Per suite, items are paired by id (several files per arm are replicates, averaged per item; an id
missing from any run is left out and counted), d = candidate − baseline, then a paired bootstrap of
mean(d) (seeded, percentile interval) and an exact two-sided sign test on the non-zero d. A suite
**improves** only when both agree (interval low > `margin`, sign-test p < `alpha` with more wins);
it **regresses** when either says so. The verdict is `transfers` only with improvements in at least
`minGroups` (2) distinct `group`s and no regression anywhere; otherwise `regresses`,
`does-not-transfer` or `insufficient` (fewer than two groups with `minItems` paired items).
Suites in the same `group` (two FutureX batches, two arena families scored by one method) count
once. The scores are per-item means: a board's own weighting (FutureX levels) is not applied.
`"bootstrap": "two-stage"` (in `stats`, or `--bootstrap two-stage`) resamples each arm's replicate
runs before the items, the cluster bootstrap of `benchmarks/forecasting/select.ts` (same draws for
a seed), so run-to-run variance widens the interval; the default resamples items of the
replicate-averaged deltas.

**Held-out by default.** Each suite keeps only the `holdout` side of the stable hash split that
benchmark promotion uses (`itemSplit`, slot `transfer:<group>`, 50 %); give the slot a capability
was tuned on (`"split": {"kind": "hash", "slot": "…"}`) so its tuning items never count. A time
split keeps items whose evidence cutoff is on or after a date (`{"kind": "time", "after": "2026-09-01"}`,
`--split after:<date>`; adapters that know item times only). `"all"` / `--split all` opts out, and
the report labels it. Adapters drop what their own suite marks unsafe: FutureX rows flagged by the
leak audit; arena rounds whose outcome was public before the lock are already gone.

**Test the right versions.** A comparison changes one thing — the env overlay — so both arms must
run the same code. Every result a benchmark writes records the code that produced it:
`marina: {"commit", "dirty", "describe"}` from git at run time (`benchmarks/run-version.ts`) on
harness results (short-answer, FRAMES, HLE, …), each BrowseComp-Plus query file in `evals/`, the
BrowseComp-Plus result, FutureX `score.json`/`summary.json`, ForecastBench/Metaculus
`selection.json`, and `arena evaluate --out` reports. Ledger runs carry it in `config_json.marina`
(harness filings, FutureX and forecasting backtests; no migration), and in-world runs already name
their code in `source`. (`arena shadow paired-score` reports score forecasts made earlier, so they
are not stamped.) The transfer report reads each source's stamps and, per suite:

| Status | When | Counted |
|---|---|---|
| `same-commit` | every source of both arms is at one clean commit | yes |
| `version-comparison` | the spec declares `versions` and each arm is at its declared ref | yes |
| `unversioned` | `--allow-unversioned`, some sources unstamped (the report carries a warning banner) | yes |
| `version-mismatch` | sources on different commits (also across one arm's replicates), or an arm not at its declared ref | **no** |
| `version-unknown` | a source with no stamp, run with uncommitted changes (`dirty`), or a declared tag that does not resolve | **no** |

A suite that is not counted keeps its numbers in the report (with what the statistics alone said)
but is neither an improvement nor a regression, and the verdict names it. When the shared commit is
behind `origin/main` the report warns (local git only — fetch first; nothing goes to the network):
the default is to test newest main. To test a prior release on purpose — release vs release, or a
regression test — declare it in the spec (a suite may override it):

```json
{ "versions": { "baseline": "v0.7.0", "candidate": "v0.8.0" }, "baseline": {…}, "candidate": {…}, "suites": […] }
```

Each ref is a sha (a prefix of ≥ 7 hex works without git) or a tag resolved in the local repository
(a stamp whose `describe` is the tag also matches). The report labels the run a version
comparison. Results written before stamping are `version-unknown`; `--allow-unversioned` counts
them, with a warning banner, when you know which code they came from. Dirty checkouts are never let
in: commit, then run. The inventory shows each variant's commits and marks each pair `same commit`,
`MIXED commits` or `commit unknown`.

**Ingest first.** Suites read files that already exist; a suite with a `run` command executes it
only under `--run` (argv, never a shell; `{out}`, `{arm}`, `{replicate}` substituted; the arm's
`env` overlaid on the environment; outputs under `--run-dir`, default `transfer-runs/` next to
the spec). Exit status: 0 for `transfers`, 2 for any other verdict, 1 on error.

| Adapter | Reads |
|---|---|
| `items` | generic records `{id, score, at?, exclude?, variant?, replicate?}`: JSON array, `{items: […]}`, JSONL, or a directory of such files. `arm` keeps one `variant` (one file can hold every arm), distinct `replicate` values become replicate runs, a boolean score counts 1/0, duplicate ids in a run are averaged. Options remap fields for any other record format: `records` (path to a nested array), `id`, `score`, `variant` (comma list, joined with `/`), `replicate`, `at`, `exclude` — dotted paths, `a\|b` alternatives, `""` to drop |
| `harness` | harness result JSON (`BenchmarkResult`, and the `*-ledger.json` filing bodies): `items[].score`, else `correct` as 1/0. Repeated-trial ids `<task>#<trial>` (τ², Mind2Web 2 filings) collapse to the task, mean over its trials (`options.trials: "keep"` opts out) |
| `ledger` | a benchmark ledger DB (any world DB, `ledger.db`) — in-world `benchmark run` / `compare-run`, imported harness runs, ForecastBench/Metaculus selection runs. Each selected run is one replicate; select by `arm` (the run label without its ` rN` suffix, else the model) or options `label`, `group` (globs), `run` (ids), `benchmark`, `since`/`until` (start time), `status` (default `completed`), `includeInvalid` (default off: invalidated runs are skipped, as every ranking reader does); `<task>#<trial>` items collapse to tasks as for `harness` |
| `futurex` | FutureX clean-backtest run directory (or its `score.json`); `at` from `answers.json`, leak-audit-flagged rows excluded (`options.audit: "off"` keeps them) |
| `arena-evaluate` | `bun run arena evaluate --out` reports: `rounds[]` and `shapes.rounds[]`, column `arm`, skill vs persistence; `options.tracker` keeps one family |
| `arena-paired` | `bun run arena shadow paired-score --out`: eligible batches, column `arm` (`start`, `delphi`, `fred`, `calibrated`) |
| `tau2` | τ²-bench results JSON: `simulations[]` by `task_id`, `reward_info.reward`, each `trial` a replicate |
| `browsecomp` | BrowseComp-Plus `evals/` directory (`run_N_eval.json` per query), `judge_result.correct` |
| `longmemeval` | LongMemEval `per_question.jsonl`, `score` by `question_id` |
| `paired-run` | a paired-run campaign `analysis.json`: `<options.suite>.attempts[]` by `task`, arm `arm/model`, `reward` or `passed` |

The last four are field presets over the `items` reader. A source may name its own `adapter`, so
one suite can pair, say, a harness file against ledger runs of the same benchmark.

**Ledgers are read without writing.** A DB with no write-ahead log is opened through SQLite's
`immutable=1` URI (no locks, no `-shm`/`-wal` created); a DB whose `-wal` holds rows is copied
with its log to a temporary directory and the copy is read (`maxCopyMb` option, default 1 GB;
above it the log is not read and the inventory says so).

**Inventory.** `--inventory <root…>` (at least one root is required, for example
`~/.cache/marina-<name>`; a root may be one DB file) walks the roots read-only,
skipping source trees (`src/`, `node_modules/`, `checkout/`, … — a checkout's `benchmarks/` only
for its `results/`), recognises every file and ledger an adapter reads, and writes
`<out>.md` / `<out>.json` (default `transfer-inventory`): per suite its variants (adapter,
replicates, items scored in every replicate, item dates, recording dates, sources) and every
pair of variants sharing ≥ `--min-items` items, each with a ready suite entry for a spec.
Byte-identical files count once; a ledger run present in several DB copies counts once; a pair
whose scores agree on every shared item (one run recorded twice, e.g. a result file and its
ledger filing) is left out. Groups are conservative: domains and subsets of one benchmark
(τ² domains, HLE text and multimodal, the LongMemEval sets) are one group. Pairs are per suite —
choosing which pair in each group is the same baseline/candidate change is the reader's call.

**Adding a suite.** Easiest: make the evaluation write the `items` format (one line per item:
`{"id": "…", "score": 0.73}`, higher is better — negate a loss; add `at` for time splits,
`exclude: "<reason>"` for items that must not count, `variant` to keep several arms in one file
and `replicate` for repeated runs). An existing record format usually needs only field options
on `items` (or a preset like `tau2`). Otherwise add an adapter to `benchmarks/transfer/adapters.ts`
(`load(source) → ItemScore[]`, or `loadRuns` for several replicates; register it in `ADAPTERS`),
teach `benchmarks/transfer/inventory.ts` to recognise its files, and add a fixture test in
`test/eval-transfer.test.ts`. Keep benchmark knowledge in the adapter;
`benchmarks/transfer/core.ts` (the statistics and the verdict) stays benchmark-free.

## Memory comparisons

These benchmarks compare Marina's memory mode with plain passthrough on the same questions.

| Benchmark | Questions | Type | Metric |
|-----------|-----------|------|--------|
| `narrativeqa` | ~200 | Story comprehension | Judge score (1-10) |
| `mt-bench` | 80 | Multi-turn conversation | Judge score (1-10) |
| `retention` | 100 | Cross-session recall | Exact match accuracy |

```bash
# Memory vs passthrough comparison
bun run benchmarks/harness.ts --benchmark narrativeqa --mode memory --compare passthrough --limit 50
bun run benchmarks/harness.ts --benchmark retention --mode memory --compare passthrough

# MT-Bench (uses Marina-as-judge)
bun run benchmarks/harness.ts --benchmark mt-bench --limit 10
```

## Memory comparisons with the reporting standard (genbench)

The memory comparisons above use the retention task and judge scores;
`benchmarks/memory/genbench.ts` runs a memory comparison under a fixed reporting protocol. It runs five arms under one protocol —
`bare`, `cold`, `warm`, and the matched controls `fullcontext` and `bm25` — on a held-out
seed/eval split, injects memory through the resident agent path, and reports Wilson 95% CIs,
seed-level CIs, token-F1 alongside judge accuracy, tokens injected, latency, and cost.

```bash
# Offline and deterministic (stub model + exact-match judge) — what CI runs
bun run qualify:memory:benchmark

# Real model through a running Marina instance, 5 seeds, held-out split
bun --env-file=/dev/null run benchmarks/memory/genbench.ts \
  --dataset gsm8k --limit 200 --seeds 5 --model marina/default --judge marina/default
```

Results go to `benchmarks/results/memory/` (gitignored), one JSON per arm plus a markdown summary,
never overwritten. The reporting standard, arm definitions, and an explicit "what this does NOT prove" list are in
[`benchmarks/memory/README.md`](memory/README.md).

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `-b, --benchmark` | Benchmark name | required |
| `-m, --mode` | `passthrough` or `memory` | `passthrough` |
| `-l, --limit` | Max questions | all |
| `-e, --endpoint` | API endpoint URL | `http://localhost:3300` |
| `-k, --api-key` | Bearer token | none |
| `--model` | Model name | `marina` |
| `--judge-model` | Judge model for judge-scored items (never the target, see `--self-judge`) | `MARINA_BENCHMARK_JUDGE_MODEL`, else `marina/default` |
| `--judge-endpoint` | Judge endpoint | `--endpoint` |
| `--self-judge` | Allow the judge to be the target model; recorded with the run | off |
| `-c, --concurrency` | Parallel requests | `5` |
| `-s, --seed` | Deterministic subset | none |
| `--compare` | Run comparison mode | none |
| `--list` | Show available benchmarks | |
| `--results` | Show past results | |

## Web UI

A visual dashboard for viewing results, comparing runs, and launching benchmarks.

```bash
# Start the benchmark UI server
bun run bench:ui

# Or with a custom port
bun run benchmarks/server.ts --port 8080
```

Opens at `http://localhost:3303` with four tabs:

- **Dashboard** — Score overview chart, stat cards, recent runs
- **Results** — Filterable table of all runs, click to drill into per-item details
- **Compare** — Side-by-side comparison of any two runs with delta analysis, bar and radar charts
- **Run** — Configure and launch benchmarks from the UI, with live progress tracking

Supports multiple simultaneous benchmark runs with a persistent status bar showing progress for each.

## One benchmark registry

Every benchmark is declared once, in `src/engine/benchmark-registry.ts` (name, dataset,
adapter, scoring, phase, where its items come from). The harness adds each one's loader
(`benchmarks/registry.ts`), the in-world runner derives its `benchmark list`, and the web UI
serves `benchmarkCatalog()`. `test/benchmark-registry.test.ts` fails if any of them drifts. To
add a benchmark: one registry entry, one loader.

## Native crew tasks (seeded generators)

`benchmarks/native/` generates crew tasks from a seed. Each seed gives a fresh instance with an exact automatic oracle, so N is unlimited and the instances cannot be memorised. Generation is deterministic and fully synthetic.

| Task | Shape | Setup | Oracle |
|---|---|---|---|
| `csp` | private information | a meeting-slot CSP with a planted, unique solution; the minimised constraint set is dealt across members | share of constraints satisfied; correct = all |
| `aggregation` | sharding | 200–260 records in shards, plus stale `VOID` copies; `--crash` replicates each shard to two members and stops one member mid-task | exact count and sum |
| `bugs` | verification | a TypeScript module in the code workspace with 3–4 planted defects, partial visible tests, and false "fixed" claims in a pool | share of hidden cases passing (claims are a secondary score) |
| `auction` | auction | private per-member costs for 4–6 subtasks, with a capacity | optimal cost / achieved cost (exact search, unique optimum) |
| `delphi` | delphi | a seeded AR(1) process, with a different window for each member | CRPS skill of the forecast against persistence, from draws of the true predictive |
| `pipeline` | contracted pipeline | raw lines go to the parse owner only; the transform and report contracts are stated in the task | exact report, with partial credit per field |

Every generator exposes `generate(seed, opts)` and `score(deliverable, oracle, ctx?)`.

How the setup is delivered:
- Private material goes to each member as an Operator `tell`.
- Short shared items go in as pool notes. Pool listings show only 60 characters of a note, so bulk material is not sent this way.
- Files are written under `--workspace`.

`environmentSpec()` returns the same setup as a room-hostable spec.

The `bugs` oracle runs the hidden cases in a fresh temp directory, in a separate `bun` process owned by the harness. This is a local fallback, not a sandbox: the oracle does not go through `code` exec or Flywheel.

```bash
bun run bench:native --task csp --seed 7 --print          # instance + oracle answer
bun run bench:native --task all --seeds 1-3 --print
bun run bench:native --task csp --seed 7 --port 40400 --db world.db \
  --hab habitat.tsv --win windows.tsv --json              # setup → crew dispatch → poll → score
bun run bench:native --task bugs --seed 7 --setup-only --port 40400 --db world.db \
  --workspace /path/in/MARINA_CODE_ROOTS                  # prints NATIVE_TID/TEXT/RE/OK for a lane's run_task
bun run bench:native --task bugs --seed 7 --score-only --db world.db --workspace …
```

A live run (`--port … --db …`) also:

- **Scores formation adherence** over the run window from the crew's live brief
  (`CREW_BRIEFS`, via `formation-adherence.ts`). The formation is `--formation`, else the
  crew's own formation in the world DB.
- **Files into the benchmark ledger** as a `crew` run (`POST /v1/benchmarks/runs`):
  - Target `{crew, formation, members}`, benchmark `native-<task>`, judge `oracle:native-<task>`,
    adherence in the config. Ids and numbers only, never the deliverable text.
  - Default: the server the run used, with key `MARINA_LEDGER_API_KEY`. `--file-to <url>`
    files elsewhere, `--group <key>` sets a replicate group, and `--no-file` turns filing off.
  - A filing failure is printed and never fails the run.

## Native vs described vision

`benchmarks/vision-native/` compares the two ways an agent can see an image: its
own model reading the image in the tool result (`native`), or a text description
from a vision model (`describe`). The tasks are rendered deterministically from
SVG with `sharp` and have known answers: counting coloured shapes among
distractors (`count`, the denser `dense`), reading a small code in a large page
(`code`), ranking unlabeled bars (`chart`) and locating a mark in a grid (`grid`).
Each task is one agent turn with a `marina_see` tool. The tool answers as Marina
does in each mode (`viewVisual`/`viewHeader`, or the `visionRequest` body
`describeVisual` sends). The run reports accuracy and the OpenRouter-reported
cost per mode, and stops before `--budget` USD.

```bash
bun benchmarks/vision-native/run.ts --dry --images-dir /tmp/vision-items   # tasks and answers, no calls
OPENROUTER_API_KEY=… bun benchmarks/vision-native/run.ts \
  --model anthropic/claude-opus-5.5 --per-kind 6 --budget 2 [--kinds count,code,chart,grid,dense]
```

`--set hard` (`items-hard.ts`) is the set built to separate the two modes. Every
answer is computed from a seeded scene, never read back from pixels, and each
kind stresses something a text description tends to lose: exact chart readings
(`bar-read` ±1, `series-compare` with 2–4 unit gaps, `log-axis` ±10 %), dense
tables (`table-lookup`, filtered `table-sum`), spatial relations and clutter
(`inside-count`, `clutter-count` with occlusion among 40+ distractors), several
images (`spot-diff` across two grids, `match-spec` among three near-misses),
measurement (`line-length` within 4–6 %, `angle` ±4°) and detail only the small
print carries (`small-print`). Multi-image tasks name one asset per image. The
summary has per-mode, per-kind and per-family Wilson intervals and the paired
comparison (exact McNemar and a paired bootstrap, `benchmarks/stats.ts`).
`--describe-model` overrides the describe model (default: the agent's own model,
which `visionModelCandidates` tries first). `--pilot N` runs N tasks spread across
kinds first and stops when the projected cost passes `--budget`; `--concurrency`
bounds parallel tasks.

```bash
bun benchmarks/vision-native/run.ts --set hard --per-kind 10 --dry --images-dir /tmp/vision-hard
OPENROUTER_API_KEY=… bun benchmarks/vision-native/run.ts --set hard --per-kind 10 \
  --model anthropic/claude-opus-5.5 --pilot 6 --budget 6 --concurrency 6
```

Results go to `benchmarks/results/` (gitignored) or `--out`. They hold task ids,
answers, scores and costs, but no image bytes.

## Datasets

Datasets are auto-downloaded from HuggingFace on first run and cached in `benchmarks/datasets/` (gitignored). The retention benchmark ships in-repo (generated at runtime). Gated datasets (GPQA) need `HF_TOKEN` (or `HUGGINGFACE_TOKEN`) for an account that has accepted the dataset's terms. Benchmark items are never committed.

## Results

JSON results are written to `benchmarks/results/` (gitignored) with the format:
`{benchmark}-{mode}-{timestamp}.json`

## Requirements

- Bun 1.4.3+
- Running Marina instance with provider agent
- Python 3.10+ (for HumanEval only)
