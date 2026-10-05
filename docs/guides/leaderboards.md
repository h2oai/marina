# Public leaderboards and competitions

Marina can enter several public, third-party-scored competitions. Each is a thin adapter over a
general capability — the typed forecaster (`src/forecast/`), the coding agent (`src/coding/`), or
the agent runtime — so results describe the configured capability and providers used for that run.
This page catalogs the available adapters. The local ledger records attempts; each competition's official leaderboard remains the authority for public placements.

## The discipline

Every entry follows the same rules, and they are the reason a placement here is worth more than a
self-reported number:

- **Submission needs operator authorization.** File-based adapters prepare artifacts for review.
  Explicit upload commands and configured bots such as Metaculus can post externally; review the
  adapter guide before enabling a recurring bot. Preparing a file does not prove acceptance.
- **Candidate vs. result.** A subset run at one seed is a *candidate* — it suggests where a full
  run might land. A *result* is the full official split, run through the official grader, with the
  configuration chosen on a held-out split and disclosed. Only results are claimed.
- **Honest labels.** A `marina/verify:` model, a crew, or a formation is an agent with its own
  control flow, and is described as such — never as a bare model. Retrievers are labelled by what
  they actually are (e.g. SQLite FTS5 BM25, not Pyserini).
- **Auditable record.** Adapters record external submissions, arena filings, or benchmark runs.
  Acceptance and validity can change with recorded outcomes; the ledger preserves the audit trail.

## The catalog

| Competition | Validates | Adapter / command | Submission path | Status |
|---|---|---|---|---|
| [Social Simulation Arena](arena.md) | Forecasting (live, sealed, MIT) | `bun run arena` | Signed filing, operator act | Use `arena status`; verify official placement |
| [BrowseComp-Plus](browsecomp-plus.md) | Deep research (830 hard Qs, fixed corpus, LLM judge) | `bun run browsecomp-plus run` | `summary.json` → email / AgentBeats | Adapter available; inspect local runs |
| [FutureX](futurex.md) | Forecasting challenge | `bun run futurex run` | File + email, operator act | Wired |
| [τ²-bench](tau2.md) | Customer-service agents (multi-domain) | `bun run repro tau2` | Official `tau2 submit` | Wired |
| [Metaculus](metaculus.md) | Forecasting tournaments (FutureEval, MiniBench) | `bun run metaculus pass` | Bot posts forecast + reasoning | Wired |
| [ForecastBench](forecastbench.md) | Forecasting (500 Q/round) | `bun run forecastbench run` | Operator uploads set file | Wired |
| [SWE-bench / Pro](swebench.md) | Coding (real repo repair) | `bun run repro swebench-verified` | Model patches via GitHub PR | Runs, manual submit |
| HLE-Verified | Reasoning (gated) | `bun run repro hle-verified` | No open leaderboard | Internal validation |

Two tracks share one core: **forecasting** (Arena, FutureX, Metaculus, ForecastBench) all ride the
same typed forecaster, so each placement compounds confidence in one engine. **Agentic**
(BrowseComp-Plus, τ²-bench, SWE-bench) validate the agent, coordination, and coding cores.

## Current status

`bun run leaderboards` prints a bounded markdown snapshot of the local ledger: up to 20 external
submissions per adapter, 20 recent arena filings (10 shown), and five top completed runs per
listed benchmark. It opens `DB_PATH` (default `marina.db`) read-only and never migrates it.
Keep private filenames and internal results in your own evidence record; this output does not
fetch live rankings or prove official acceptance. Update an older database through normal Marina
startup before using the script.

```bash
bun run leaderboards
```

The snapshot covers:

- **External submissions** — `external_submissions` rows for FutureX, Metaculus, and ForecastBench
  (file name, items answered, cost, date).
- **Arena filings** — `arena_submissions` rows (entrant, round, status).
- **Benchmark ledger** — `benchmark leaderboard` for the competitive in-world benchmarks
  (HLE-Verified, AIME, GPQA), with score, N, and the recorded run confidence interval.

For a single competition, the adapter's own status command is the precise view:

```bash
bun run arena status          # rounds filed and local filing status
bun run futurex status         # FutureX submissions recorded
bun run metaculus status       # filed and resolved forecasts
bun run forecastbench status   # sets written and uploaded
benchmark leaderboard hle-verified-gold   # in-world, top runs
```

## Claiming a placement

A placement is claimable in public only when it is a *result*, not a candidate:

1. Choose the configuration on a held-out split, never on the scored set.
2. Confirm at a second offset.
3. Run the full official split through the official grader.
4. Disclose the selection split, N, seed, method, and cost per query.

Until then, describe it as a candidate ("a subset sweep suggests #2 territory"), not a placement.
The distinction is what keeps a Marina claim from being the thing this project criticizes in
others: a number without a reproduction.
