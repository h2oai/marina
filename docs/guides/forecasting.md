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

**Lessons.** A forecast can recall lessons from questions that have already resolved: a terse,
typed record per outcome — answer type, a category, the failure mode (`wrong option`, `numeric
over 6.0%`, …) and one corrective rule — written only after the outcome is known
(`src/forecast/lessons.ts`). They are canonical memory records (reflection tier, subject
`forecast-lesson`, `valid_time.from` = when the outcome became known) written through the memory
service. Recall is lexical and byte-budgeted, and a lesson is visible to a forecast only when its
outcome was known at that forecast's evidence cutoff (`visibleAt`) — so a forecast made "as of"
September never sees a lesson learned from an October result. The lessons used are recorded on
the answer (`lessons`), and the plan, the runs and the critic all see them. A lesson retired by a
`revise` that closes its `valid_time` (history kept) is never recalled; the memory service's
`search` excludes it before ranking, so retired lessons don't crowd out live ones.

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

The typed answer object keeps every stage — plan, each research round, lookups, every run with
its reason and weight, the combination and its support, the critique, the cutoff, sources,
verification, judge record, cost and time. In-world answers are saved like any other forecast.

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
| `MARINA_FORECAST_RETRIEVER` | `openrouter-web:openai/gpt-6-luna` with an OpenRouter key; else `tavily:basic` with a Tavily key; else `asof` (keyless) | the research engine(s) |
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
accepts `openrouter-web:<model>`, `sonar:<model>`, `tavily:<basic|advanced>` (with
`TAVILY_API_KEY`) and `asof[:<providers>]`, comma-separated to merge. `asof` is keyless and
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
