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

## Phase A — Baseline Benchmarks

Standard automated benchmarks proving Marina works as a competent LLM endpoint.

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
- **Judge.** Judge-scored items use `--judge-model` / `--judge-endpoint`. The default is the
  target model, except `marina:<crew>` targets, which default to `marina/default` so a crew
  never grades itself and every crew in a sweep shares one judge. A judge that fails is
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

## Phase B — Memory Delta Experiments

The core thesis test: does Marina's memory system measurably improve outcomes?

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

## Phase C — Memory Delta under the Reporting Standard (genbench)

Phase B measures memory with the retention task and judge scores; `benchmarks/memory/genbench.ts`
is the harness for making a *citable* memory-delta claim. It runs five arms under one protocol —
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
never overwritten. The reporting standard, arm definitions, how to reproduce `HISTORY.md` §5
honestly, and an explicit "what this does NOT prove" list are in
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
| `--judge-model` | Judge model for judge-scored items | `--model` |
| `--judge-endpoint` | Judge endpoint | `--endpoint` |
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

## Datasets

Datasets are auto-downloaded from HuggingFace on first run and cached in `benchmarks/datasets/` (gitignored). The retention benchmark ships in-repo (generated at runtime). Gated datasets (GPQA) need `HF_TOKEN` (or `HUGGINGFACE_TOKEN`) for an account that has accepted the dataset's terms. Benchmark items are never committed.

## Results

JSON results are written to `benchmarks/results/` (gitignored) with the format:
`{benchmark}-{mode}-{timestamp}.json`

## Requirements

- Bun 1.4.2+
- Running Marina instance with provider agent
- Python 3.10+ (for HumanEval only)
