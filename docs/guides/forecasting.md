# Forecasting any question

Marina answers forecasting questions with a probability or a number, backed by cited and checked
evidence and several models, in about 20–60 seconds for $0.03–0.10. It also answers **typed**
questions — pick one option, pick a set of options, give a number, rank a list, or name something —
with a planning step, iterative research, several independent runs and a critique pass
([Typed answers](#typed-answers)).

```bash
bun run forecast "Will the Fed cut rates at the FOMC meeting ending October 28, 2026?"
bun run forecast "What will the US regular gasoline average be on Oct 15 2026?" --unit '$/gal'
bun run forecast "…" --kind number --by 2026-12-31 --json
```

In the world, any entity can ask: `forecast <question>` (alias `predict`). Programs can call
`POST /v1/forecast` with `{"question": "...", "kind"?: "probability" | "number", "resolveBy"?, "unit"?}`
behind the model API's auth; the reply is the full answer, below.

## What happens

1. **Research** — a search-grounded model (OpenRouter's web search) gathers dated, sourced facts:
   the current state, base rates, scheduled events, and what forecasters and markets expect.
2. **Citation check** — each fact's figures are looked up in the page it cites; lines are tagged
   `[verified]`, `[unverified]` or `[unreachable]`. Publishers whose terms bar bots are never
   fetched.
3. **Analysts** — one model per vendor (by default DeepSeek V4 Pro, Claude Sonnet 5, GPT-6 Luna)
   answers from the tagged dossier.
4. **Judge** — Jev scores how well each analyst's reasoning is supported by the *verified* facts;
   weakly supported answers count for little. If the judge fails on an answer, that answer gets
   **no** weight (an outage is no opinion, never a pass) and the error is recorded on it
   (`judgeError`) and in the answer's `judge` record (calls, errors, latency, cost). The arena's
   research forecaster uses the same analyst + judge step (`src/forecast/judge.ts`).
5. **Aggregate** — probabilities are combined in log-odds, numbers as a weighted mean whose spread
   includes the analysts' disagreement.

The answer carries everything needed to audit it: each analyst's answer and reasoning, its
grounding score and weight, the sources, how many facts verified, cost and time — and a `caveat`
when the evidence was thin.

## Typed answers

Many questions want an exact answer, not a probability: *which* candidate wins, *which* bands a
figure falls in, *the* published value, the top five in order. Give the answer's shape and Marina
returns one value of that shape.

```bash
bun run forecast "Who wins the São Paulo runoff?" --type choice --options "A=Candidate one|B=Candidate two"
bun run forecast "Which ranges will the rate fall in?" --type multi --options "A|B|C|D"
bun run forecast "What will the index read?" --type number --unit points --end 2026-10-09T00:00:00Z
bun run forecast "Top 3 by weekend gross?" --type ranking --size 3 --context "Box Office Mojo, domestic"
bun run forecast "Who will be named?" --type text --json
```

In the world: `forecast <question> type:choice options:A,B,C [ends:<ISO time>]` (also `multi`,
`number`, `ranking size:<n>`, `text`). Over HTTP: `POST /v1/forecast` with an `answer` spec —
`{"type":"choice","options":[{"id":"A","label":"…"}, …]}`, `{"type":"multi",…}`,
`{"type":"number","unit"?:"…","integer"?:true}`, `{"type":"ranking","size"?:5,"candidates"?:[…]}`
or `{"type":"text"}` — plus optional `endTime`, `asOf`, `context` (resolution rules or format
notes), `runs` (1–9), `researchRounds` (1–4) and `critique` (boolean). Which models run stays an
operator setting.

What happens:

1. **Plan** — the planner restates the question, names the source that resolves it, the facts that
   decide it, what would change the answer, and the first search queries.
2. **Research rounds** — search runs in bounded rounds; after each, the planner names what decisive
   fact is still missing and the next queries, or stops when the dossier is enough. If every round
   fails (an engine outage, an exhausted search quota), the runs still answer from the question and
   its notes, and the answer carries a caveat saying so.
3. **Lookups** (on by default where available) — structured sources join the dossier as ordinary cited lines, steered by
   the plan's `data` hints (a market search phrase, a sports key and teams, official series ids).
   For a number, the freshest official reading becomes the answer's **anchor**: the runs start
   there, with the spread of that series' own changes over the question's horizon, and move
   further only for specific dated evidence. See [Lookups](#lookups).
4. **Citation check** — as above.
5. **Runs** — K independent answers (analyst models used in turn), each validated against the
   answer's shape and, with a judge, weighted by how well the verified facts support it.
   - A run whose answer misses the JSON shape gets output repair (a parse, then one re-encoding
     shot, labelled `repaired:parse` / `repaired:shot`). Repair never adds content.
   - A run whose answer has the right type but is incomplete — a ranking short of its size, a
     multi-select short of its minimum, no answer, or a probability missing for some option —
     gets ONE more call to the same analyst. The call shows the run's own answer and reasons and
     names exactly what is missing. Its reply is used only if it now validates, labelled
     `repaired:completion` (the run's `completion` record keeps what was missing and whether it
     was accepted); its cost is the run's. It is skipped in the time budget's final phase, and a
     spend-cap refusal leaves the run as it was. `options.completion: false` turns it off.
6. **Combine** — by type: weighted plurality for a choice or a short string, per-option frequency
   (≥ half the weight) for a set, the median (a 20 % trimmed mean from five runs) for a number,
   Borda count for a ranking. The runs' agreement is the answer's `confidence`.
   - Numbers are read with their scale and sign: "1.2 million", "$3.4bn", "68k", "(79,000)", "down 0.4", a Unicode minus.
   - When the unit names a scale ("USD billions"), an answer written with a scale word is converted to it.
   - From three runs, a run written at another power-of-ten scale than the runs' median (a thousands/millions confusion) is brought to the median's scale first. The method then says `scale-aligned`.
   - With `MARINA_FORECAST_SELECTION=confidence` (opt-in), the run with the highest self-reported confidence is the answer, and that confidence is the answer's `confidence`. Agreement among same-model runs measures consistency, not correctness, while a run's own stated confidence is much better calibrated.
   - `bun benchmarks/futurex/rescore-selection.ts` re-scores saved forecasts under each mode offline, with no model calls. The default changes only when `confidence` beats `agreement` on a held-out split by the promotion margin.
7. **Critique** — a second search looks for evidence *against* the leading answer, and a critic
   may propose another. The proposal replaces the runs' answer only when the critic's confidence
   exceeds the answer's `confidence` (the runs' agreement, or the chosen run's own confidence
   under confidence selection); both are kept in the record.

**Verification** (`MARINA_FORECAST_VERIFY=on`, opt-in) — the verification formation inside one
forecast: before a run counts, an independent verifier (`MARINA_FORECAST_VERIFIER`, default the
critic) checks its draft against the dossier and the resolution rules — option semantics, unit and
scale, the latest reading, arithmetic — and a concrete correction replaces the draft. Each run
records the verdict and, on a correction, the draft it replaced.

**Lessons.** A forecast can recall lessons from questions that have already resolved. There is
one lesson system: the judged, audited outcome loop
([outcome lessons](../architecture/memory.md#outcome-lessons-srclearning)). A resolved forecast,
FutureX week, Metaculus or ForecastBench question, or backtest row becomes an outcome; the outcome
becomes a candidate lesson (a category and one corrective rule), the decision layer judges it, and
it is stored in the `lessons:forecast` space. Every forecasting surface — the `forecast` command,
`POST /v1/forecast`, FutureX, Metaculus, ForecastBench and `select` backtests — recalls through the
same `forecastLessonsFor` (`src/learning/forecast-bridge.ts`), from the `forecast` and `arena`
domains, so a `+nolessons` ablation differs from its base arm only by the lessons. Recall needs no
armed learning loop and never creates the pool. Recall is lexical and byte-budgeted, and a lesson
is visible to a forecast only when its outcome was known at that forecast's evidence cutoff
(`visibleAt`) — so a forecast made "as of" September never sees a lesson learned from an October
result. The lessons used are recorded on the answer (`lessons`), and the plan, the runs and the
critic all see them. `MARINA_LESSONS=observe` records them as `observedLessons` and shows them to
no model (the ablation arm); `off` recalls nothing. A retired lesson (`lessons retire`, or every
lesson citing a ledger run when that run is invalidated) is never recalled.

**Barred sources.** Research for a board never uses that board's own pages: its dataset and
mirrors, which hold the resolutions, and its question, answer and leaderboard pages. FutureX,
Metaculus, ForecastBench and the `select` backtests each pass their list
(`benchmarks/forecasting/barred.ts`) to `typedForecastDeps({ exclude })`. The list is applied to
every retrieval engine, including the ones that ignore a brief's `exclude`. Barred sources, and
the report lines that cite them, are dropped. A captured evidence snapshot that held a barred
source is dropped whole. Each drop is counted in the report's warnings.

**One builder.** The `forecast … type:` command and `POST /v1/forecast` with an `answer` spec build
a forecast the same way (`src/forecast/surface.ts`): the operator's models, the lesson pool, the
prior and recalibration settings, and the operator's formation (`MARINA_FORECAST_FORMATION`) routed
by `MARINA_FORECAST_ROUTE`. The API adds only `runs`, `researchRounds` and `critique`.

**Scoring a typed answer.** A typed answer linked to a resolver Sample (`resolves:` or
`forecast track`) is scored when it resolves (`src/forecast/typed-score.ts`): a choice by
multiclass Brier from its distribution (else its pick), a multi-select by per-option Brier, a
ranking by top-k overlap, a text answer by normalised exact match, and a number by CRPS from its
uncertainty. The outcome is matched to the answer's own options; one that matches none leaves the
answer open rather than scoring it against a guess. Each scored answer becomes an outcome for the
lesson loop.

**Retrieval isolation** (for past cutoffs). Date-filtered engines (`tavily:`, `exa:` with
`EXA_API_KEY`) only return pages published inside the window. Any other engine can be wrapped with
`MARINA_FORECAST_RETRIEVAL_FILTER=strict`, which keeps a research line only when every page it
cites has a known publication day on or before the cutoff (the engine's date, else a date in the
URL), it cites no live-result page (encyclopedias, scoreboards, markets, charts) and it names no
later day (`src/arena/research/isolation.ts`). `closed-book` as the retriever does no retrieval at
all — a lower bound.

**Evidence cutoff.** Each answer uses nothing published after a cutoff: `asOf` when given, else
the earlier of now and the question's `endTime`. Research asks for nothing later, search engines
that filter by date (Tavily) drop later results, sources dated after the cutoff are discarded,
lookups read values as of the cutoff, and lookups that only know current values are skipped when
the cutoff is in the past. The cutoff
and how it was chosen are recorded on the answer; a past cutoff adds a caveat, because engines
without date filters can still surface later pages.

**Evidence depth.** The citation check verifies a line with figures when every figure is on a
cited page (read in either the English or the continental-European number format) and a line
without figures when its whole text is on the page verbatim; anything else is never evidence. The
dossier each run reads is sized to the analysts' context window, and the judge reads up to twelve
chunks of verified text. The question's named resolution page is read first and its
source searched first. When fewer than five lines verify, one more round searches before the runs;
otherwise, when no run is grounded in verified evidence, that round searches for what the runs and
the judge left unverified, and the runs are redone only if it verified something new (the first
runs stay in `initialRuns`). When the runs disagree, one round searches the point they disagree on
and one more run reads it (`crux: true`), pooled with the others.

The typed answer object keeps every stage — plan, each research round (with its retrieval funnel
and warnings), lookups, every run with its reason and weight, the combination and its support, the
critique, the cutoff, sources, verification, evidence budget, judge record, cost and time. In-world answers are saved like any other forecast.

## Priors, calibration, the skeptic crew and routing

Four mechanisms from Marina's [Social Simulation Arena](arena.md) forecaster, generalised to any
typed question. All are opt-in, and each learns only from **resolved history visible at the
forecast's cutoff**: a record counts only once its outcome was known at or before the cutoff, and
a question never learns from its own record (the same rule as lessons).

**Resolved history** (`MARINA_FORECAST_HISTORY`, a JSON-lines file; `src/forecast/history.ts`). One
record per resolved forecast: the forecast in numbers before adjustment, the prior it had, the
outcome as option ids or a value, when the outcome became known, and optionally the formation and
the board's score. Option labels are kept only as short hashes. No question or answer text is
stored. Adapters append records as questions resolve (`recordFromAnswer` in
`src/forecast/adjust.ts`).

**Prior shrink** (`MARINA_FORECAST_PRIOR=on`). A strong baseline caps a forecaster's large misses,
so the answer is pooled toward the best prior available at the cutoff:

1. a market, community or statistical forecast the caller supplies (`priors` on
   `POST /v1/forecast`: `source`, `distribution` or `value`/`sd`, and `at`, the time it was
   observed — a prior observed after the cutoff is rejected and the rejection recorded). A
   `statistical` prior comes from data rather than people: a series' own history or a published
   reference class's base rate (see [Statistical priors](#statistical-priors));
2. one priced market a lookup matched, for a yes/no question (two or more matches give no prior);
3. for a number, the freshest official reading (the lookups' anchor);
4. the base rate of the question's class in resolved history (the caller's `category`, else the
   answer type) — per recurring option label for a choice, per class for a multi-select, smoothed
   toward uniform;
5. the type default: uniform over a choice's options, 0.5 per multi-select option.

Only an **informative** prior (1–4) earns a shrink. The type default is recorded but never shrunk
toward, because LLM forecasters already hedge toward the middle and pooling toward uniform makes that
worse. Probabilities are pooled in log-odds (a geometric pool for a choice); a number moves
linearly. Before there is evidence, the weight is `MARINA_FORECAST_PRIOR_WEIGHT` (0.5) toward a
supplied prior, and 0 toward anything else. A fitted weight replaces the default
only when it wins on held-out history (below). Each prior also records its time to close, and its
liquidity in USD when the caller supplies `liquidity`. When a bucket has enough records, the weight
is fitted within it: time to close of ≤ 7 days, ≤ 30 days or more, split by liquidity below or
above $10k when known. This lets a liquid market near its close earn more weight than a thin market
far from it.

**Calibration** (`MARINA_FORECAST_CALIBRATION=on`, or `observe` to fit and record without
applying). One map per answer group (`src/forecast/recalibration.ts`):

| group | map |
|---|---|
| a two-option choice (all yes/no questions share one) | Platt in log-odds on the first option |
| any other choice | Platt one-vs-rest, renormalised |
| a multi-select | Platt on each option's own probability |
| a number | a scale on the stated sd (the point is unchanged) |

**Cold start**: `MARINA_FORECAST_CALIBRATION=fixed:<a>` (for example `fixed:sqrt3`) applies a
fixed Platt slope with b = 0 from the very first forecast. It needs no history, so a new board can
use it. A slope above 1 extremizes, which counters the pipeline's hedging. You can also seed the
history with your own earlier resolved runs (records from the same pipeline, never other
forecasters' forecasts).

**Pooling and the tail guard.** `MARINA_FORECAST_POOL=logodds` averages the runs' probabilities in
log-odds (a geometric pool), so confident runs that agree are not dragged toward uniform. The
default is `linear`. `MARINA_FORECAST_PROB_CLAMP=<ε>` holds the final probabilities inside
[ε, 1 − ε]; use it on log-scored boards, where one confident miss is unbounded.

A monotone map never changes a choice's most probable option or a number's point estimate. It
changes the probabilities a proper score reads, and which options of a multi-select clear one half.

**The held-out rule** (both of the above): fit on the older 60 % of the visible history, compare
with the default (identity, or the default weight) on the newer 40 %, and adopt the fitted setting
only if it improves `MARINA_FORECAST_CALIBRATION_SCORE` (Brier or log; CRPS for numbers) by at least
`MARINA_FORECAST_CALIBRATION_MARGIN` (5 %, relative). It also needs at least
`MARINA_FORECAST_HISTORY_MIN` (50) visible records. If adopted, it is refitted on everything
visible. This is how the arena chooses each series' spread.

**What the answer records.** A question that asked for probabilities gets the adjusted ones. One
that asked only for a pick keeps its pick unless the adjustment moves the most probable option (or a
multi-select's set at one half); the replaced pick is recorded. The answer's `adjustment` holds the
raw forecast, the prior (source, value, time), the weight and the map with their held-out scores,
record counts, the newest outcome time used (always at or before the cutoff), and the final numbers.

**The skeptic crew** (`MARINA_FORECAST_FORMATION=skeptic`; `src/forecast/skeptic.ts`). This is the
arena's crew as a formation. After the ordinary research:

- the first analyst proposes as the **statistician** (base rates, readings, usual change);
- the second analyst proposes as the **analyst** (the specifics and sources);
- the critic, else the third analyst, acts as the **skeptic**. It sees the prior, both proposals,
  the research and the forecaster's own track record for this kind of question, and returns how much
  of the proposals' move away from the prior to *trust* (0 to 1).

The answer is the prior plus trust × (the proposals' mean − the prior), computed in log-odds by
code, not by a fourth model. The skeptic can only shrink toward an informative prior and never adds
extremity; for a number it may only widen the spread. Without an informative prior, the proposals'
log-odds mean stands unshrunk, and extremity is left to calibration. With one
configured model, every role runs on it. Rankings and short strings have no prior: the two
proposals are combined like runs.

**Formation routing** (`MARINA_FORECAST_ROUTE=observe|on`, `POST /v1/forecast`;
`src/forecast/routing.ts`). For each question class (the caller's `category` if it has enough
records, else the answer group), a candidate formation replaces the default only when both hold:

- on at least `MARINA_FORECAST_ROUTE_MIN_N` questions both answered, its paired gain in the board's
  score has a 95 % lower bound above zero;
- the gain clears the fishing margin 0.02 + 0.01·log₂(1 + candidates tried), the rule the benchmark
  ledger uses for promotions.

Otherwise the default formation answers. The decision is recorded on the answer (`route`).

### Statistical priors

Many questions are statistics before they are research: "will this series be higher on date d
than on date D?", or "will this kind of event happen again?". A model asked to reason about them
from a single number tends to make confident calls on what is close to a coin flip. A statistical
prior answers them from data, with no model call, and is supplied to the forecaster as a
`statistical` prior: the runs see it, and prior shrink pools toward it.

- **Series history as of a cutoff** (`src/forecast/series-history.ts`): FRED (vintage-correct
  with `FRED_API_KEY`: the observations as published the day before the cutoff; series without
  ALFRED vintages, such as licensed market prices, are read as observed and labelled not
  vintage), daily stock closes (split-adjusted only for splits before the cutoff, never the
  dividend-adjusted close) and any DBnomics series. Every point is dated before the cutoff's day.
- **The comparison prior** (`src/forecast/series-prior.ts`): the frequency of a rise over the same
  horizon by drift, momentum or the same calendar window in past years (each also shrunk halfway
  to 0.5). Each series chooses its own method by replaying every method at earlier cutoffs inside
  its own past; the winner must beat 0.5 by 5 % (relative Brier), or the prior is 0.5.
- **Reference-class rates** (`src/forecast/reference-class.ts`): from published outcomes, nested
  classes from broadest to narrowest, each pulled toward its parent in proportion to its evidence.
  Only outcomes settled two days before the cutoff count.

A **prior-only** forecast (`src/forecast/prior-answer.ts`) is the answer the best prior gives on
its own, at no cost. Benchmark adapters include it as a candidate configuration: a model
configuration that cannot beat its own prior on held-out questions is adding noise.

## Keeping score

Every in-world answer is saved with its full audit trail (`forecast list` shows yours). To have
one scored, link it to the resolver Sample it resolves on — `forecast <question>
resolves:kalshi/<ticker>`, or later `forecast track <id> kalshi/<ticker>`. When that market or
watch resolves, the answer is scored once: Brier for a probability, CRPS for a number. Typed answers
are saved with their answer as one string (`prediction`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | optional | retrieval and the Jev judge run through OpenRouter; without it the forecast runs degraded on whatever models are configured ([Single model](single-model.md)) |
| `MARINA_FORECAST_ANALYSTS` | three vendors via OpenRouter; else up to three configured models (a local runtime first) | comma-separated `provider/model` ids |
| `MARINA_FORECAST_RETRIEVER` | `openrouter-web:openai/gpt-6-luna@exa,search` with an OpenRouter key; else `search` (the search backend chain, keyless DuckDuckGo at the end) | the research engine(s) |
| `MARINA_FORECAST_DOSSIER_CHARS` | sized to the analysts' context window (12 000–60 000) | typed answers: research characters each run reads; verified lines are kept first |
| `MARINA_FORECAST_FOLLOWUP` | `on` | typed answers: one extra research round — before the runs when fewer than `MARINA_FORECAST_MIN_EVIDENCE` (5) lines verify, else after them when no run is grounded |
| `MARINA_FORECAST_DISAGREEMENT` | `on` | typed answers: when the runs disagree, search the crux and pool one more run |
| `MARINA_FORECAST_JUDGE` | `jev` | `jev`, `decisions` (the configured `MARINA_DECISIONS` backend — OpenJev, TypeSafe, a chat classifier; falls back to `jev` when none is set) or `none` (equal weights) |
| `MARINA_FORECAST_PLANNER` | the first analyst | typed answers: plans and names research gaps |
| `MARINA_FORECAST_CRITIC` | the planner | typed answers: the disconfirmation pass |
| `MARINA_FORECAST_RUNS` | `3` | typed answers: independent runs (1–9) |
| `MARINA_FORECAST_RESEARCH_ROUNDS` | `2` | typed answers: research rounds (1–4) |
| `MARINA_FORECAST_CRITIQUE` | `on` | `off` skips the critique |
| `MARINA_FORECAST_SELECTION` | `agreement` | typed answers: `confidence` takes the most self-confident run instead of combining by agreement (see Combine) |
| `MARINA_FORECAST_BUDGET_S` | unset (none) | typed answers: wall-clock budget per forecast. From about 75 % no further research round starts. At the cap, lookups, verification and the critique are skipped and the answer is combined from the runs that have finished (the first to finish, when none has). The answer then carries `budgetForced`, and a skipped check is `verified.verdict: "not_run"` |
| `MARINA_FORECAST_LOOKUPS` | `auto` | structured sources: `auto` (every one that can run here), `off`, or a list of `polymarket`, `kalshi`, `odds`, `fred`, `bls`, `markets` / `all` (see [Lookups](#lookups)) |
| `MARINA_FORECAST_MARINA_URL` / `_KEY` | `http://localhost:3300` | where `marina:<crew>` analysts are asked |

An analyst may be a crew: `MARINA_FORECAST_ANALYSTS=marina:answerer` asks the `answerer` crew on a
Marina server, so a crew in, say, the verification formation answers every run. The retriever
accepts `openrouter-web:<model>[@exa|@native]`, `sonar:<model>`, `tavily:<basic|advanced>` (with
`TAVILY_API_KEY`), `search[:<backends>]` (see [Search](search.md)) and `asof[:<providers>]`,
comma-separated to merge; an engine that fails while others answer is named in the round's
`warnings`. `asof` is keyless and
date-strict: GDELT news, Wikipedia revisions, Hacker News and arXiv, each bounded to the
forecast's cutoff instant, with news read from its Wayback capture at or before it. It is the
retriever to use for a backtest, since nothing published after the cutoff can reach the dossier;
see [Search](search.md).

### Lookups

Lookups are on by default wherever they can run: `MARINA_FORECAST_LOOKUPS` unset (or `auto`)
turns on every keyless lookup (`polymarket`, `kalshi`, `fred`, `bls`) plus `odds` when
`ODDS_API_KEY` is set; `off` turns them all off, and an explicit list picks some. Every surface
that forecasts — the `forecast` command, `bun run forecast`, `POST /v1/forecast`, and any benchmark
adapter built on the typed forecaster (FutureX, for one) — gets them through this one default, with
no adapter-specific code. Benchmarks that are not forecasting tasks (τ²-bench, SWE-bench) do not
use them. The same sources answer directly through the `data` command and the search room's
`markets` / `odds` / `series` verbs.

Each lookup is a plain data request through the URL guard (no model spend). One that is not
configured, fails or times out contributes nothing, and the answer records why. None of them
reads anything published after the cutoff: each either reads values *as of* the cutoff or, when
its source only knows current values, runs for a live cutoff only. The cutoff a lookup sees is
never later than now: a question that closes next week is looked up as of now (a data source
refuses a future as-of date, and FRED's "today" is the US Central date — a UTC cutoff of now is
read as FRED's current date).

| Name | Source | Live cutoff | Past cutoff | Key |
|---|---|---|---|---|
| `polymarket` | Polymarket markets | current prices of open markets | the last price at or before the cutoff (CLOB price history); never the resolution | none |
| `kalshi` | Kalshi markets | bid/ask midpoint | the last hourly candle at or before the cutoff; never the result | none |
| `odds` | The Odds API head-to-head | current pre-game odds, margin removed, averaged across bookmakers | the snapshot at or before the cutoff (`/historical`, a paid-plan endpoint) | `ODDS_API_KEY` |
| `fred` | FRED (St. Louis Fed) | latest observations | as published on the cutoff date (ALFRED vintages) | `FRED_API_KEY` for a past cutoff; keyless works live |
| `bls` | BLS public API | latest monthly observations | skipped (BLS serves only the latest revision) | `BLS_API_KEY` optional (raises the quota) |

Markets are matched to the question by their words (and by date when both sides know one) with a
conservative threshold, so an unrelated market's price is never shown. Sports odds show only games
that start after the cutoff, so every price is a pre-game price. Each lookup's result is kept on
the answer with its mode (`live` or `historical`) and the time its data reflects; a number's
anchor is kept as `anchor` (value, date, horizon in days and steps, spread).

## How good is it?

The same pipeline, pointed at the Social Simulation Arena's questions, is measured in
[docs/guides/arena.md](arena.md): structured data (the Civiqs nowcast) beat every leaderboard
entry on backtests; the value of the web-research agents is being measured forward, on questions
that had not resolved when they answered. Treat a single forecast as a well-sourced opinion, not a
guarantee.
