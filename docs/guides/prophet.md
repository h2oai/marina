# Prophet Arena

[Prophet Arena](https://prophetarena.co) scores forecasting agents live on real prediction-market
events. Its Python SDK (`prophet-arena`, MIT) is used to register and run agents.
`benchmarks/prophet/marina_agent.py` is a thin agent for that SDK. It sends each event to a Marina
server's `POST /v1/forecast` as one typed question, and returns the answer's per-outcome
probabilities.

## How events are asked

| Event | Asked as | Returned |
|---|---|---|
| mutually exclusive outcomes | a choice with probabilities | probabilities that sum to 1 |
| otherwise | a multi-select with each outcome's own probability | marginals, never renormalized |
| a single outcome | a yes/no choice | the probability of yes |
| more than 64 outcomes | balanced parts of at most 64 outcomes, one question each | the parts' probabilities (an exclusive event's are normalized to sum to 1) |

The question carries this context: the event's rules, the crowd prices, and the event's frozen
context sources.

When an event's window has already closed (a dataset replay with `prophet eval`), the evidence is
frozen at the window's close. A live window is forecast as of now.

The rationale carries the runs' reasons, plus the formation and models that produced it.

The agent registers as `h2oai-marina` ("H2O.ai Marina") on the `agentic` track, because Marina does
its own research. The track cannot be changed after registration.

## Credentials

| Variable | Where it comes from |
|---|---|
| `ARENA_API_KEY` | A `pa_live_…` key created at prophetarena.co/profile/api-keys (or stored with `prophet login`). |
| `MARINA_URL` | The Marina server (default `http://localhost:3300`). |
| `MARINA_API_KEY` | One of that server's `MODEL_API_KEYS`. |

The server's own environment chooses the models and formation, never the caller:

- `MARINA_FORECAST_ANALYSTS`, `_PLANNER`, `_CRITIC`, `_VERIFY`, `_RUNS`, `_LOOKUPS`;
- `MARINA_FORECAST_FORMATION` (`ensemble`, `delphi` or `tournament`).

To use a configuration chosen by backtest, run `bun run forecastbench select --sources
kalshi,polymarket` (Prophet events are Kalshi markets), then set those variables to the pick's
models and formation. See [ForecastBench](forecastbench.md).

## Running

```bash
pip install prophet-arena
cd benchmarks/prophet
python3 -m unittest test_marina_agent.py                            # offline mapping checks
prophet eval marina_agent.py --dataset prophet-arena-subset-100     # local, leaderboard-grade scoring
prophet run marina_agent.py --dry-run --once                        # what it would submit
prophet submit h2oai-marina && prophet run marina_agent.py          # live (an operator act)
```

A typed forecast takes minutes. The agent waits up to 15 minutes per event.

## Write-back: filing and resolving answers

Prophet answers teach Marina only once they are filed on Marina's outcome path and resolved there.
The agent appends each answer it gets to a journal: `data/answers.jsonl` under its working
directory, or the path in `PROPHET_ANSWER_JOURNAL` (`off` disables it). A wide event asked in parts
gets one line per part. The journal is local, and the agent never fails a forecast because of it.

```bash
# File the journal's answers on the world database (each answer once).
bun run benchmarks/prophet/writeback.ts file --journal benchmarks/prophet/data/answers.jsonl --db marina.db
# When events resolve: score every filed answer of each resolved event.
bun run benchmarks/prophet/writeback.ts resolve --resolutions resolved.json --db marina.db
```

`--db` defaults to `DB_PATH`, then `marina.db`. Point it at the database of the server the agent
calls.

- **Filing.** Each answer is filed under the owner `marina:prophet`, with source `prophet-arena`
  and board id `prophet:<event>` (or `prophet:<event>#<part>`). A live window files with eval
  mode `live`: the answer teaches lessons and writes forecast history, but it never earns standing.
  A dataset replay (a past window, sent as `measure`) files with eval mode `measure`: it teaches
  other boards but never Prophet's own measurements, and it never writes history.
- **Resolving.** `resolved.json` is a JSON array, or JSONL, of
  `{ "event": "<id>", "outcomes": ["<names that happened>"], "resolvedAt": "<iso>" }`. A single
  `"outcome": "<name>"` also works, and `resolvedAt` defaults to now. Each filed answer is scored
  through the one outcome path, which records one outcome. The server's delivery pass then turns
  that outcome into a lesson and a history record. A yes/no event resolves on whether its
  outcome happened. A part with none of its outcomes resolved stays open, because a multi-select
  needs at least one true option.
