# ForecastBench

`bun run forecastbench` answers a ForecastBench round with Marina's general typed forecaster
([Forecasting](forecasting.md)) and writes the forecast set file. The code is in
`benchmarks/forecastbench/` and `scripts/forecastbench.ts`. Marina never uploads on its own:
uploading is a separate, explicit operator command.

## A round

A round's question set (`<due>-llm.json`) is published at 00:00 UTC on its forecast due date.
The set must be uploaded by 23:59:59 UTC that same day. Each round has 500 questions:

- **Market questions** (250): one forecast each, of the final outcome. Each is asked as a Yes/No
  choice with probabilities. The market price at the freeze date is given as context.
- **Dataset questions** (250): one forecast per resolution date (7 or 8 dates). Each is asked
  once as a multi-select over its dates, giving every date its own probability. All horizons
  share one research pass, so the forecasting work is one call per question, not one per date.

```bash
bun run forecastbench fetch --due 2026-10-11         # save the set (data/forecastbench/<due>/)
bun run forecastbench estimate --due 2026-10-11      # questions, forecasts, estimated cost
bun run forecastbench run --due 2026-10-11 --set 1   # forecast everything, then write the file
```

Dataset questions are mostly statistics, so each one also gets a **statistical prior** before the
models see it ([Statistical priors](forecasting.md#statistical-priors)):

| Source | Prior |
|---|---|
| FRED, yfinance, DBnomics | the series ForecastBench names, read as of the due date; the series picks drift, momentum, the same calendar window in past years, or 0.5 by replaying its own past |
| ACLED, Wikipedia | how similar questions resolved in ForecastBench's own published resolutions known by the due date (source → question template → size → horizon) |

The prior is shown to the runs, supplied for prior shrink, written to `<due>/priors.json`, and used
as the fallback for a dataset question that could not be forecast. Market questions keep their
market price.

`run` appends each answer to `set-<N>.jsonl` as it lands. Rerun it after an interruption: it
resumes, and retries only the questions that are missing or failed.

When `run` finishes, `write` builds `<due>.H2O-ai.<N>.json` with these fields:

| Field | Value |
|---|---|
| `organization` | `H2O.ai` |
| `model` | `Marina` for set 1; `Marina (N)` for sets 2 and 3 |
| `model_organization` | `H2O.ai` |
| `question_set` | the set's name |
| `forecasts` | one entry per required forecast (`resolution_date` is `null` for market questions) |

`write` then:

- validates the forecasts;
- reports coverage, which must be at least 95 % of market and of dataset forecasts;
- writes the configuration behind the file to a `.configuration.json` beside it;
- records the file in `external_submissions` (append-only).

A question that could not be forecast gets a fallback: the market's freeze price for a market
question, 0.5 for dataset forecasts (what ForecastBench imputes anyway). Fallbacks are counted
and reported. A dry run (`--dry-run`, `--limit` or `--sample`) writes the file but never records
it.

`--budget <usd>` stops starting new questions once that much is spent. The world's
`MARINA_DAILY_SPEND_CAP_USD` applies as well.

## Up to three sets

ForecastBench counts up to three forecast sets per round. `select` chooses three configurations
by a held-out backtest on past resolved rounds:

- Each candidate forecasts every question as of its round's due date, with date-strict `asof`
  retrieval.
- It is scored by the board's own metric: mean 1 − Brier over the resolved forecasts.
- It is scored only on rounds after its models' release dates. Replicates go into the benchmark
  ledger.
- It is excluded when its measured cost per question is over `--live-per-question`.

Set N files with pick N:

```bash
bun run forecastbench select --select-budget 15                        # → data/forecastbench/selection.json
bun run forecastbench run --due 2026-10-11 --set 1                     # pick 1
bun run forecastbench run --due 2026-10-11 --set 2 --concurrency 8     # pick 2
```

The candidates always include `prior-only` (no model: market prices and statistical priors) and
the cheap ensemble pooled toward the prior (`ensemble:cheap+pool`). `baseline` scores the
model-free priors per source on resolved rounds, at no cost:

```bash
bun run forecastbench baseline --rounds 2026-08-16,2026-08-30   # prior vs 0.5, per source
```

See [Metaculus](metaculus.md#choosing-the-configuration) for the candidate set and the leakage
guards; the two adapters share `benchmarks/forecasting/`.

## Upload

| Variable | Where it comes from |
|---|---|
| `FORECASTBENCH_GCS_FOLDER` | The `gs://…` folder in the registration confirmation email (register at register.forecastbench.org). |
| an authenticated `gcloud` | `gcloud auth login` with the account the folder was shared with. |
| `OPENROUTER_API_KEY` (or a local provider) | The forecaster's models. |

```bash
bun run forecastbench upload --due 2026-10-11 --set 1 --yes
```

Without the folder and `--yes`, `upload` only prints the file's path. The fallback is to email
the file to the address in ForecastBench's instructions. Set `reasoning` to `null` if the file is
too large to email.

## Learning from outcomes

```bash
bun run forecastbench resolve --due 2026-09-27
```

`resolve` reads the round's published resolution set and scores each answered question. It
hands each outcome to the outcome-learning loop, worst first, so that later forecasts recall the
lessons. Each question is recorded once (`forecastbench-outcome`).

Backtest answers teach the same way. `learn` turns every answer a selection journal holds
(`<selection>-runs/*.jsonl`, or `--runs <dir>`) into its round's journal and runs `resolve` on it;
the prior-only baseline is skipped. Lessons are visible only after each outcome was known, so a
later backtest cannot see them early.

```bash
bun run forecastbench learn --runs data/forecastbench/selection-runs
```

The lesson writer and judge call this Marina's own `/v1`. A CLI process authenticates with the
operator's first `MODEL_API_KEYS` secret, else the local profile's key file beside `DB_PATH`, so
its lessons are judged rather than stored unverified.
