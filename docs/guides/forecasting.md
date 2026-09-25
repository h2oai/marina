# Forecasting any question

Marina answers forecasting questions with a probability or a number, backed by cited and checked
evidence and several models, in about 20–60 seconds for $0.03–0.10.

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
   weakly supported answers count for little.
5. **Aggregate** — probabilities are combined in log-odds, numbers as a weighted mean whose spread
   includes the analysts' disagreement.

The answer carries everything needed to audit it: each analyst's answer and reasoning, its
grounding score and weight, the sources, how many facts verified, cost and time — and a `caveat`
when the evidence was thin.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | required | retrieval and the Jev judge run through OpenRouter |
| `MARINA_FORECAST_ANALYSTS` | three vendors via OpenRouter | comma-separated `provider/model` ids |
| `MARINA_FORECAST_RETRIEVER` | `openrouter-web:openai/gpt-6-luna` | the research model |
| `MARINA_FORECAST_JUDGE` | `jev` | `jev` or `none` (equal weights) |

## How good is it?

The same pipeline, pointed at the Social Simulation Arena's questions, is measured in
[docs/guides/arena.md](arena.md): structured data (the Civiqs nowcast) beat every leaderboard
entry on backtests; the value of the web-research agents is being measured forward, on questions
that had not resolved when they answered. Treat a single forecast as a well-sourced opinion, not a
guarantee.
