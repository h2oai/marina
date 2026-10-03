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
3. **Lookups** (opt-in) — structured sources such as prediction-market prices join the dossier as
   ordinary cited lines.
4. **Citation check** — as above.
5. **Runs** — K independent answers (analyst models used in turn), each validated against the
   answer's shape and, with a judge, weighted by how well the verified facts support it.
6. **Combine** — by type: weighted plurality for a choice or a short string, per-option frequency
   (≥ half the weight) for a set, the median (a 20 % trimmed mean from five runs) for a number,
   Borda count for a ranking. The runs' agreement is the answer's `confidence`.
7. **Critique** — a second search looks for evidence *against* the leading answer, and a critic
   may propose another. The proposal replaces the runs' answer only when the critic's confidence
   exceeds the runs' agreement; both are kept in the record.

**Evidence cutoff.** Each answer uses nothing published after a cutoff: `asOf` when given, else
the earlier of now and the question's `endTime`. Research asks for nothing later, search engines
that filter by date (Tavily) drop later results, sources dated after the cutoff are discarded,
and lookups that only know current values are skipped when the cutoff is in the past. The cutoff
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
| `OPENROUTER_API_KEY` | required | retrieval and the Jev judge run through OpenRouter |
| `MARINA_FORECAST_ANALYSTS` | three vendors via OpenRouter | comma-separated `provider/model` ids |
| `MARINA_FORECAST_RETRIEVER` | `openrouter-web:openai/gpt-6-luna` | the research engine(s) |
| `MARINA_FORECAST_JUDGE` | `jev` | `jev`, `decisions` (the configured `MARINA_DECISIONS` backend — OpenJev, TypeSafe, a chat classifier; falls back to `jev` when none is set) or `none` (equal weights) |
| `MARINA_FORECAST_PLANNER` | the first analyst | typed answers: plans and names research gaps |
| `MARINA_FORECAST_CRITIC` | the planner | typed answers: the disconfirmation pass |
| `MARINA_FORECAST_RUNS` | `3` | typed answers: independent runs (1–9) |
| `MARINA_FORECAST_RESEARCH_ROUNDS` | `2` | typed answers: research rounds (1–4) |
| `MARINA_FORECAST_CRITIQUE` | `on` | `off` skips the critique |
| `MARINA_FORECAST_LOOKUPS` | none | `polymarket` adds current market prices |
| `MARINA_FORECAST_MARINA_URL` / `_KEY` | `http://localhost:3300` | where `marina:<crew>` analysts are asked |

An analyst may be a crew: `MARINA_FORECAST_ANALYSTS=marina:answerer` asks the `answerer` crew on a
Marina server, so a crew in, say, the verification formation answers every run. The retriever
accepts `openrouter-web:<model>`, `sonar:<model>`, `tavily:<basic|advanced>` (with
`TAVILY_API_KEY`) and `asof[:<providers>]`, comma-separated to merge. `asof` is keyless and
date-strict: GDELT news, Wikipedia revisions, Hacker News and arXiv, each bounded to the
forecast's cutoff instant, with news read from its Wayback capture at or before it. It is the
retriever to use for a backtest, since nothing published after the cutoff can reach the dossier;
see [Search](search.md).

## How good is it?

The same pipeline, pointed at the Social Simulation Arena's questions, is measured in
[docs/guides/arena.md](arena.md): structured data (the Civiqs nowcast) beat every leaderboard
entry on backtests; the value of the web-research agents is being measured forward, on questions
that had not resolved when they answered. Treat a single forecast as a well-sourced opinion, not a
guarantee.
