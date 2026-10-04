# Social Simulation Arena

Marina can enter the [Social Simulation Arena](https://social-simulation-arena.com), a live
forecasting benchmark run by Social Atoms at MIT. Every week about a dozen questions open:
presidential approval (Economist/YouGov, Civiqs, Morning Consult), consumer sentiment (UMich,
NY Fed, AAII), Google Trends shares and the Wikipedia weekly top 10. An entrant forecasts each
one before the number is published. Forecasts are sealed until the round locks, then scored in
public against a **persistence** reference (repeat the last value): skill 0 ties it, above 0 beats it.

Marina enters as a *participant* through the arena's signed route: it signs each forecast with its
own Ed25519 key and posts it itself. Nothing is exposed to the internet and no credential is shared —
the registration carries only the public key.

## What Marina files

`src/arena/forecast.ts` is the baseline every round gets. It keeps persistence's mean. The arena's
own persistence uses a fixed `sd = 1.5` whatever the series' scale, so Marina replaces the spread
with one sized to how the series moves, but only where the series' own history supports it on
the mean of per-round skill. Everywhere else it files exact persistence.

| Round shape | Marina's answer |
|---|---|
| Number (`continuous_normal`) | persistence mean ± calibrated or 1.5 spread |
| Profile (`profile_energy`) | the same, per cell |
| Ranking (`ranking_list`) | last-7-day Wikipedia pageview totals, Main_Page and non-articles excluded |

`arena show <round_id>` prints exactly what would be filed and which spread rule each series used.

### Model backends

`MARINA_ARENA_FORECASTER=model:<provider/model>` puts a model on top of the baseline — any model
Marina can route (`openrouter/deepseek/deepseek-v4-pro`, `anthropic/claude-sonnet-5`, …), with the
provider's usual key. The model sees the question, the frozen history and the baseline, answers a
distribution, and that answer is **shrunk toward the baseline** (`MARINA_ARENA_MODEL_WEIGHT`,
default 0.5); a malformed answer, a failed call or a jump beyond four baseline sds keeps the
baseline. Closed-book: no web.

Measure before you switch — nothing is filed:

```bash
bun run arena evaluate --forecaster model:openrouter/deepseek/deepseek-v4-pro --weight 0.25
```

prints skill per family for the baseline, the blend and the raw model on every resolved round,
with the model's cost. Run-to-run model noise is large at the current sample size, and a model
whose training data covers a round's release could know its answer; weigh rounds after its cutoff.

### The crew

`MARINA_ARENA_FORECASTER=crew:<model>` — or `crew:<statistician>,<analyst>,<skeptic>` to give each
role its own vendor — runs three roles per numeric round over the baseline (`src/arena/crew.ts`):

| Role | Sees | Does |
|---|---|---|
| statistician (the quant) | the dated weekly history and, for Civiqs, the last 21 **daily** tracker readings (from the newest snapshot fetched by the lock — archive only once the lock has passed, the live dashboard for an open round) | proposes a distribution; told that the start forecast is the default and that trend or reversion stories usually lose at this horizon |
| analyst | the question, the last 8 dated values, the crew's **lessons** for this series | proposes from pollster behaviour and past misses |
| skeptic | the start forecast, both proposals and the **lessons** (the crew's track record here) | decides how much of their move to trust (0 = stay on the start forecast) |

Every role — and the research analysts and the `model:` forecaster — is told the same true account
of the round (`src/arena/prompt-context.ts`): what the start forecast is (the **nowcast** — the
freshest daily Civiqs reading, with its date and the days left to resolution — or the persistence
baseline), the resolution rule (Civiqs: the dashboard value on the release day, i.e. the daily
readings after the lock, and Civiqs re-estimates its daily history nightly), the scoring rule
(CRPS skill vs persistence; moving on weak evidence loses), and every value with its date.

Aggregation is deterministic code: the proposals' mean move, scaled by the skeptic's trust, with
wild or broken proposals dropped — the skeptic can shrink a move, never enlarge it. After a filed
round resolves, the autopilot writes a **lesson** note (outcome, the crew's error next to
persistence's, which way it leaned) that the analyst recalls for that series next time; lessons
only ever describe rounds already published. `arena evaluate --forecaster crew:…` replays the
resolved rounds in lock order with the same learning, in a throwaway database (`--no-learn` to
compare).

### Formations — Marina's orchestration patterns as forecasters

`MARINA_ARENA_FORECASTER=formation:<pattern>:<model>[,<model>…]` (up to twelve models) runs one of
Marina's orchestration patterns as a small forecasting protocol (`src/arena/formations.ts`) over
the same truthful round context as the crew, started from the nowcast:

| Pattern | Protocol |
|---|---|
| `ensemble` | independent proposals; the control for the others |
| `deliberation` | propose → see the others' anonymized proposals and reasons → revise once |
| `debate` | two sealed advocates (above the start / at or below it); the last model judges direction and trust |
| `chorus` | proposals broadcast → each member critiques one peer → each revises from the critique it got |
| `pipeline` (`cascade`) | quant → analyst (sees the quant's handoff) → skeptic (sets trust) — the crew, strictly sequential |
| `mapreduce` | one model per driver (level/trend, calendar/publication, source quirks); reduce = sum of confidence-shrunk adjustments |
| `blackboard` | a shared scratchpad; two passes in which each model adds or corrects evidence and a number |
| `symbiosis` | a quant (the numbers) and an analyst (the context) exchange contributions; a revision must credit the partner's; a gap > 0.5 start-sd triggers another exchange (at most two) |
| `research` | hypothesis → the model picks a check (recent mean, trend, last-k deltas, typical move, daily readings after the last value) → Marina COMPUTES it → keep or revert → revise (two checks) |
| `delphi` | independence before influence: round 1 independent → Marina computes an anonymized panel summary (median and range of the means and sds, short reason snippets, no names) → each model revises once having seen only that summary → median of the revisions |
| `tournament` | proposals {mean, sd, rationale} meet in pairwise knockout matches judged by the last model (with three or more models the judge does not propose); an odd candidate out gets a bye; a match without a usable judgment advances the candidate nearer the start; the champion is settled at the default trust × the field's agreement; the bracket is recorded |
| `verification` | each proposal is checked on separate aspects — mean within the series' typical one-step moves of the start (90th percentile of the last 30 changes, at least a quarter start-sd), sd within 0.5× to 3× of the history's RMS change / the start sd, every cited `{date, value}` present in the data shown — and, when the research judge is available (`MARINA_ARENA_RESEARCH_JUDGE`, as for `research:`), whether the rationale follows from the series data (an outage never passes); a proposal counts only if it passes every aspect; median of the passers, the start forecast when none pass; every verdict is recorded |

Aggregation is deterministic with the crew's clamps: proposals beyond 4 start-sds are dropped, the
median move is scaled by a trust (0.5 × the proposals' agreement, or the judge's/skeptic's), the
final move is capped at 2 start-sds, and the sd blends by the same trust with a floor of half the
start sd. Each round's calls, statuses, trust and cost are kept in the evaluate/shadow record,
with the pattern's own audit under `protocol` (delphi's summary, the tournament bracket,
verification's aspect verdicts and judge record).

**Profile rounds.** On a `profile_energy` round (a Google Trends basket, Civiqs or YouGov subgroup
profiles) every pattern runs the same protocol over the whole profile
(`src/arena/formation-profile.ts`, shared shape helpers in `src/arena/profile-shape.ts`):

- the prompt shows each cell's last 12 dated values and its start forecast (the nowcast's dated
  reading where the start used one), and a member answers **every cell in one reply**
  (`{"profile": {"<cell>": {"mean", "sd"}, …}}`) — one call per member per step, never one per
  cell;
- each reply is validated cell by cell: a missing or malformed cell, or one beyond 4 of **its own**
  start sds, is left out of that proposal (the step's status names it) while the rest of the
  proposal counts;
- aggregation runs per cell with the scalar clamps — median of the proposals that answered the
  cell, trust 0.5 × their agreement on that cell (or the judge's/skeptic's), move capped at 2 of
  the cell's start sds, sd blended with a floor of half the start sd; a cell nobody answered keeps
  its start;
- **share baskets**: when the round's unit or question says its cells add to 100 (or the unit
  names a share) AND its last published values add to 100 within 2 points, the aggregated means are
  rescaled proportionally to 100 (every mean × 100 / Σ means; sds unchanged). Independent cells
  (subgroup profiles) are never rescaled.

Per pattern: debate's sealed sides become CHANGE (the profile moves from the start) and STAY, and
the judge rules change or stay with one trust; pipeline takes the analyst's cell where it gave one,
else the quant's; mapreduce's specialists propose a per-cell adjustment and the reduce sums them per
cell; symbiosis exchanges again when the largest per-cell gap exceeds 0.5 start sds; research's
checks name a cell and run on its history; delphi's anonymized summary is per cell; the tournament
judge compares whole-profile candidates (a match without a usable judgment advances the smaller
total move in start sds); verification checks range and sd **per cell** (a failing cell drops out
of that proposal) and citations (`{cell, date, value}`) and the judged "follows" per proposal.
`+then:` hands the second formation the first's profile and proposals, and `+research@` builds the
dossier from an item-by-item brief. The record keeps `profileProposals`, and under `protocol` the
pattern's audit plus `cells` (per-cell proposals counted, trust, agreement) and `shares` (the
rescale: sum before, factor). Ranking rounds keep their start.

Auction, ledger and sharding are orchestration patterns for allocating or partitioning work, not
for combining views of one number, so they have no formation.

**Compositions.** `+then:<pattern>:<models>` adds a second formation that judges the first one's
handoff (e.g. `formation:mapreduce:…+then:debate:…`); both shrink toward the same start, so a
chain cannot compound a move. `+research@<retriever>[,…]` (retrievers as in `research:`) puts a
research crew in front: it builds ONE dated dossier per round with the research agent's
retrieval, checks every cited figure against its page, and hands only the **verified** lines to
every member of every formation. A composition with `+research@` reads today's web, so
`arena evaluate` refuses it — record it with `arena shadow run`.

Measure a formation before filing it with `bun run arena evaluate --forecaster formation:…` (all
resolved rounds, per family, with cost; `--shape profile` scores only the resolved profile rounds,
per family and with cost, and runs no numeric round); compositions with `+research@` are recorded with `arena
shadow run`. Model reliability matters as much as the pattern: a model that spends its output
budget on reasoning and returns no JSON silently turns a five-model formation into a smaller one,
so check each run's failed-proposal count in the record.

### The Civiqs nowcast (`nowcast`)

Civiqs publishes **daily** trackers but the arena samples them on Fridays, so a round's history
ends at last Friday while, by its Wednesday lock, several newer daily readings are public. The
arena archives every snapshot it fetches (`civiqs/` in its repo); `MARINA_ARENA_FORECASTER=nowcast`
(the default when unset) moves each Civiqs mean — topline or profile cell — to the freshest daily
reading in a snapshot **fetched before the lock**, keeping the baseline's spread; every other round
is the baseline.
Deterministic and leakage-free, so it backtests (see *Integrity* below).

**Live reading for open rounds.** For a round whose lock has not passed, the nowcast also reads
the Civiqs dashboard (`src/arena/research/civiqs-live.ts`, one paced request per tracker) and uses
whichever reading is fresher. A round whose lock has passed never reads live data, so backtests
are unaffected. `MARINA_ARENA_CIVIQS_LIVE=off` turns it off.

**Horizon corrections (experimental, off by default).** A round resolves on the reading dated its
Friday release day, while the newest reading at the lock is often several days older (the horizon
*h*). `MARINA_ARENA_NOWCAST_HORIZON` adds two corrections (`src/arena/research/civiqs-horizon.ts`),
each computed only from snapshots fetched by the lock:

- `drift`: a damped local trend, the least-squares slope of the last 7 readings projected *h* days
  with damping φ (`MARINA_ARENA_NOWCAST_DAMPING`, default 0.8). It applies only when that series'
  own walk-forward history at the same horizon says a trend projection beats carrying the last
  value forward.
- `sd`: sd(*h*). This is the walk-forward *h*-step error of the centre in use, plus Civiqs's
  revision noise at both ends: earlier snapshots' newest readings are compared against the lock
  snapshot's value for the same day. It is floored at 0.3 and capped at 5.
- `both`: both corrections.

They apply wherever the nowcast is the start forecast (`nowcast`, formations, research), and only
when the nowcast's reading is fresher than the round's own history. The same corrections are in
the signal language as the `nowcast-drift:<φ>` centre and the `horizon` spread, so
`bun run arena discover` and `evaluate` can measure them. Keep the default off until a backtest
earns the switch.

Scope a measured correction with `MARINA_ARENA_NOWCAST_SERIES`, a comma-separated list of
Civiqs series ids (for example `civiqs_net_econ_now`). Unset means every series; an empty list
means none. Each forecast retains its observation date, target horizon, selected daily or weekly
anchor, snapshot reference, and projection decision. Model prompts distinguish the raw reading
from the projected start so they do not apply the trend twice. A daily snapshot older than the
weekly anchor does not replace it; the trace records that decision.

`bun run arena shadow horizons <round_id|due>` compares off, drift at damping 0.8 and 1.0,
spread-only, and combined correction. It makes no model calls and files nothing. Candidates
share frozen archive reads and one live read per tracker for each round; a batch finishing after
the lock records nothing. Every variant has its own configuration fingerprint and is scored
against future published outcomes through `shadow score`.

Add `--weekly-anchor` to include two additional experimental policies (damping 0.8 and 1.0).
When the weekly anchor is newer than the daily series, these keep the weekly **level** and
project using the older daily slope, damped for its age. A matched-horizon walk-forward gate
must favour the projection; gapped daily histories and slopes older than seven days are rejected.
They retain the original spread and do not change the configured submission policy.

**Paired model experiments.** `bun run arena shadow compare <round_id|due>` uses the configured
Delphi route, or an explicit `--forecaster formation:delphi:<models>`, to record four scalar
candidates: the statistical start, closed-book Delphi, the same Delphi with verified FRED
evidence, and uncertainty calibration of that final forecast. The start, lock and dossier are
captured once; each model receives its own copy. FRED is the intentional evidence difference,
not a fresh start or a different model roster. Missing archive reads remain missing throughout
the experiment. The ledger stores the complete comparison inputs, their hash, configuration,
candidate failures and costs. This runs two formations; calibration adds no model calls.
`due` selects scalar rounds inside the normal filing window and reports non-Delphi routes as
inapplicable to this experiment; it does not alter their submissions.

`bun run arena shadow paired-score` scores the latest matched batch per round and configuration.
Incomplete or failed batches are reported explicitly and excluded from paired performance claims.
They are not silently replaced by an older successful batch. A batch finishing after lock is not
recorded as prospective evidence. The ordinary `shadow score` remains a per-variant view; use
`paired-score` to compare these experiments on identical rounds.

Uncertainty calibration is **shadow-only**. It uses recorded errors from complete forecasts of
the exact same estimator/configuration, within the same family and unit, weighted by similarity
of horizon and source age. It needs at least twelve distinct resolved rounds: at least eight in
an earlier training block and four in a later validation block. Waves stay together; training
outcomes must have been published before the validation forecasts. A bounded spread adjustment
must improve validation mean normalized CRPS by five percent; the centre never changes.
Missing or insufficient history leaves the forecast unchanged and records the reason. The trace
includes interval coverage and training/validation round IDs. This is a qualification gate, not
evidence of a live win or a substitute for future matched results.

**Replacing a filing.** The arena's signed intake keeps every version and scores the newest one
accepted before the lock (up to 120 per round). `bun run arena submit <round|due> --replace` files
a newer version of an accepted round; an unchanged forecast is not re-sent, and the autopilot never
replaces.

Keep an early accepted forecast, then schedule an operator refresh closer to the lock. For
example, an hourly `MARINA_ARENA_WINDOW_HOURS=1.1 bun run arena submit due --replace` selects
rounds locking within 66 minutes, while preserving the five-minute safety margin. Allow enough
time for the selected formation and any simultaneous deadlines. Runners sharing a checkout or
submission ledger should use one exclusive lock; a refresh failure leaves the earlier accepted
forecast in place.

Submissions also retain a local `detail` trace (migration 154): the frozen lock and its hash,
forecast origin, model proposals and fallbacks, research evidence, explicit nonsecret strategy
settings, and start/completion timestamps. It is separate from the signed wire body and survives
retries unchanged. Signing uses the completion time, and the five-minute deadline margin is
checked again after forecasting so slow retrieval cannot silently consume the filing window.

**How the board ranks.** An entrant's row is its mean skill over the rounds it answered —
unanswered rounds are not counted — and skill is `1 − CRPS / persistence CRPS` against a
persistence null frozen when the round's call window opens (the round's weekly history, so for
Civiqs last Friday's value).

### Per-family routing (`routed`)

No single forecaster wins every family. `MARINA_ARENA_FORECASTER=routed` answers each tracker
family with its own forecaster, read from `MARINA_ARENA_ROUTES` (`family=spec;…;*=spec`); unset,
every family gets the nowcast. Quote the value in `.env` (it contains `;`). Or write a spec inline:
`route:civiqs=nowcast;aaii=formation:chorus:<m>,<m>,<m>;*=baseline`. A route of `skip` leaves a
family unanswered: `submit` reports it as "not answered" rather than a failure, and `evaluate`
leaves it out of the mean, as the board does. Choose routes from `arena evaluate` per family,
then shadow them before trusting them — samples per family are small.

The nowcast refuses rounds with no history (see [no-anchor mode](#the-research-agent-research)).
To answer them, route their family to research, e.g. `<family>=research:<m>[,<m>…]@<retriever>`;
routes are per family, so the family's rounds that do have history go through research too
(anchored as usual).

### TabH2O (`tabh2o`, experimental)

`MARINA_ARENA_FORECASTER=tabh2o` asks [TabH2O](https://tabh2o.h2oai.com/docs), H2O.ai's tabular
foundation model (`TABH2O_API_KEY`), for each numeric round (`src/arena/tabh2o-forecaster.ts`).
The training table is built only from what the round froze at its lock, the spread comes from
the returned interval, and the answer is shrunk toward the start forecast with
`MARINA_ARENA_MODEL_WEIGHT`, as `model:` does.

| Spec | Starts from |
|---|---|
| `tabh2o` | the calibrated baseline |
| `tabh2o@nowcast` | the nowcast |
| `tabh2o:forecast[@nowcast]` | as above, using TabH2O's time-series endpoint |

A missing key, an error, too little history or a malformed reply files the start forecast and
records why; ranking rounds keep the start. Calls are paced under the API's rate limit and
metered on the daily spend ledger. `bun run arena evaluate --forecaster tabh2o` backtests it like
the nowcast (operator step; it costs money), and it works as a route target
(`route:<family>=tabh2o;*=nowcast`).

### Profile and ranking rounds

About a third of the rounds are not single numbers. `arena evaluate` scores them exactly as the
leaderboard does — the energy score over the arena's deterministic point set for profiles, 1 − RBO
for rankings (`src/arena/score-shapes.ts`, matching the arena's published scores to 1e-4) —
against the arena's recorded persistence loss for each round.

- **Civiqs profiles**: the nowcast moves every cell to its freshest daily reading.
- **Wikipedia top 10**: views are weighted by recency (half-life 3 days) over three weeks of the
  arena's `wikitop/` archive, using days published before the lock (a two-day lag; daily lists are
  final once published, and the archive was partly backfilled); the half-life was chosen by
  backtest over the archived weeks.
- **Google Trends baskets**: Trends re-normalises its index in every snapshot, so the lock's own
  frozen per-cell history — what the persistence null reads — is used; the `trends/` archive only
  fills in for a lock without one, complete weeks only (`MARINA_ARENA_TRENDS_PARTIAL=on` adds the
  partial week; mixed in the backtest). Archive fallback requires the exact target basket, unique
  terms, an eligible fetch timestamp, finite nonnegative indices, matching vector lengths and
  ordered periods. Extra terms change the denominator and are rejected. An empty or malformed
  snapshot does not hide an older usable one; histories are never spliced across vintages.
- **YouGov crosstab profiles**: no structured source yet; the baseline ties persistence.

`bun run arena audit <round_id|due> [--out report.json]` checks the histories before a run:
round/series identity, cutoff timestamps, finite ordered observations, missing cells and, for
Trends, matching cell dates and shares summing to 100. It reports short histories and observations
older than two typical release intervals. For YouGov, distinguish adults from registered voters,
and total approval from strong approval; the round's exact series and question define the target.
Other pollsters' levels cannot fill missing target data. The audit does not fetch restricted
publisher pages or invent missing releases.
YouGov research uses the exact target question as its first keyword query and asks for each
figure's population, response category and subgroup definition; its search budget is unchanged.

### The research agent (`research:`)

`research:<analyst>[,<analyst>,<analyst>]` — one analyst per vendor — runs the full pipeline
(`src/arena/research/`):

1. **Brief** — a playbook per family (other pollsters' readings *with their previous reading*,
   S&P moves for AAII, prices and inflation prints for consumer surveys, scheduled events for
   attention), bounded to facts after the series' latest known reading, which is stated as already
   known. `buildResearchBrief(round, lock, { nowcast })` starts that window at the daily nowcast's
   date when one is newer than the history (Civiqs); without it, the last weekly value's date. Each
   brief also carries short keyword `queries` (one per playbook item) for search APIs.
2. **Retrieve** — `MARINA_ARENA_RESEARCH_RETRIEVER` (default `openrouter-web:openai/gpt-6-luna`,
   OpenRouter's web search with URL citations; ~$0.03 per round). `sonar:<model>` uses Perplexity
   Sonar through OpenRouter (native search; `sonar`, `sonar-pro`, `sonar-pro-search`,
   `sonar-reasoning-pro`, `sonar-deep-research`), and a comma-separated list runs several engines
   on the same brief and merges their reports (each under its own heading, sources de-duplicated),
   e.g. `openrouter-web:openai/gpt-6-luna,sonar:sonar-pro`. `tavily:basic` / `tavily:advanced`
   calls Tavily's search API directly (`TAVILY_API_KEY`): one news search per brief query, dated
   from the brief's window, up to 8 results each; no model writes the report — each result (best
   12 by score, anything published before the window dropped) becomes one line
   `- <date> — <snippet> [<title>](<url>)`. Tavily also returns each page's text, which the citation
   check reads instead of fetching the page. Cost is estimated at Tavily's pay-as-you-go $0.008 per
   credit (basic 1, advanced 2 per query; ~$0.05 per brief at `advanced`). New retrievers are
   shadow-only until they have resolved rounds to their name.
3. **Verify citations** — every dossier line that cites a page has its figures looked up in that
   page and is tagged `[verified]`, `[unverified]` or `[unreachable]`. The page text is the one the
   retriever already fetched when it carries one (Tavily), else a fetch through the SSRF guard (up
   to 12 pages, 15 s each, a descriptive User-Agent, the first 16 MB read — larger pages are
   truncated, not rejected). Publishers whose terms bar bots (`NO_FETCH_DOMAINS`: YouGov, AAII,
   Conference Board, CivicScience) are never read by either route, so their lines stay
   `[unreachable]`.
4. **Analysts** — forecast from the dated history, the start forecast (named: the nowcast with its
   date, or persistence), for Civiqs the recent **daily** tracker, the resolution and scoring
   rules, and the tagged dossier; told to use other sources for **changes**, never levels
   (pollsters differ in population and house effect), and only changes the start reading does not
   already include.
5. **Judge** — `MARINA_ARENA_RESEARCH_JUDGE` (default `jev`: jev-1.13 via OpenRouter's Decisions
   API) scores each rationale's quality and grounding in the evidence the analysts were given:
   the series' own recent history, the start forecast and the daily tracker (labeled as
   structured source data, not web research) plus the *verified* dossier lines; ungrounded, or a
   judge outage ⇒ no weight. The record keeps `judge {provider, model, calls, latencyMs, costUsd,
   errors}` (and each proposal's judge latency and cost), and the judge's cost is in the shadow
   row's `cost_usd` (the daily spend cap already sees it through the metered provider).
6. **Aggregate** — judge-weighted mean move × confidence × `MARINA_ARENA_RESEARCH_TRUST` (0.5).

**Profile rounds.** On a `profile_energy` round with a start profile, the same pipeline runs over
the whole profile: the brief asks the family's playbook **item by item** for the round's cells
(for an attention basket, events scheduled during the measured week for each item, with one search
query per item), bounded to facts after the newest known cell value; each analyst answers every
cell in one reply; the judge weights each analyst once; and step 6 runs **per cell** over the
analysts that answered it validly (a missing, malformed or wild cell is left out; a cell no analyst
answered keeps its start). A share basket's means are then rescaled to 100 as for formations. The
record keeps `profileProposals` and `protocol.cells`. `arena shadow score` scores recorded profile
forecasts on the arena's energy score against its recorded persistence energy, next to the
baseline. The no-anchor mode below stays numeric-only.

**Rounds with no history (no-anchor mode).** A one-off numeric round (an election result, say)
can lock with an empty `answer_history`. Every other forecaster (`baseline`, `nowcast`,
`discovered`, `model:`, `crew:`, `formation:`) anchors on the last published value and refuses it
with "no history to forecast from"; `research:` answers it without an anchor
(`noAnchorForecastRound` in `src/arena/research/forecaster.ts`):

- the brief asks for the **level** (published forecasts of the quantity, prediction-market prices,
  the data they rest on, the base rate) over the 30 days before now (or the lock);
- the analysts are told there is no history and no start forecast, and may abstain; the judge is a
  filter — only a grounded proposal (weight > 0) counts, a judge outage counts as none;
- sanity bounds come from the question: a named total (`all N decided`) bounds the mean to
  [0, total], a percentage unit to [0, 100]; a proposal outside them is dropped, then any mean more
  than 3 robust spreads (max of the median sd and 1.4826 × MAD) from the median;
- the answer is the **median** of the remaining means, with
  sd = max(median analyst sd, the means' sample sd, 7 % of the median) — the floor is derived from
  the level, never set per round;
- with nothing usable the round is **not answered**: a `NoAnchorRefusal` whose `detail` keeps the
  dossier, proposals, roles and judge (and its cost reaches the shadow ledger); `arena research
  <round>` prints that trail. The answer carries `anchor: "none"` and `noAnchor` (bounds, used,
  dropped, median, medianSd, dispersion, floor).

Web research cannot be backtested (a search run later finds the answer), so it is measured in
**shadow**: `bun run arena shadow run due` records what it would file (with the whole dossier and
judged proposals); re-running it re-records, and the forecast scored is the **last one recorded
before lock**, as a filing would be — every recording stays in the append-only ledger, and a record
younger than 6 h is not duplicated), `shadow score` scores resolved ones against
persistence and the baseline, `shadow list` shows the record, `bun run arena research <round>`
runs it once and prints everything. `MARINA_ARENA_SHADOW=<spec>` records hourly from the tick
job — no entrant or key needed.

Shadow variants include a fingerprint of the forecaster's strategy settings. Different horizon
modes, damping, selected series, routes and lookup settings no longer share a deduplication key.

**Structured evidence.** `FRED_API_KEY` makes vintage-aware series available, but arena research
also needs `MARINA_ARENA_RESEARCH_LOOKUPS=fred` and a research-consuming route. A formation
with `+research@closed-book` uses the existing empty web retriever plus these structured lookups;
it adds no web-search model. The explicit related-series map selects evidence for Civiqs economic
questions and SCE inflation expectations. The arena's own history remains the level anchor.
FRED evidence includes current/previous observations, their same-vintage change, units and
vintage date. A comparison with the vintage available at the start reading distinguishes new
information from a monthly change that was already known. Verification uses the frozen structured
payload rather than a mutable HTML page;
the dossier retains the typed observations and failure/skip reasons. Historical intraday cutoffs
use the prior UTC day's FRED vintage because its API does not provide exact release instants.
Live reads use currently available data. Sports odds are excluded from arena research.

## Signal discovery

`bun run arena discover [--tracker T] [--proposer provider/model] [--n N]` runs the loop that found
the Civiqs nowcast, automatically (`src/arena/discovery/`):

1. A family's clean resolved rounds are split **by time**: the older 60 % are *discovery*, the rest
   *holdout*.
2. A proposer model sees the family, a sample of its history, the **signal language** (a menu of
   centres — `last`, `nowcast`, `ewma:α`, `mean:k`, `median:k`, `trend:k`, `nowcast-shrink:w` (last
   weekly value + w × (nowcast − it)), `nowcast-mean:k` (mean of the last k daily readings in the
   nowcast's snapshot, i.e. Civiqs's revised values as published before the lock),
   `nowcast-drift:φ` (the nowcast plus a damped trend to the release day, where it persists) — and
   spreads — `arena`, `baseline`, `rms:w`, `mad:w`, `scale:k`, `horizon` (sd(h) plus revision
   noise)), and the incumbent's and every earlier
   attempt's **discovery** score. It never sees a holdout score. Signals are data, never code.
3. Each new proposal is scored on both halves. It is **promoted** only if it beats the incumbent
   (the nowcast over the calibrated baseline) on the holdout by a margin that grows with the number
   of signals tried for the family (0.02 + 0.01·log₂(1 + tried)) and does not lose on discovery.
4. Every scored attempt is kept as a note (`arena-discovery`, type `signal`); `arena signals` (or
   `bun run arena signals`) lists them, and the next discovery round is told not to repeat them.

The same loop runs in the world: `arena discover [tracker:T]` (see [Operate](#operate)).
`bun run arena discover --tracker T --signal <centre>/<spread> [--signal …]` scores signals an
operator proposes, with no model call, under the same split, margin and record — each one still
counts as a try.

`MARINA_ARENA_FORECASTER=discovered` uses each family's best promoted signal and the nowcast
elsewhere. Promotion is necessary, not sufficient — record a promoted signal in shadow before it
files. To trial a signal without touching the live record, promote it in a separate discovery
record (`DB_PATH=<scratch> bun run arena discover --tracker civiqs --signal <centre>/<spread>`),
then shadow `discovered` from that record against the nowcast for several weeks before filing it.

## Parallel and layered shadow portfolios

`arena:portfolio` compares formations without signing or submitting a forecast. It uses the
existing Score executor for parallel dependencies and recursive `conduct` steps, and records
the entire attempt in one `arena_shadow` row. Choose an explicit experiment database:

```sh
bun run arena:portfolio <round_id> --db /tmp/arena-shadow.db \
  --models <provider/model>,<provider/model> --plan layered \
  --max-calls 32 --concurrency 4 --timeout-ms 300000 --max-tokens 2000 \
  --out /tmp/portfolio.json
bun run arena:portfolio score --db /tmp/arena-shadow.db --out /tmp/portfolio-scores.json
```

Plans are `control` (Delphi), `parallel` (independent Delphi and symbiosis, then a mixture), and
`layered` (the mixture followed by verification). All branches share one frozen start, lock and
verified dossier. Structured lookups follow `MARINA_ARENA_RESEARCH_LOOKUPS`; this runner uses
archived Civiqs data, with no direct live Civiqs fetch. The control reproduces the Delphi method
on those captured inputs; it is not a replay of a previously filed forecast or its random model
draws. Ranking rounds are rejected because these formations support numeric and profile answers.

The mixture includes both candidate uncertainty and disagreement; it does not divide uncertainty
by the number of models. Every refinement remains anchored to the original start, so stacking
formations cannot compound the allowed mean movement. `--plan-file` accepts an `ArenaPlan` JSON
object (the `plan` field in a report): a versioned Score and typed operations keyed by step ID.
Operations are `formation`, `aggregate`, or `conduct` with a child plan. The runner validates the
whole graph before model calls, with at most 32 steps, eight members per formation and depth three.
Keep the top-level `control` step to get paired scoring.

Call admission and concurrency are shared across all branches and child plans. Failed requests
consume attempts. The timeout includes selection and graph execution; input retrieval has its
own existing fetch deadlines. Output tokens are bounded per model call. These are invocation
limits, not guaranteed dollar ceilings: cancelled requests may still be billed, and configured
decision providers may make internal requests. The normal daily spend guard still applies.
The trace reports in-flight calls if a transport has not settled when cancellation returns;
`costFinal: false` means reported spend can still increase upstream.

`--plan auto --selector jev` asks the existing decision provider to choose among the three plans;
`--selector decisions` uses the configured decision backend. With no selector, malformed answers
or an unavailable upstream, routing preserves the control (an explicitly requested but unconfigured
provider is an error). Model confidence is not a benchmark success probability. Auto selection
loads resolved, prospective comparisons from this shadow ledger. `--evidence` additionally accepts
an exported score report or an array of versioned `RouteEvidence` records from other adapters.

The shared routing contract in `src/coordination/task-routing.ts` retains benchmark, cohort,
policy fingerprint, native metric, direction, failure count and outcome availability time.
It excludes future outcomes, the current question, retrospective runs and changed same-benchmark
policies. Other benchmarks may share an explicitly declared strategy lineage and skill tags;
their results remain separate transfer hypotheses. SWE-bench pass rates and arena skill are
never averaged together. Other benchmark adapters must supply genuinely paired observations;
running another benchmark alone does not establish that a particular orchestration improved it.

Scoring selects the latest attempt per round/configuration, including failures, rather than
falling back to a previous successful attempt. Late, invalid and incomplete comparisons remain
visible. Completed pairs use the existing CRPS/energy scoring implementation. A failed candidate
with a valid pre-lock control can export failure evidence after resolution, without an invented
candidate score. Unresolved forecasts cannot establish an improvement. The ledger scan is bounded
to the latest 2,000 rows; archive/export older evidence for longer experiments. No plan or score
automatically changes `MARINA_ARENA_ROUTES`, timers or submissions.

## Integrity: what the backtest numbers can and cannot claim

Audited 2026-09-25 (`src/arena/evaluate.ts`, `test/arena-*.test.ts`):

- **No outcome reaches a forecaster.** Only the evaluator and the live lesson writer read
  resolutions; every forecaster sees only a round's lock file and archives filtered to what existed
  before the lock (Civiqs snapshots *fetched* before it; Wikipedia lists *published* before it).
- **Rounds whose answer was already public are excluded** for every forecaster
  (`outcomePublicBeforeLock`).
- **Model memorisation.** Probed closed-book, DeepSeek V4 Pro, Claude Sonnet 5 and GPT-6 Luna
  claimed to know none of five resolved values. The baseline and the nowcast use no model at all.
- **In-sample design choices.** The spread-selection metric, the Wikipedia half-life and the
  Trends partial-week default were chosen after looking at the resolved rounds; the Civiqs nowcast
  has no fitted parameter. Treat backtest numbers as optimistic. The honest test is forward:
  `arena shadow run due --forecaster <spec>` records predictions before the lock (for the nowcast,
  within a day of it), and `arena shadow score` scores them only once the arena resolves them.
- **Source terms.** Civiqs, Wikipedia and Google Trends are rights-approved in the arena's own
  review; Marina reads the arena's public archive of them. The research agent's citation check
  never fetches publishers whose terms bar bots or forwarding (YouGov, AAII, Conference Board,
  CivicScience — `NO_FETCH_DOMAINS`).
- **The ranking is hypothetical.** Leaderboard entrants forecast live; Marina's numbers are
  simulations on the same frozen inputs plus public archives available at each lock. Only filed
  forecasts count.

## Enter Marina (one time)

1. **Choose the entrant id** — lower-case, permanent (for example `h2oai-marina`) — and the
   GitHub account that will own it. Only that account can change the registration later.
2. **Generate the signing key** on the server that will file:

   ```bash
   bun run arena keygen /srv/marina/arena-key.pem   # writes mode 0600, never overwrites
   ```

3. **Configure** (`.env`):

   ```bash
   MARINA_ARENA_ENTRANT=h2oai-marina
   MARINA_ARENA_KEY_FILE=/srv/marina/arena-key.pem
   ```

4. **Write the registration** and open the pull request from the owning account:

   ```bash
   bun run arena registration --name "Marina" --org "H2O.ai" --github <login> \
     --out entrants/h2oai-marina.json
   ```

   Add the file to a fork of
   [Social-Atoms/social-sim-arena](https://github.com/Social-Atoms/social-sim-arena) and open the
   PR. The arena's CI validates it; a maintainer approves a signing key.
5. **Rehearse** — `bun run arena submit due --dry-run` shows every forecast inside the window
   without signing or sending anything.
6. **Turn on the autopilot** once the registration is merged:

   ```bash
   MARINA_ARENA_AUTOPILOT=on
   ```

   Every hour Marina files each round whose lock is within 24 hours (the arena's own call window,
   so its inputs are as fresh as every other entrant's) and that has no accepted forecast yet.

## Which world for arena work?

Any. `arena`, `forecast`, `decision`, `market`, `position`, `probe`, `watch` and `web` are global
commands registered in every world, including the default Workbench, and filing goes through the
operator CLI (`bun run arena`), not a room. What matters is the database: the submission ledger,
shadow rows and discovery notes live in `DB_PATH`, which the server's autopilot and the CLI share.
Keep one `DB_PATH` for all arena work — starting a different world on a fresh database splits the
ledger. The `markets` and `prediction-lab` worlds add binary yes/no market rooms, which do not
match the arena's continuous, profile and ranking targets.

## Operate

| Command | Where | What it does |
|---|---|---|
| `arena` / `arena status` | in-world, rank 0 | entrant, key readiness, autopilot, filed counts |
| `arena rounds [n]` | in-world | open rounds, soonest lock first, with Marina's filing status |
| `arena show <round_id>` | in-world | the question and exactly what Marina would file |
| `arena submissions` | in-world | the signed record of what was filed |
| `arena backtest [n]` | in-world | baseline skill vs the arena's persistence, per family |
| `arena evaluate [baseline\|nowcast\|discovered] [tracker:T] [limit:N]` | in-world | score a free forecaster against the baseline on resolved rounds, as the leaderboard scores them |
| `arena shadow [list]` · `arena shadow score` | in-world | the shadow ledger, and its score on outcomes no one had seen |
| `arena shadow run <round_id\|due> [forecaster:F]` | in-world | record a free forecaster's forecast for rounds about to lock (never filed) |
| `arena discover [tracker:T] [n:N]` · `arena signals [tracker:T]` | in-world | run signal discovery (one proposer call per family, rate limited), list every attempt |
| `bun run arena submit <round_id\|due> [--dry-run] [--replace] [--forecaster …] [--weight w]` | operator CLI | sign and file now, optionally replacing an earlier accepted version |
| `bun run arena shadow horizons <round_id\|due>` | operator CLI | compare five statistical horizon policies on shared inputs; never file |
| `bun run arena shadow horizons <round_id\|due> --weekly-anchor` | operator CLI | add two experimental projections from newer weekly anchors |
| `bun run arena shadow compare <round_id\|due>` · `shadow paired-score` | operator CLI | record and score matched statistical/Delphi/FRED/calibration candidates |
| `bun run arena audit <round_id\|due>` | operator CLI | validate input identity, timing, history and basket comparability |
| `bun run arena evaluate [--forecaster …] [--weight w] [--out FILE]` | operator CLI | score forecasters on resolved rounds; files nothing |
| `bun run arena keygen <path>` / `registration` | operator CLI | key and registration file |

Filing is deliberately an operator act (CLI or env-set autopilot), never an in-world one: it
speaks for the organization in public. Everything else in the loop runs in the world, so an agent
can measure, discover and prove a signal forward on its own:

```
arena discover tracker:civiqs            # propose → backtest (time split) → promote
arena evaluate discovered                # the promoted signals vs the baseline, resolved rounds
arena shadow run due forecaster:discovered   # record forecasts for rounds about to lock
arena shadow score                       # once they resolve: the only test on unseen outcomes
```

In-world runs are limited to forecasters that make no model calls (`baseline`, `nowcast`,
`discovered`); `tabh2o`, `model:`, `crew:`, `formation:` and `research:` spend real money and stay operator steps
(`bun run arena evaluate|shadow --forecaster …`). `arena discover` is rate limited per entity (2,
then 1 an hour) and runs one at a time, because every attempt raises that family's promotion bar.
Its proposer is `MARINA_ARENA_PROPOSER` (default Claude Sonnet 5 via OpenRouter). Discovery
attempts and shadow rows land in the world database — the same notes and ledger the operator CLI
and autopilot read.

`readiness` reports an `arena` check once `MARINA_ARENA_ENTRANT` is set, and warns when the key
is missing or readable by other users.

## Guarantees

- **One forecast per round.** A round with an accepted forecast is never filed again; the
  ledger (`arena_submissions`, append-only) records every signed request.
- **Safe retries.** A send that failed in transit is re-sent with the *same* signed request
  within four minutes (the arena deduplicates by request id); after that a fresh request is
  signed. A 4xx is final and never retried as-is.
- **Refuses rather than guesses.** A round without the inputs to forecast from, or an answer
  that would break the arena's contract (missing profile cell, sd ≤ 0, wrong ranking length), is
  skipped with a reason.
- **Key custody.** The key file must be mode 0600 or it is refused; only its public half is
  ever printed or published. Rotate by adding a new key id to the registration.
- **No redirects.** The signed POST goes to the configured origin only; outbound reads use the
  SSRF guard.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MARINA_ARENA_ENTRANT` | unset (off) | the registered entrant id |
| `MARINA_ARENA_KEY_FILE` | — | PKCS#8 PEM (or raw 32-byte seed), mode 0600 |
| `MARINA_ARENA_KEY_ID` | `k1` | the key's id in the registration |
| `MARINA_ARENA_AUTOPILOT` | off | `on` files due rounds hourly |
| `MARINA_ARENA_WINDOW_HOURS` | `24` | how close to its lock a round is filed (max 168; invalid ⇒ 24) |
| `MARINA_ARENA_URL` / `MARINA_ARENA_AUDIENCE` | production | a rehearsal fork's intake |
| `MARINA_ARENA_DATA_URL` | the arena repo on GitHub | where rounds, locks and resolutions are read |
| `MARINA_ARENA_FORECASTER` | `nowcast` | no model calls; every non-Civiqs round is the baseline. Or `baseline`, `discovered`, `tabh2o[:forecast][@nowcast]` (experimental, `TABH2O_API_KEY`), `model:<m>`, `crew:<m>[,<m>,<m>]`, `formation:<pattern>:<m>[,…][+then:<pattern>:<m>[,…]][+research@<retriever>[,…]]`, `research:<m>[,<m>,<m>]` |
| `MARINA_ARENA_MODEL_WEIGHT` | `0.5` | share of the model's move from the baseline that is kept |
| `MARINA_ARENA_SHADOW` | unset | a forecaster spec to record hourly in shadow (never filed) |
| `MARINA_ARENA_TRENDS_PARTIAL` | off | `on` counts a Trends basket's partial current week |
| `MARINA_ARENA_CIVIQS_LIVE` | on | `off` stops the nowcast reading the live Civiqs dashboard for open rounds |
| `MARINA_ARENA_RESEARCH_RETRIEVER` | `openrouter-web:openai/gpt-6-luna` | the research agent's search backend(s): `openrouter-web:<model>`, `sonar:<model>`, `tavily:basic` / `tavily:advanced` (needs `TAVILY_API_KEY`), comma-separated to merge |
| `MARINA_ARENA_RESEARCH_JUDGE` | `jev` (with an OpenRouter key) | `jev`, `decisions` (the configured `MARINA_DECISIONS` backend; falls back to `jev`) or `none` |
| `MARINA_ARENA_RESEARCH_TRUST` | `0.5` | most of the judged move the research agent takes |
