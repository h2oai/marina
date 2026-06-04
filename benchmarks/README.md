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

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `-b, --benchmark` | Benchmark name | required |
| `-m, --mode` | `passthrough` or `memory` | `passthrough` |
| `-l, --limit` | Max questions | all |
| `-e, --endpoint` | API endpoint URL | `http://localhost:3300` |
| `-k, --api-key` | Bearer token | none |
| `--model` | Model name | `marina` |
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

## Datasets

Datasets are auto-downloaded from HuggingFace on first run and cached in `benchmarks/datasets/` (gitignored). The retention benchmark ships in-repo (generated at runtime).

## Results

JSON results are written to `benchmarks/results/` (gitignored) with the format:
`{benchmark}-{mode}-{timestamp}.json`

## Requirements

- Bun 1.1+
- Running Marina instance with provider agent
- Python 3.10+ (for HumanEval only)
