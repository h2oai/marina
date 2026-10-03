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
bun run futurex backtest --clean --isolation closed-book --variant cheap --limit 160 --replicates 2 --lessons on
                                      # a non-leaking backtest (see Clean backtests)
bun run futurex watch --once --run cheap   # poll for a new batch; on one, fetch and run
bun run futurex watch --once --run cheap --daily --learn
                                      # …and re-forecast open rows daily (see Standing answers)
bun run futurex learn                 # resolved rows of filed batches → outcome lessons
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

## Standing answers

FutureX questions stay open for days, so a filed answer is a *standing* answer per row and variant
(`out/<sha>/<variant>/standing.json`). `watch --daily` re-forecasts the rows still open:

- **Cadence:** once per UTC day at or after `--daily-hour` (default 06:00), plus one **final** run
  `--final-lead-hours` (default 4) before the batch's deadline, Wednesday 16:00 UTC. Nothing runs
  after the deadline. Runs are listed in `out/<sha>/schedule.json`.
- **Revision rule** (`src/forecast/revision.ts`): a new answer replaces the standing one only on a
  material change:
  - its confidence rises by at least 0.1; or
  - its evidence is materially new (word overlap below 0.6) at about the same confidence.

  An unchanged answer (ignoring case, spacing and list order), a number within 2 %, a fallback, or a
  different answer with nothing behind it keeps the standing answer.
- **Ledger:** every decision, kept or revised, with its reason, is appended to `revisions.jsonl`.
  A run that revises something writes a new file, which is a new `external_submissions` row, and
  prints the email fields again. A run that revises nothing reproduces the same file, which is
  already recorded, and prints nothing to send.

`--learn` (or `bun run futurex learn`) hands resolved weeks to the
[outcome-lesson loop](../architecture/memory.md#outcome-lessons-srclearning). Each standing answer
whose row has a ground truth in the past dataset is scored and recorded once per variant and row.
The question, truth and answer are seen only by the lesson writer as private context, never stored.

## Records

- Each submission is appended to `external_submissions` (migration 152): batch sha, variant,
  identity, file name and hash, rows answered, cost. The same file is recorded once.
- A backtest — and a live batch once it resolves — is a scored run in the
  [benchmark ledger](../architecture/persistence.md), so `benchmark compare`, `frontier`,
  `leaderboard` and `replicates` rank it with every other run Marina has made.

## Variants

Built-ins are:

- `cheap`: one strong low-cost model, three runs.
- `verify`: cheap runs with every draft checked by a different-vendor verifier.
- `frontier`: three vendors' current models, three runs, a frontier critic.
- `frontier-2607`: a frontier mix released before the latest resolved rows, so it can be backtested cleanly.
- `crew`: a Marina crew as the analyst, via `marina:<crew>`.

Model ids are pinned, never floating aliases. `--variants <file.json>` supplies others: an array of
`{ label, model, analysts, planner?, critic?, verifier?, verify?, runs?, researchRounds?, critique? }`.

Live runs recall every lesson in the shared `forecast-lessons` space of the `--lessons-account` world
account (default `Forecaster`) when it exists; `--lessons off` disables that.

## Clean backtests

`bun run futurex backtest --clean` measures skill on resolved rows without letting outcomes in.
Each of the three ways an outcome can leak has a guard (`benchmarks/futurex/clean.ts`):

- **Model weights.** Only rows that end at least 10 days after every model's public release are
  used. A weekly question is released at most about 10 days before it ends, so the question
  postdates the model. Release dates come from the provider catalogue (`MODEL_RELEASES`) and are an
  upper bound on knowledge cutoffs. A model with no known release, a floating alias, or a crew
  (whose agents have their own tools) is refused unless `--after <YYYY-MM-DD>` is given. Every
  variant in one invocation runs on the same rows.
- **Retrieval.** `--isolation date-filtered | post-filtered | closed-book` (with `--retriever <spec>`
  for the first two). An unfiltered engine is never used.
- **Memory.** `--lessons on` writes a lesson after each scored row and recalls only lessons visible
  at each forecast's cutoff. Rows run in order of resolution. Each run recalls only its own lessons,
  so `--lessons on` against `off` is an honest ablation, and every lesson is also kept in the
  shared space for live runs.

**Leak audit.** After scoring, each row is audited. A row is suspicious if its reasoning names a
day after the event, it quotes the exact numeric outcome, or its kept evidence includes a page
published after the cutoff. An evidence line dated on or before the cutoff counts as history and
schedule, so past-tense wording and future dates in it are not flags. Undated evidence is suspicious
if it names a day after the cutoff or reports a result. Headline scores are given with suspicious
rows in and out.

**Upper bracket.** `--allow-contaminated --isolation contaminated` runs an unfiltered engine on
past cutoffs. It can see outcomes, so it is filed under `futurex-past-contaminated` as an upper
bound, never as a clean score. Between it and closed-book lies the range a live run can fall in.

**Judged scoring.** `--judge <model>` also grades string and list answers with a model judge, as
the official weekly scoring does (mechanical string matching under-credits paraphrases). Options
and numbers stay mechanical, and both overalls are reported.

**Results.** Each run gets the overall and per-level scores with a bootstrap interval, plus a score
per batch week compared with `--reference <file.json>` (week → `top`, `median`, `h2o`, entered by
hand; the website is never scraped). `--replicates N` repeats a run. Every run is filed into the
benchmark ledger under a replicate group, `futurex-clean:<variant>:<isolation>:lessons-<on|off>`.
A run in which more than `MARINA_BENCHMARK_MAX_FALLBACK_RATE` (default 25 %) of the rows got a
fallback instead of an answer is recorded `invalid` and drops out of pooling and comparison; retire
or restore a run by hand with `benchmark invalidate|revalidate <run> reason:<text>` or
`bun run benchmark:import --invalidate <run> --reason "<why>"`.

## Backtests without `--clean` are smoke tests

The resolved dataset's outcomes are public. A backtest moves each cutoff `--horizon-days` before
the question's end time (default 7) and searches with date filters where the engine supports them,
but web search without a date filter can still surface the answer. Treat a backtest as a check
that the pipeline works end to end, never as an estimate of live skill. The local scorer
(`benchmarks/futurex/score.ts`) follows the published metric definitions — exact match or F1 for
options, a squared error scaled by 5 % of the true value for numbers, exact or partial overlap for
lists, level weights 10/20/30/40 % — and matches strings mechanically, where the official scoring
uses a model judge.
