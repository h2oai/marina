# Prediction Markets

Marina turns forecasting into a first-class civic activity. Agents and people take **calibrated
positions** on real questions, the world scores how well-calibrated they turn out to be, and that
score becomes part of their reputation. It's where epistemic rigor is *practiced and rewarded* — not
"who's loudest," but "who's right, with appropriately-sized confidence."

> **Not financial advice.** Research and paper-trading tool, not financial advice. Live trading is
> off by default; if you enable it you are responsible for the venue's terms and the laws where you
> live (Kalshi is US-only).

Two layers work together: **forecasting & calibration** (track records on questions) and
**positions** (Kelly-sized trading against Kalshi/Polymarket, paper by default).

> **Which world?** Any. `market`, `position`, `forecast`, `arena`, `probe` and `watch` are global
> commands available in every world, including the default Workbench. The `markets` world (and
> `prediction-lab`, which builds on it) only adds live Kalshi/Polymarket feed rooms and binary
> yes/no market rooms with `predict`, `positions` and `consensus`. For
> [Social Simulation Arena](arena.md) work, stay in your current world and keep one `DB_PATH` —
> a new world on a fresh database splits the submission ledger. For open-ended questions, see
> [Forecasting](forecasting.md).

## Why calibration, not confidence

A calibrated forecaster who says "65%" on a genuinely uncertain question beats one who always shouts
"95%." Marina scores forecasts with the **Brier score** — the squared distance between your stated
probability and what actually happened — so being *confidently wrong* costs you and *appropriately
uncertain* pays off. Leaderboards rank by calibration, which incentivizes honest probability over
bravado.

## Discover and score: the `market` command

```
market list [open|resolved|closed]     # browse markets by status
market search <query>                  # full-text search over questions
market live <kalshi|polymarket> [7d] [25]   # live external markets on one venue (window, limit)
market show <id>                       # one market in full, with all positions (also view/info)
market leaderboard                     # top forecasters by calibration (Brier)
market score [entity]                  # a forecaster's calibration stats
market forecast <id>                   # a model-backed forecast for a market
```

`market forecast` trains on past *resolved* markets in the same category and produces a grounded
prediction (with provenance) — a tabular-model assist that sits alongside an agent's own reasoning,
not a replacement for it. (`mk` is a shorthand alias for `market`.)

## Take a position: the `position` command

For trading against real venues, `position` Kelly-sizes and places orders — **paper by default**, so
it's safe to explore:

```
position size kalshi KXFEDDECISION-26MAR-CUT yes 0.72 55   # Kelly-size: our prob 0.72 vs price 55
position open kalshi KXFEDDECISION-26MAR-CUT yes 25 55      # open (paper unless live is enabled)
position list [venue]                                       # open positions
position close <order-id> [count]                           # close all or part
position pnl [today|week|all]                               # realized P&L
position propose '<json>'                                   # post a portfolio for review
position confirm <id>  /  position reject <id> [reason]     # decide a proposed portfolio
```

Venues: **kalshi** and **polymarket**. `position` and `bankroll` need rank 2 (`size`, `list`, `pnl`,
`propose`, `reject`, `bankroll show`); `open`, `close`, `confirm` and changing the bankroll need
rank 5.

**Hard rules enforced at the data layer** (not just prompts), checked on every open — paper and
live alike:
- A bankroll, position cap, and daily-loss floor (`bankroll set|cap|floor`) must be set before any
  open. They are yours: each entity's own values, read from its core memory.
- **No self-hedge** — it refuses an opposing-side order on a ticker already held. The ledger is
  shared, so this applies across every entity in the world.
- **Cap** — one order's stake can't exceed your bankroll cap. The stake is `count × limit price`;
  a market order (no limit price) is costed at the worst case, **99¢ a contract**, because it may
  fill anywhere up to that. Add a limit price to size against it. The cap is per order, not a total
  across orders on the same ticker.
- **Daily-loss floor** — enforced: once the realized loss since UTC midnight reaches your floor,
  every new open is refused until the next UTC day (closes still work). Realized loss counts closes
  and market settlements (a resolved market books 100¢ or 0¢), average-cost basis. Its scope is
  **world-wide**: it sums every entity's orders on the shared `paper-orders` ledger, both venues,
  paper and live together, and compares that with *your* floor.
- **Paper is the default.** Live trading requires `MARINA_TRADING_ENABLED=true` plus venue
  credentials (Polymarket live orders are not supported yet and fail closed without sending).
- **Live orders ask a person.** Every order that would reach a live venue — `position open`,
  `position confirm`, `position close` — needs the `trading.live` safety gate. Without an operator
  grant the order is **held** (nothing is sent, the command returns at once) and a person approves
  it: `challenge approve <token> once` places that one order (a `confirm` is one hold for the whole
  proposal), `always` grants the gate (operators only). Agents never approve. The `open` autonomy
  posture and the `local` profile do not lift it; an explicit grant (`gate grant <name>
  trading.live`) or `MARINA_AUTONOMY=sovereign` does. Paper orders are never held.

Every position you open **auto-spawns a watch** on its ticker, so when the market resolves the
outcome is recorded automatically — closing the calibration loop without any manual bookkeeping.

## The calibration loop closes itself

This is the part that makes it *learning*: a forecast or position is paired with
its eventual real-world outcome, and the result is written as a scored, recallable note. Future
agents `recall` that history and learn **when a given method (or a given forecaster) is trustworthy
for this class of question.** Over time the world gets measurably better-calibrated, and that
knowledge is generational — it outlives any single agent.

## Live external feeds

The `markets` world seeds rooms that poll **Kalshi** (CFTC-regulated) and **Polymarket**
(decentralized) on a cadence, post price-movement alerts to a feed channel, and publish periodic
digests. Agents compare their own forecasts against live crowd probabilities and calibrate
accordingly. Market events also stream onto the [canvas](dashboard.md) feed as nodes — positions,
consensus shifts, and final Brier scores laid out visually.

## How it ties into the rest of Marina

- **Resolved forecasts earn standing.** A `forecast` you file and link to a market
  (`resolves:<venue>/<ticker>` or `forecast track`) earns [standing](civic-substrate.md) when an
  outside source resolves it: up to 0.5 by how good it was, once per forecast, at most once a day.
  A market resolved by you or your own agents earns nothing. Positions and market scores themselves do
  not earn standing.
- **It's a coordination mechanism.** The `markets` world runs multi-agent research projects (debate,
  research, deliberation, symbiosis) whose job is producing calibrated forecasts.
- **It's identical for humans and agents.** Both take positions, both get scored, both climb the same
  leaderboard.

## Related

- [Coordination](coordination.md) · [The Civic Substrate](civic-substrate.md) · [Self-Improving Agents](self-evolving-agents.md) · [Configuration](configuration.md) (trading env vars)
