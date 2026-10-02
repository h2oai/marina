# FutureX

[FutureX](https://arxiv.org/abs/2508.11987) is a live benchmark for agents that predict future
events. Each week it publishes a batch of open questions on Hugging Face; entrants answer before a
deadline and are scored once the events resolve. Marina enters with its ordinary forecasting
engine — the same [typed forecasts](forecasting.md#typed-answers) any user gets. The adapter in
`benchmarks/futurex/` and `scripts/futurex.ts` only translates the batch into general forecast
calls and writes the submission file. Nothing in Marina's core knows about FutureX.

## Commands

```bash
bun run futurex fetch                 # the current batch, at its Hugging Face commit sha
bun run futurex fetch --past          # the resolved-questions dataset (for backtests)
bun run futurex run --variant cheap   # forecast every row and write the submission file
bun run futurex run --variant cheap --variant frontier   # several variants, one file each
bun run futurex backtest --limit 40   # resolved rows: forecast with an early cutoff, score, record
bun run futurex watch --once --run cheap   # poll for a new batch; on one, fetch and run
bun run futurex status                # every submission recorded so far
```

Files go to `data/futurex/` (ignored by git; `--dir` to change). Benchmark questions are never
committed. `DB_PATH` chooses the ledger (default `marina.db`). The forecaster's own settings
(`MARINA_FORECAST_*`, [forecasting](forecasting.md#configuration)) apply; `OPENROUTER_API_KEY` is
required and `TAVILY_API_KEY` enables date-filtered search.

## How a row becomes a forecast

`benchmarks/futurex/map.ts` reads the answer shape each row asks for:

| The row | The forecast |
|---|---|
| lettered options (`A. …`), or boxed alternatives in older rows | `choice` — or `multi` for a level-2 bundle of independent outcomes (nominations, who qualifies, cumulative thresholds such as "at least …") |
| "how many …", a unit ("Report the value in …"), a measured value | `number` (an integer for counts) |
| an ordered or "which N" list, "ranked from X to Y" | `ranking`, sized when the row says how many |
| anything else (one name, an exact title) | `text` |

The full prompt goes along as the forecast's `context` (it carries the settlement rules and the
requested format), and the row's end time becomes the evidence cutoff.

## Freezing and filing

- Every answer uses nothing published after the earlier of now and its question's end time. A row
  whose end time has already passed is answered with its cutoff at that end time and flagged
  `late`.
- Every row gets an answer: a missing prediction scores zero, so when no run produced a usable
  answer, the runs' best partial answer (or, for a choice, the first substantive option) is filed
  and flagged `fallback`.
- The submission file is named `org-<org>-agent-<agent>-model-<model>.json` and holds
  `[{"id", "prediction"}]`. Marina files as its own agent, `Marina`, under the organization
  `h2o.ai` (`--org`, `--agent`); the model segment names the variant's model (`--model` overrides
  it for a single variant).
- **Nothing is sent.** `run` prints the file path and the email fields (recipient, subject,
  dataset commit, model, framework, organization). Submitting is an operator's act, or an approved
  connector's.

## Records

- Each submission is appended to `external_submissions` (migration 150): batch sha, variant,
  identity, file name and hash, rows answered, cost. The same file is recorded once.
- A backtest — and a live batch once it resolves — is a scored run in the
  [benchmark ledger](../architecture/persistence.md), so `benchmark compare`, `frontier`,
  `leaderboard` and `replicates` rank it with every other run Marina has made.

## Variants

Built-ins are `cheap` (one strong low-cost model, three runs), `frontier` (three vendors' current
models, three runs, a frontier critic) and `crew` (a Marina crew as the analyst, via
`marina:<crew>`). `--variants <file.json>` supplies others: an array of
`{ label, model, analysts, planner?, critic?, runs?, researchRounds?, critique? }`.

## Backtests are smoke tests

The resolved dataset's outcomes are public. A backtest moves each cutoff `--horizon-days` before
the question's end time (default 7) and searches with date filters where the engine supports them,
but web search without a date filter can still surface the answer. Treat a backtest as a check
that the pipeline works end to end, never as an estimate of live skill. The local scorer
(`benchmarks/futurex/score.ts`) follows the published metric definitions — exact match or F1 for
options, a squared error scaled by 5 % of the true value for numbers, exact or partial overlap for
lists, level weights 10/20/30/40 % — and matches strings mechanically, where the official scoring
uses a model judge.
