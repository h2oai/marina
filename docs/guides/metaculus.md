# Metaculus bot

`bun run metaculus` enters Marina in Metaculus AI-benchmark tournaments (FutureEval, MiniBench)
as a bot: no human in the loop, open source, every forecast posted with its reasoning comment.
It is a thin adapter over the general typed forecaster ([Forecasting](forecasting.md)); the code
lives in `benchmarks/metaculus/` and `scripts/metaculus.ts`.

## What it does

| Question type | Asked as | Posted as |
|---|---|---|
| binary | a choice of Yes/No with probabilities | `probability_yes` |
| multiple choice | a choice over the options with probabilities | `probability_yes_per_category` |
| numeric / discrete | a number with its uncertainty (sd) | `continuous_cdf` (201 points, or `inbound_outcome_count + 1`) |

The CDF is a normal (log-normal on a log-scaled question) at the forecast value and sd, mixed
with a 3× wider component for the tails, then standardized as Metaculus requires (no mass past a
closed bound, a minimum past an open one, strictly increasing, no step over the cap) — a port of
the standardization in Metaculus's bot template.

One pass (`bun run metaculus pass`):

1. lists each tournament's open questions and skips any already forecast (recorded locally in
   `external_submissions`, or shown in `my_forecasts` on Metaculus);
2. forecasts each new one with the chosen configuration (below), recalling lessons from earlier
   resolved outcomes;
3. posts the forecast, then the reasoning comment: the forecast, the runs' reasons, sources,
   the evidence cutoff, and the configuration that produced it;
4. records it (append-only, one row per question, with its cost);
5. checks recorded questions that have resolved, scores them and hands each outcome to the
   outcome-learning loop (`src/learning`), recorded once (`metaculus-outcome`).

Spend: each question's cost is recorded; a pass stops at `--daily-cap` (default $10 per UTC day,
from those records) and at the world's `MARINA_DAILY_SPEND_CAP_USD`.

## Credentials

| Variable | Where it comes from |
|---|---|
| `METACULUS_TOKEN` | The bot account's API token: create a Metaculus account for the bot, register it as a bot for the AI benchmark, then copy the token from the account settings. Every API call needs it, reads included. Env only; never logged. |
| `OPENROUTER_API_KEY` (or a local provider) | The forecaster's models, as for `bun run forecast`. |
| `DB_PATH` | The ledger (default `marina.db`). |

## Dry run

```bash
bun run metaculus pass --dry-run --tournament test     # live questions, nothing posted (needs the token)
bun run metaculus pass --fixture posts.json            # saved questions, offline
```

A dry run writes each would-be payload and comment to `data/metaculus/dry-run/<question>.json`
and records nothing.

## Choosing the configuration

Any Marina formation can file: one model alone, an ensemble, `delphi` or `tournament` over
several vendors, the verification formation, or a crew (`marina:<crew>`), each with or without
lessons and lookups (`benchmarks/forecasting/configs.ts`). `bun run metaculus select` picks one by
a held-out backtest:

```bash
bun run metaculus select --backtest-tournament <resolved tournament> --budget 15
```

- Candidates come from OpenRouter's live model catalogue (newest per vendor, plus `--include`).
- Each candidate forecasts the same resolved questions as of their opening time, with date-strict
  `asof` retrieval, in replicates. A candidate is scored only on questions opened after its models'
  release; one released too recently is reported as not yet backtestable. A crew cannot be
  isolated and is never backtested.
- Every run goes into the benchmark ledger. Candidates are ranked by pooled score, with a paired
  two-stage bootstrap against the leader.
- The pick is saved to `data/metaculus/selection.json` and used by later passes. Every comment
  discloses the configuration and how it was chosen.

`--config <label>` overrides the pick (disclosed as not chosen by backtest unless it was the pick).

## Running on a timer

```bash
bun run metaculus timer        # writes ~/.local/share/marina-metaculus/systemd/marina-metaculus.{service,timer}
```

The units run one pass every 20 minutes, reading credentials from
`~/.config/marina-metaculus/env` (create it with mode 0600). They are written, never enabled; the
command prints the two `systemctl --user` lines to enable them after review.

## Tournaments

`--tournament` takes ids or slugs, repeatable: `fall2026` (FutureEval Fall 2026, id 33121),
`minibench`, and `test` (the practice area — forecasts there never count). Default: `fall2026` and
`minibench`.
