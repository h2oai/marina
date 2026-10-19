# Social Simulation Arena

## Research integration and prospective comparisons

Formations accept the shared research providers, including
`formation:delphi:<provider/model>,<provider/model>+research@search:tavily+duckduckgo`
and `+research@asof:gdelt+wayback`. The `+` inside a backend list is distinct from
`+then:` and `+research@`. Provider keys being present does not change a `closed-book` route.
See [captured evidence and follow-ups](search.md#captured-evidence-and-bounded-follow-ups).

`MARINA_ARENA_RESEARCH_SIGNALS=consumer` adds FRED gasoline prices (GASREGW) and initial
claims (ICSA) to Civiqs economic/household/inflation research. `MARINA_ARENA_RESEARCH_LOOKUPS`
must include `fred`.

`MARINA_ARENA_RESEARCH_SIGNALS=all` adds every mapped outside signal for the round's family
(`ARENA_SIGNAL_MAP` in `src/arena/research/signal-map.ts`, which documents each choice):

| Family (round ids) | FRED series (vintage as of the lock) | Markets phrase | Polls (VoteHub) |
| --- | --- | --- | --- |
| Civiqs econ-now / econ-direction | UMCSENT, GASREGW, ICSA, UNRATE, CPIAUCSL, NASDAQCOM, T5YIE | US recession 2026 | — |
| Civiqs family-finances | UMCSENT, GASREGW, ICSA, UNRATE, CPIAUCSL, NASDAQCOM | — | — |
| Civiqs inflation-concern | CPIAUCSL, GASREGW, MICH, T5YIE, EXPINF1YR | How high will inflation get in 2026 | — |
| Civiqs angry-share | UMCSENT, GASREGW | Trump approval rating | approval, Civiqs excluded |
| Civiqs approval, profile and demographic cells | — | Trump approval rating | approval, Civiqs excluded |
| Economist/YouGov approval, RV, strong; YouGov crosstabs | — | Trump approval rating | approval, YouGov excluded |
| Economist/YouGov generic ballot | — | House control 2026 | generic ballot, YouGov excluded |
| Harvard-Harris | — | Trump approval rating | approval, Harris excluded |
| Morning Consult | — | Trump approval rating | approval, Morning Consult excluded |
| Midterm specials | — | House control 2026 | generic ballot |
| UMich sentiment and party | MICH, GASREGW, NASDAQCOM, ICSA, UNRATE, CPIAUCSL, T5YIE (never UMCSENT: the target itself, a month late) | — | — |
| NY Fed SCE 1-year / 3-year | MICH or EXPINF3YR first, then EXPINF1YR, T5YIE, CPIAUCSL, GASREGW | How high will inflation get in 2026 | — |
| AAII | NASDAQCOM, NASDAQ100, VIXCLS | S&P 500 close end of 2026 | — |
| Google Trends, Wikipedia | none: no keyless, dated event calendar | — | — |

With `all` and `MARINA_ARENA_RESEARCH_LOOKUPS` unset, the lookups are
`polymarket,kalshi,fred,votehub`; set the variable to choose differently. FRED needs
`FRED_API_KEY` for any past lock (keyless FRED is live-only); Polymarket, Kalshi and VoteHub are
keyless. BLS is left out: it duplicates the FRED series and serves only the latest revision. FRED's
SP500 (like DJIA) has no vintages, so a past lock cannot read it; the Nasdaq series stand in.
The market phrases name 2026 contracts and need revisiting when the season rolls over.
Every signal is cut at the lock: FRED reads the vintage of the lock's prior UTC day, markets the
last price at or before the lock, and a VoteHub poll counts only when its whole listing day
(`created_at`, taken to end 08:00 UTC the next day) precedes the lock, with the target's own
pollster excluded; recency and the 14-day-versus-prior-14-day change use the fieldwork end, so a
poll VoteHub lists months late is not read as news. Market and poll lines are frozen under their own payload URL, so the citation
check verifies the price or poll that was read rather than a live page that has moved. The
fingerprint records the effective lookups, so `all` is a separate shadow variant.

Signal discovery (`src/arena/discovery/`) is not wired into formation evidence: its promoted
signals are centre/spread forecasts from the round's own history, not dated outside facts, and
none is promoted live. Adding one would be a formation start option tried in shadow first. The target's own history still sets its level; these different quantities
are evidence of possible changes only. The consumer playbook also asks for dated NY Fed SCE
household-finance, employment, income and credit evidence. It does not treat a newly downloaded
workbook as an old information vintage.

Formation lessons use the canonical judged forecast/arena pool. Set
`MARINA_ARENA_FORMATION_LESSONS=observe` (default), `on`, or `off`; the global `MARINA_LESSONS`
still limits injection. Recall uses the earlier of now and the lock, and its injected/observed
records are saved with the forecast. No new lesson store or automatic strategy promotion exists.

The explicit `arena:research` CLI captures and checks inputs, then runs frozen comparisons:

```bash
bun run arena:research capture <round_id> --out /private/experiment/round \
  --models <provider/model>,<provider/model> --retriever search --research-rounds 2 --max-usd 20
bun run arena:research run --out /private/experiment/round --max-usd 20
bun run arena:research score --out /private/experiment
```

| Arm | Statistical start and calibration | Research |
| --- | --- | --- |
| A | Current configured horizon policy | Existing related-series dossier |
| B | Scoped weekly-anchor drift; qualified final-error calibration when available | Same as A |
| C | Same as A | Expanded structured sources and verified web research |
| D | Same as B | Same frozen dossier as C |
| O (optional) | Same as D | Same dossier; parallel formations and verification |
| L (optional) | Same as D | Same dossier; judged lessons known at capture |

Register optional arms at capture with `--arms A,B,C,D,O,L`; use `--lesson-db` for a lesson
snapshot and `--history` for a validated calibration-history file. Missing calibration evidence
leaves the spread unchanged. Models, token/call ceilings and source policy are hashed into the
configuration. The runner records the age of the Civiqs scalar observations it uses, preserves the first attempt
per arm, checkpoints before paid forecasting, and refuses a late run. Capture and arm costs are
separate; the persistent spend scope includes both. Calls already in flight can outlive a cap.
`--max-tokens` (default 2000) bounds forecast and page-reader responses; gap review is capped at
1000 tokens or the selected lower limit. Compile the runner with `bun build scripts/arena-research.ts
--target=bun --outfile=/private/arena-research.js` and use that same file for capture and run to
freeze its implementation as well as its inputs.

Scoring is read-only, retains missing/failed/late attempts and exports raw final forecasts for
future uncertainty calibration. Partial ensembles with failed or malformed responses are also
ineligible, even if the remaining panelists produced a forecast. Qualification requires at least
12 distinct resolved rounds,
eight discovery and four later holdout rounds in whole lock waves, nonnegative discovery gain,
and at least two skill points average holdout gain without a losing holdout question. Economics
is also reported separately. Eligibility is for review only; this tool never signs, submits,
changes routing, installs timers or promotes a strategy. Keep experiment artifacts outside the
tracked repository and do not mix them with historical or stale captures.

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
| Number (`continuous_normal`) | persistence mean ± calibrated or 1.5 spread; a weekly poll topline (Economist/YouGov, Morning Consult, AAII) takes the poll level instead (below) |
| Profile (`profile_energy`) | the same, per cell; a subgroup crosstab (`yougov_xtab`) may instead take the mean of the last k releases (below) |
| Ranking (`ranking_list`) | last-7-day Wikipedia pageview totals, Main_Page and non-articles excluded |

A crosstab cell is a few hundred respondents of one weekly poll, so last week's value carries last
week's sampling error. For those profiles (`src/arena/sampling-noise.ts`) the baseline also tries
the mean of the last k releases (k ∈ 1, 2, 4, 6, 8), each with a spread equal to that mean's own
recent misses at the round's horizon. It picks one k for the whole profile from the cells' rolling
record, scored per target date over all cells, and uses it (rule `level`) only when it beats the
per-cell baseline by the calibration margin. The choice and its evidence are kept in the forecast
detail (`level`).

A weekly poll topline is the same kind of noisy sample: Economist/YouGov RV approval went 38, 37,
40, 35, 36, 38. For the scalar rounds of `economist_yougov`, `morning_consult` and `aaii`
(`src/arena/poll-level.ts`, rule `poll-level`) the start forecast is the average of persistence and
the arena's own EWMA null (α 0.4), with an sd of half that rule's own recent one-step RMS error
(last 26 releases, at least 6; floor 0.5). Half, not the full RMS, because the leaderboard averages
per-round skill against persistence at sd 1.5 and quiet weeks dominate that average. A series with
too little history keeps the baseline. The rule, both means, the RMS and the number of errors
behind it are kept in the forecast detail (`pollLevel`) and the filing note; formations and
research start from it. `MARINA_ARENA_POLL_LEVEL=off` restores the persistence start.

Walk-forward backtest (mean per-round skill vs persistence; resolved rounds from their lock
snapshots, and every origin from release 16 of each series' latest pre-lock history):

| Family | Resolved n | Baseline | Poll level | History n | Baseline | Poll level |
|---|---|---|---|---|---|---|
| economist_yougov | 10 | 0.00 | 0.15 | 132 | 0.00 | 0.11 |
| morning_consult | 6 | −0.01 | 0.30 | 44 | 0.00 | 0.15 |
| aaii | 4 | 0.00 | 0.43 | 6 | 0.00 | 0.04 |
| umich_sentiment | 4 | 0.00 | −0.05 | 44 | −0.03 | −0.22 |
| umich_party | 3 | 0.00 | −0.23 | 132 | 0.00 | −0.41 |

The UMich series trend month to month, so any shrink toward a recent level loses and they keep the
baseline; the mean of the last k releases lost on every scalar family. Civiqs's daily tracker is
already smoothed, NY Fed SCE gained too little to switch, and Harvard-Harris has too short a
history to test.

`arena show <round_id>` prints exactly what would be filed and which spread rule each series used.

### Filing watch

Filing stays the operator's act outside the world, but the server watches it. When an entrant is configured, the `arena-filing-watch` job runs about every 10 minutes and reads the open rounds. For every round locking within 24 hours, it compares them with the filings and refresh attempts recorded in the world DB (`arena_submissions`, `arena_attempts`). It raises one operational alert per round in trouble (category `arena-filing`, deadline = the lock) when:

- a round has **no accepted filing** (critical within 6 h of its lock);
- the standing filing **predates the round's 24-hour refresh window and nothing has tried since** (critical within 6 h of its lock), the trace a runner leaves when it crashes before recording an attempt;
- a refresh **failed** (error, rejected or skipped) after the standing filing;
- a refresh **started and never finished** (over 30 minutes);
- within 45 minutes of the lock, **nothing ran in the last 90 minutes**, meaning the near-lock pass did not run;
- **stale anchor**: for EVERY open round, whatever its lock, the accepted filing is anchored on an older release than the arena's latest published value (critical within 6 h of its lock), or — within 24 hours — the last refresh recorded `stale_anchor` (see below).

Readiness shows the last pass as `arena-filing`. The watch only reads: it never files, so a broken runner (a stale build, a failing timer) shows up within one pass instead of after the lock. An alert resolves itself once its round is fine again.

### Anchor guard

A forecast starts from the latest reading its inputs saw (its anchor). The arena scores every round against persistence, the last value IT treats as published at the lock, so a filing anchored on an older release loses skill by construction. In Season 0, `yougov-2026-w42-rv-approval` and `-strong-approval` were filed 11 days early at 36 and 18, never refreshed, and locked against 38 and 21.

Before signing, every filing (autopilot, `submit`, `--replace`, dry runs) compares its anchor with the arena's latest value for the round: the round's persistence baseline in the arena's site data (`site/data.json`, per cell for profile rounds), dated by the series tail when that tail ends on the same value. Ranking rounds are not checked. The comparison tolerates the arena's rounding (a poll published as 38 matches 37.6; a one-decimal value matches within 0.05). A value that matches is fresh whatever the dates; a different value is stale unless Marina's reading is dated the same day or later (a daily source ahead of the arena's refresh).

When the anchor is stale, Marina drops its cached arena data and runs the forecaster again once. If the inputs are still stale, it shifts each stale mean by (arena value − anchor), keeping the spread, and files that; the attempt is recorded as `stale_anchor` with the reason, and the filing watch alerts. The trace is kept in the filing's `detail.anchorGuard`. An unreadable site file never blocks a filing (`unchecked`). `MARINA_ARENA_ANCHOR_GUARD=observe` records the verdict and files the forecast unchanged; `off` skips the check.

`bun run arena submit due --replace` also refiles every open round whose accepted filing is anchored on an older release than the arena's, whatever its lock and whatever `MARINA_ARENA_WINDOW_HOURS` is, so a daily refresh catches a new release days before the lock instead of relying on one near-lock pass.

### Input freshness before filing

Official CLI and autopilot forecasts check observation dates before model work and again before
signing. Downloading an old observation today does not make it current, so the audit reads the
observation's own date. The latest available observation is always filed: an observation older
than its source's usual cadence (Civiqs two calendar days, Wikipedia four, weekly Trends/YouGov
fourteen, other recurring series two typical releases with a fourteen-day minimum) is recorded
as an input-age warning in the filing's audit and in `arena health`, never a reason to keep an
older submission. Only a missing or invalid date, or an observation dated after the information
cutoff, is refused; a refusal leaves any accepted version in place and reports the series and date.

Archive lookups and research cutoffs use the earlier of forecast time and lock time. Early
forecasts therefore search back from today, and historical replays remain bounded by their lock.
Trends uses a newer complete basket when available, keeping all cells in one comparison snapshot
and showing that same history to the models. Live Civiqs failures remain in the origin trace
when a sufficiently current archive is available. Research traces retain failed engines, and
formation dossiers carry explicit `verified`, `empty`, or `failed` status; an empty dossier is
never described as verified evidence. Evaluation and shadow experiments may inspect older inputs, but their results
do not bypass the official submission checks.

Run `bun run arena audit <round_id|due> --fresh` to inspect the current observation dates,
input-age warnings, and Civiqs source failures without model calls or submitting anything.

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
start sd — and of the narrowest member proposal (a blend with a narrow start never files more
confidence than any member asked for) — and of the linear pool of every member reply the protocol
recorded, √(mean sd² + variance of the means), over every stage so a converged delphi round cannot
hide the disagreement its members started with (debate advocates, who argue an assigned side, and
dropped blowups are excluded). Each round's calls, statuses, trust and cost are kept in the evaluate/shadow record,
with the pattern's own audit under `protocol` (delphi's summary, the tournament bracket,
verification's aspect verdicts and judge record).

**Proposal judge (delphi, symbiosis).** When the formation carries a verified research dossier
(`+research@…`, or a frozen dossier in `shadow compare`), a decision model weighs each member's
final proposal: one yes/no question — is this member's move from the start supported by the
*verified* dossier lines? — given the round question, the start forecast, the member's forecast
and stated reason (symbiosis: its credit and contribution). The yes-probabilities, renormalised,
weight the median move (equal support ⇒ the ordinary median), and the trust becomes
`0.5 × agreement × mean support`, so it can only drop; the 4-sd drop rule and the 2-sd cap stay.
A proposal that did not move counts as supported without a call; no verified lines or no moving
proposal leaves the forecast unchanged. Any judge failure (outage, timeout, spend-cap refusal,
malformed answer) files the unjudged aggregation. The record is `forecast.judge`: `status`
(`applied`, `observed`, `skipped`, `unavailable`), the judge's provider and model, per-member
`support`, `meanSupport`, and the `unjudged` and `judged` mean, sd, trust and move, plus calls
and cost (which also reach the round's `costUsd`). `MARINA_ARENA_PROPOSAL_JUDGE=on|observe|off`
(default `on`; `observe` records the judged forecast without filing it) and
`MARINA_ARENA_PROPOSAL_JUDGE_MODEL` (default `typesafe/jev-1.13`; any Decisions-API model id on
OpenRouter — switching to another decision model is one env change — or `decisions` for the
world's `MARINA_DECISIONS` backend). Profile rounds are not judged yet. To measure it, run
`shadow compare` with `observe` and score `judge.judged` against `judge.unjudged`, or run the
paired comparison under `on` and `off` (the config fingerprint differs) and use `paired-score`.

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

**Measured nowcast error floor.** Civiqs re-estimates its whole daily history on every model run,
so the freshest daily reading also misses the Friday value by the run-to-run revision — an error
the week-to-week history never shows; a weekly origin (no re-run since the anchor) faces it too. For each of the last 8 Fridays in the round's history, the
reading that week's Wednesday-lock nowcast would have used (the newest snapshot fetched by that
lock) is compared with the Friday value; the RMS, shrunk toward the start sd with 2 pseudo-weeks,
is recorded as `origins.<series>.errorFloor` (at least 3 measured weeks, else none). Whatever
forecaster produced the answer (nowcast, formation, crew, research, routed), the filed sd is
raised to that floor when it is narrower, and the note says so; it only ever widens. The spread
calibration below runs after it and may narrow the result when resolved rounds say so.

**Spread calibration per (family, method).** Last, after the floor, every filed sd — a scalar
topline and each profile cell — is multiplied by a scale learned from resolved rounds
(`src/arena/calibration.ts`). The family is the tracker, with `:profile` for profile rounds
(`civiqs` and `civiqs:profile` get their sds from different paths); the key is
`arena:<family>|<method>`, the method at pattern level (e.g. `formation:delphi+research`,
`nowcast`). Evidence is one record per resolved round we filed: the sd as it stood before this
step (our ledger's newest accepted filing, divided back by any multiplier applied then; the
arena's site data for a round the ledger lacks), the published outcome, and persistence's loss
on the round, from the arena's public `site/data.json` (scalars fall back to
`resolutions/resolved.json`). A record is visible only when its outcome was published at or
before min(now, the round's lock) — `resolved_at` (or its correction) for a scalar, the end of
the release day for a profile — and never for the round itself.

Each level's ŝ is the multiplier on a 0.30–3.00 grid with the best **mean per-round skill**
(1 − loss/persistence loss; CRPS for a scalar, the arena's energy score for a profile — exact,
since the point set is linear in the multiplier). Levels pool in log space with
w = n / (n + 4): the (family, method) toward its family, the family toward the cross-family
scale, and that — the geometric mean of the families' ŝ, each family counted once so one busy
family cannot export its miscalibration — toward 1 by F / (F + 4). The result is clamped to
[0.35, 3]. With no resolved rounds it is identity; one resolved round already moves it a little.
Order: forecaster → move weight → error floor → spread calibration, so resolved rounds have the
last word over the floor's estimate (on Civiqs the floor kept filings ~2.7× wider than their
misses). The decision and its evidence (scale, n / ŝ / w per level, cutoff) are kept under
`spreadCalibration` in the filing's detail. Two exclusions: a scalar filing made before the
anchor guard from a release older than the one at its lock (filed ≥ 7 days early, mean ≠ the
arena's persistence) is no evidence, since its miss measures the stale anchor; and a poll-level
start keeps its own backtested sd until 4 poll-level filings have resolved (its records are keyed
`…+poll-level`). `MARINA_ARENA_SPREAD_CALIBRATION=observe` records
without applying; `off` skips it (the retired `MARINA_ARENA_CALIBRATION` is read when it is
unset). Walk-forward over Season 0 to mid-October (31 resolved rounds we filed, each round
calibrated only on outcomes published before its lock) it lifts mean per-round skill from 0.129
to 0.180, nearly all of it on Civiqs toplines (0.289 → 0.359) and Economist/YouGov (−0.902 →
−0.827); the profile families move by under 0.01 on two or three rounds each.

**Learned move weight per (family, method).** A formation files its start plus a constant share
(about one half) of its members' median move. `src/arena/move-weight.ts` learns that share from
outcomes instead: the filed mean becomes `start + w × (median proposal − start)`, w on a grid from
0 to 1.5, fitted by minimum CRPS on our resolved filings and arena shadows of the same key
(`arena:<tracker>|<method>`), shrunk toward the formations' own trust. It is adopted only when it
beats what was filed on the newer 40 % by 5 % AND a placebo fails: the same fit with the members'
moves shuffled across rounds must not reach the same gain (else the gain is shrinkage, not
information in the moves). With fewer than 8 records it does nothing. Order: forecaster → move
weight → error floor → spread calibration; the decision (w, n, held-out gain, placebo) is kept
under `moveWeight`. `MARINA_ARENA_MOVE_WEIGHT=observe` records without applying; `off` skips it.
Formation filings now record their start (`formationStart`) so the move is exact.

**Unanchored formations and typed signals.** `formation:<pattern>~unanchored:<models>` runs the
same members, dossier and protocol without the instruction that the start forecast is the default,
and asks every member to list the evidence it relied on as typed signals (claim, direction, signed
size, unit, observation and source dates), recorded under `signals` with a `stale` flag for
anything observed before the start reading. It has its own method key, so it is a shadow
challenger: list it in `MARINA_ARENA_SHADOW_CHALLENGERS` (it is never run automatically) and let
earned routing and the move weight decide on resolved rounds whether unanchored moves carry
information. The research dossier's typed measurements (target and change claims) are listed as
signals in the dossier block too.

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

For eligible resolved scalar batches, each candidate also reports `attributionFromStart`.
It swaps the forecast mean and spread independently, then averages both swap orders to
attribute the skill difference to each parameter. Contributions are skill fractions
(multiply by 100 for leaderboard points), include negative effects, and sum to the total
improvement. This explains an observed result; it is not evidence that the same parameter
change will help future questions. Unresolved and incomplete batches have no attribution.

Uncertainty calibration is **shadow-only**. It uses recorded errors from complete forecasts of
the exact same estimator/configuration, within the same family and unit, weighted by similarity
of horizon and source age. It needs at least twelve distinct resolved rounds: at least eight in
an earlier training block and four in a later validation block. Waves stay together; training
outcomes must have been published before the validation forecasts. A bounded spread adjustment
must improve validation mean normalized CRPS by five percent; the centre never changes.
Missing or insufficient history leaves the forecast unchanged and records the reason. The trace
includes interval coverage and training/validation round IDs. This is a qualification gate, not
evidence of a live win or a substitute for future matched results.

Scorer exports containing `calibrationObservations` can be accumulated without counting each
scoring run as new evidence:

```bash
bun run scripts/arena-calibration-history.ts \
  --as-of 2026-10-10T12:00:00Z --output history-next.json history-previous.json scores.json
```

Omit `history-previous.json` on the first run. The tool accepts trusted scorer exports, observation
arrays, and its own versioned history reports. It writes a new file, refuses overwrites, rejects
invalid chronology and conflicting forecasts/outcomes, and admits only outcomes available before
the explicit cutoff. Repeated exports are deduplicated; multiple prospective captures retain the
latest forecast per estimator/family/unit/round, matching the calibrator's rule. Keep original
exports to revisit observations excluded by an earlier cutoff. Use the experiment's predeclared
repeat or ensemble; do not pass stochastic repetitions as additional calibration rounds.

The report inventories distinct rounds and lock-time waves separately for every exact estimator,
family, and unit. Its `observations` can be passed to `calibrateUncertainty()` with a real future
forecast and context. Twelve rounds or a positive descriptive score do not qualify a policy:
the existing chronological 8/4 split and held-out improvement check still apply. History import
cannot certify the provenance of an arbitrary input file and never changes submission routing.

**Replacing a filing.** The arena's signed intake keeps every version and scores the newest one
accepted before the lock (up to 120 per round). `bun run arena submit <round|due> --replace` files
a newer version of an accepted round; an unchanged forecast is not re-sent, and the autopilot never
replaces.

**Filing early.** A first filing is refused for a round locking beyond `MARINA_ARENA_WINDOW_HOURS`
unless `--early` is passed. The board averages skill over the rounds an entrant answered, so an
unanswered round costs nothing. A filing that misses its refresh is scored against a persistence
baseline frozen on fresher data, and it can only lose. Replacing an accepted filing is always
allowed.

With `--replace`, `due` also selects every open round whose accepted filing has a stale anchor
(see [Anchor guard](#anchor-guard)), whatever its lock. File inside the window, then schedule an operator refresh closer to the lock. For
example, an hourly `MARINA_ARENA_WINDOW_HOURS=1.1 bun run arena submit due --replace` selects
rounds locking within 66 minutes, while preserving the five-minute safety margin. Allow enough
time for the selected formation and any simultaneous deadlines. Runners sharing a checkout or
submission ledger should use one exclusive lock; a refresh failure leaves the earlier accepted
forecast in place.

**Outcomes.** Every accepted filing the arena has resolved is settled once on Marina's outcome
path (`src/arena/settle.ts`), however it was filed: the autopilot settles before each pass, and the
operator CLI settles at the start of every real `submit` (or on demand with `bun run arena
settle`). The scored version is the newest accepted filing, the one the arena scores. Numbers are
filed as forecast answers and scored by CRPS; profiles and rankings become one mechanical outcome
each, scored with the arena's own energy score / rank-biased overlap against its recorded
persistence loss. Every outcome names its family (`family:<tracker>`) and method
(`method:<kind>`, from the route in the filing's notes), so lessons, forecast history and
per-family evidence all read the entry. The resolution time is the arena's published one when it
gives one, otherwise the time of settling. A settling failure never blocks filing.

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

#### Earned routes

Each route is its family's **default**, not a fixed choice (`src/arena/earned-routes.ts`). Before
a routed round is filed, the evidence on record is read: our scored filing of every resolved round
(matched to the default by method kind, so a model upgrade keeps the record) and the shadow
ledger's last pre-lock record of every runnable forecaster spec. Only outcomes that were public by
then count, and rounds whose outcome was public before their lock never count. A challenger
replaces the default only on the general forecaster's promotion rule (`earnedPick` in
`src/forecast/routing.ts`):

- at least `MARINA_ARENA_ROUTE_MIN_N` (default 8) rounds that both answered;
- a paired mean gain whose 95 % lower bound is above 0;
- a gain past `promotionMargin(tried)`, which grows with every challenger considered.

Short of that, the default answers, so with no evidence routing is the hand map unchanged.
`MARINA_ARENA_ROUTING=observe` records the pick without acting on it, and `off` skips it.
`<family>=!<spec>` pins a family, so evidence never replaces it; `skip` is always pinned. Every
decision (default, chosen, each challenger's paired n, gain, interval and margin) is kept in the
filing's detail as `routing`.

| Command | What it does |
|---|---|
| `bun run arena routes` | prints every family's decision now (read-only, no model calls) |
| `bun run arena shadow challengers <round_id\|due>` | runs the challengers the operator lists per family in `MARINA_ARENA_SHADOW_CHALLENGERS` (`civiqs=nowcast\|<spec>;aaii=<spec>`), so exploring costs only what is listed |

`spike-decay` is a free challenger for Trends baskets (`src/arena/spike-decay.ts`): the nowcast,
except that a cell whose latest share sits more than 3 × its robust weekly change away from the
median of its previous 8 weeks (an event week) moves halfway back toward that median, and the
basket is renormalised. Every other family answers as the nowcast. It is not a default: list it
(`MARINA_ARENA_SHADOW_CHALLENGERS=google_trends=spike-decay`) and it answers the family only once
earned routing promotes it.

The nowcast refuses rounds with no history (see [no-anchor mode](#the-research-agent-research)).
To answer them, route their family to research, e.g. `<family>=research:<m>[,<m>…]@<retriever>`;
routes are per family, so the family's rounds that do have history go through research too
(anchored as usual).

### TabH2O (`tabh2o`, experimental)

`MARINA_ARENA_FORECASTER=tabh2o` asks [TabH2O](https://tabh2o.h2oai.com/docs), H2O.ai's tabular
foundation model (`TABH2O_API_KEY`), for each numeric round (`src/arena/tabh2o-forecaster.ts`).
The training table is built only from what the round froze at its lock. An interval supplies
the spread only when the server explicitly provides its coverage probability; otherwise
Marina uses horizon-matched historical change errors. The answer is shrunk toward the start forecast with
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
  backtest over the archived weeks. A per-article trajectory model (power-law decay from each
  article's own peak, shrunk toward a pooled exponent) was tested walk-forward on the archive
  and did not win on the held-out weeks, so the recency list stays the default.
- **Wikipedia scheduled events** (`research:wiki-events:<model>[@<retrievers>]`): the recency
  list cannot see a release, premiere, execution, final or an event's end that has not happened
  yet. This card searches for events in the target week (results published before the cutoff),
  one model call proposes candidates — each naming its source — and only candidates that pass
  mechanical checks change the list: the cited source was retrieved, predates the cutoff and
  mentions the article; the event date falls in the week (or up to two days before it; for an
  ended event, before it); the English Wikipedia article exists (canonical title, redirects
  followed); and its daily pageviews up to the last published day are read from Wikimedia. A
  verified upcoming event enters only if its article already draws at least 3 % of the entry
  bar's daily views — the 25th percentile of what past new top-10 entrants drew before their
  lock, measured on the archive — and then at the entry bar or its own recent level, whichever is
  higher, taking the lowest statistical slot if it is still below the cut. A model's "ended" is
  not evidence: an article is demoted only when the cited source says, next to its mention, that
  the event ended and its own views are already below half their two-week peak. At most
  `MARINA_ARENA_WIKI_EVENTS_MAX_INSERT` articles (default 3) are added. Every candidate, verified or rejected, is kept with its reason in the forecast detail
  (`wikiEvents`). Web search cannot be replayed, so the card runs as a shadow challenger
  (`MARINA_ARENA_SHADOW_CHALLENGERS="wikipedia=research:wiki-events:<model>@<retrievers>"`,
  `bun run arena shadow challengers due`) and earned routing decides whether it files.
- **Google Trends baskets**: Trends re-normalises its index in every snapshot. Forecasts use a
  newer complete basket from `trends/` when available; the original lock still defines the
  scoring baseline. Complete weeks only are used (`MARINA_ARENA_TRENDS_PARTIAL=on` adds the
  partial week; mixed in the backtest). Archive inputs require the exact target basket, unique
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
2. **Retrieve** — `MARINA_ARENA_RESEARCH_RETRIEVER` (default `openrouter-web:google/gemini-3.1-pro-preview`,
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
the dossier retains the typed observations and failure/skip reasons. For a monthly round the
brief carries its target period (the month after the last published value); a related series
whose latest observation predates it is labelled `STALE` on its line and in the section header,
so a month-old change is not read as news about the period being forecast. Historical intraday cutoffs
use the prior UTC day's FRED vintage because its API does not provide exact release instants.
Live reads use currently available data. Sports odds are excluded from arena research.
Check each source's publication cadence: [FRED's Michigan sentiment series](https://fred.stlouisfed.org/series/UMCSENT)
is delayed by one month. A successful lookup is not necessarily new information for a weekly
forecast; use the observation date and change since the anchor vintage when interpreting it.

Programmatic shadow experiments can pass a `hints(brief)` selector to `withDataLookups` to
compare alternative related series on frozen inputs. This leaves the default related-series map
unchanged and applies the same evidence cutoffs and anchor-vintage comparison to both arms.
Record the selector's series, inputs and policy fingerprint with each forecast; retain failed
attempts and repeated runs rather than selecting the best result. Research briefs use the
nowcast reading selected by the forecaster, including same-day revisions, for scalar and
profile targets.

**Settlement experiments without new model calls.** `replayDelphiSettlement` in
`src/arena/settlement-shadow.ts` accepts the original start distribution, a complete two-round
Delphi trace, and `{ meanWeight, spreadWeight, sdScale? }`. Both weights multiply the existing
proposal-agreement factor; the default rule is `0.5` for each weight and scale `1`. The helper
first reconstructs the recorded forecast exactly, refusing partial, failed or incompatible
traces. It reuses the existing movement cap and spread floor. Vary one weight at a time to
distinguish a better centre from better uncertainty; increasing both weights can widen the
spread even when the mean improves.

These are new shadow candidates: record their policy and creation time **before lock**, retain
the parent trace and input hash, and compare all planned arms on matched resolved rounds.
Reusing model replies makes the incremental model cost zero; it does not make the original
forecast free. Multiple repeats or parameter settings are correlated evidence, not additional
independent questions. Preserve every repeat when reporting scores, and use a declared repeat
or prospective ensemble when collecting calibration errors rather than counting repeats as
separate rounds. No settlement experiment changes the live default.

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
decision providers may make internal requests. The normal daily spend guard still applies:
`arena:portfolio` and the spending `arena` subcommands attach the world database's ledger
(`DB_PATH`), so their spend counts against the same daily total as the server.
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

Enforced in `src/arena/evaluate.ts` and covered by `test/arena-*.test.ts`:

- **No outcome reaches a forecaster.** Only the evaluator and the live lesson writer read
  resolutions; every forecaster sees only a round's lock file and archives filtered to what existed
  before the lock (Civiqs snapshots *fetched* before it; Wikipedia lists *published* before it).
- **Rounds whose answer was already public are excluded** for every forecaster
  (`outcomePublicBeforeLock`).
- **Model memorisation.** A model-backed forecaster may have seen resolved values in training;
  the baseline and the nowcast use no model at all.
- **In-sample design choices.** Settings chosen after looking at resolved rounds (such as the
  spread-selection metric, the Wikipedia half-life and the Trends partial-week default) make
  backtest numbers optimistic; the Civiqs nowcast has no fitted parameter. The honest test is forward:
  `arena shadow run due --forecaster <spec>` records predictions before the lock (for the nowcast,
  within a day of it), and `arena shadow score` scores them only once the arena resolves them.
- **Source terms.** Civiqs, Wikipedia and Google Trends are rights-approved in the arena's own
  review; Marina reads the arena's public archive of them. The research agent's citation check
  never fetches publishers whose terms bar bots or forwarding (YouGov, AAII, Conference Board,
  CivicScience — `NO_FETCH_DOMAINS`).
- **Backtest rankings are hypothetical.** `arena evaluate` simulates forecasts on frozen inputs
  plus public archives available at each lock. These scores do not replace Marina's accepted
  live forecasts. Only forecasts filed before lock count on the official leaderboard.

When checking a leaderboard change, compare the same board, time window, question shapes and
round IDs. An entrant's mean over a specialist subset is not directly comparable to another
entrant's mean over every task; use their shared resolved questions for a matched comparison.
An accepted forecast can remain sealed or await an outcome before it receives a score. Multiple
accepted versions of a question still produce one scored forecast: the newest on-time version.
Reconcile that version's distribution or ranking in `arena_submissions` with the public forecast
and inspect the site's generation time before concluding that a submission was omitted.
Retrospective replays, unresolved rehearsals and unfiled shadows never update the official score.

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
| `bun run arena submit <round_id\|due> [--dry-run] [--replace] [--early] [--forecaster …] [--weight w]` | operator CLI | sign and file now, optionally replacing an earlier accepted version (`--early`: a first filing outside the window) |
| `bun run arena settle` | operator CLI | put every resolved filing on the outcome path once (also the first step of a real `submit`) |
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

### Evidence and delivery health

Use `arena health` in-world or `bun run arena health` in the operator CLI to inspect each
round's accepted version, input dates, strategy fingerprint and latest refresh attempt.
Failures before signing and interrupted attempts are recorded separately from signed
submissions. A rejected replacement does not erase an earlier accepted forecast. CLI output
includes the spend state recorded at each attempt; this does not change your spending limits.

`MARINA_RESEARCH_TARGET_EVIDENCE=observe|on` adds claim identity and target-aware selection
to the shared capture layer. `observe` records the index; `on` also selects whole claims
within the prompt budget. Matching measurements retain population, response, subgroup,
units, observation period, availability, source and supporting passage. Other instruments
supply changes only; unknown metadata stays background. Repeated citations do not become
new observations. Distinct recorded origin URLs are a provenance diagnostic, not proof
that their information is statistically independent.

`MARINA_RESEARCH_ADVICE=observe|on` also applies to the evidence gap loop. Advice uses the
configured decision backend, a Marina classifier when available, and the deterministic
research plan on outage. It cannot override dates, invent measurements, lift spending caps,
or turn incomplete required research into a successful filing. Its receipts travel with the
dossier and can be attributed to the exact resolved submission through the outcome ledger.

`MARINA_ARENA_EVIDENCE_REFRESH=on` rechecks sources before deciding whether an accepted
formation needs another panel. Reuse requires the same round, strategy, inputs and evidence
fingerprint, a complete prior run, and a forecast under 24 hours old. The final two hours
before lock require a fresh forecast if the previous one predates that window. Source
failures retain the accepted answer and appear in the attempt ledger.

### Structured survey imports

For a workbook you are permitted to use, convert it without network access:

```bash
python3 scripts/arena-survey-import.py /path/to/archived.xlsx \
  --source-url https://example.org/permitted-archive.xlsx \
  --available-at 2026-10-01T20:00:00Z \
  --measure 'presidential job approval' > /private/survey-waves.json
```

The importer binds sheet names through workbook relationships, checks the wave axis and
responses, retains base sizes, and hashes the original document. Set
`MARINA_RESEARCH_SURVEY_FILE=/private/survey-waves.json` to add the newest two eligible
waves per source (up to 20 waves total) to matching research requests. Use the actual availability of the archived vintage,
not a survey field date. A day-only availability is conservatively the end of that UTC day.
Existing publisher restrictions still apply. The generic `releasesDue()` calendar helper
can request a refresh after a scheduled release; a schedule is never proof of publication.
`MARINA_RESEARCH_CALENDAR_FILE` accepts a JSON array of events with `source`, `target`
(the round ID), `scheduledAt`, `announcedAt`, `url` and `status`
(`scheduled`, `delayed`, or `published`). Due events add source reads and trigger a panel
refresh. Unavailable imports are reported while ordinary retrieval continues.

### Additional prospective challengers

The following tool records comparisons in the existing shadow ledger, without signing,
submitting, or changing routes:

```bash
bun run scripts/arena-challengers.ts <round_id> --db /private/shadow.db --kind attention
bun run scripts/arena-challengers.ts <round_id> --db /private/shadow.db --kind numeric --tabh2o
bun run scripts/arena-challengers.ts <round_id> --db /path/to/world.db --kind uncertainty
bun run scripts/arena-challengers.ts <round_id> --db /private/shadow.db --kind population --input /private/scenario.json
bun run scripts/arena-challengers.ts score --db /private/shadow.db --out /private/scores.json
```

`attention` compares consistent Trends basket vintages, aligned seasonal weeks and partial
weeks, or Wikipedia pageview trajectories. Optional `events` in the input JSON contain
`item`, `startsAt`, `endsAt`, `knownAt`, `source` and an explicit scenario `multiplier`.
These multipliers are assumptions, not measured effects. Basket means sum to 100; independent
survey cells are never forced into a composition.

`numeric` compares fixed local-level models and optionally the existing metered TabH2O
adapter. Input `covariates` carry `name`, `value`, `observedAt` and `availableAt`; each training
row sees only vintages available at its origin. No external foundation-model weights or
licenses are required. `uncertainty` derives predeclared scales and Civiqs floors from a
complete accepted final forecast, retaining its exact estimator fingerprint.

`population` requires `population.target` (measure, population, response, subgroup and unit
matching the arena target exactly), `population.strata` (a disjoint partition with measured shares,
effective sample sizes, population weights and source dates), `population.scenario`
(dated, explicitly hypothetical percentage-point changes),
and `population.priorShare`, `population.priorStrength` and `population.commonSd`.
Only matching percent-share targets are eligible. Outputs remain labelled simulations. Common error does not disappear by
adding synthetic participants. These are testable scenarios, not new survey observations.

Scoring keeps the latest whole batch, including failed and missing candidates, with native
CRPS, energy or RBO loss and paired skill differences. Family summaries include attempt
counts, failure counts and cost. Its
`calibrationObservations` feed the existing calibration-history importer; `revisions`
separately inventory changes to previously published readings. Floors can qualify only
through the same chronological final-error gate (12 distinct rounds, at least 8 earlier
training and 4 later validation rounds, whole waves kept together). Tail protection can
additionally veto a loss in 95% coverage or worst normalized loss. No tool automatically
promotes these candidates.

To compare shared evidence against independently researched hypotheses at a fixed query
and formation allowance, run `arena:portfolio` with `--plan independent`,
`--research-paths shared|independent`, `--research-queries 6` and `--retriever search`.
The three paths investigate measurement, mechanisms and disconfirming evidence before
either formation sees the others' findings. Both modes use two Delphi formations and the
same aggregation. Use separate shadow ledgers and record every attempt and cost.
For an exact paired comparison, add `--research-save /private/paired.json` to the shared
run, then `--research-replay /private/paired.json` to the independent run before the lock.
Replay validates source hashes and reuses the same numeric anchor and three research paths;
it makes no new research calls. Original research cost is retained separately from the
replay's actual cost. Re-running search separately is a prospective comparison but does
not isolate evidence sharing as cleanly.

| Variable | Default | Meaning |
|---|---|---|
| `MARINA_ARENA_ENTRANT` | unset (off) | the registered entrant id |
| `MARINA_ARENA_KEY_FILE` | — | PKCS#8 PEM (or raw 32-byte seed), mode 0600 |
| `MARINA_ARENA_KEY_ID` | `k1` | the key's id in the registration |
| `MARINA_ARENA_AUTOPILOT` | off | `on` files due rounds hourly |
| `MARINA_ARENA_WINDOW_HOURS` | `24` | how close to its lock a round is filed (above 168 ⇒ 168, with a warning; invalid ⇒ 24) |
| `MARINA_ARENA_URL` / `MARINA_ARENA_AUDIENCE` | production | a rehearsal fork's intake |
| `MARINA_ARENA_DATA_URL` | the arena repo on GitHub | where rounds, locks and resolutions are read |
| `MARINA_ARENA_FORECASTER` | `nowcast` | no model calls; every non-Civiqs round is the baseline. Or `baseline`, `spike-decay` (Trends shadow challenger), `discovered`, `tabh2o[:forecast][@nowcast]` (experimental, `TABH2O_API_KEY`), `model:<m>`, `crew:<m>[,<m>,<m>]`, `formation:<pattern>:<m>[,…][+then:<pattern>:<m>[,…]][+research@<retriever>[,…]]`, `research:<m>[,<m>,<m>]` |
| `MARINA_ARENA_MODEL_WEIGHT` | `0.5` | share of the model's move from the baseline that is kept |
| `MARINA_ARENA_SHADOW` | unset | a forecaster spec to record hourly in shadow (never filed) |
| `MARINA_ARENA_TRENDS_PARTIAL` | off | `on` counts a Trends basket's partial current week |
| `MARINA_ARENA_CIVIQS_LIVE` | on | `off` stops the nowcast reading the live Civiqs dashboard for open rounds |
| `MARINA_ARENA_RESEARCH_RETRIEVER` | `openrouter-web:google/gemini-3.1-pro-preview` | the research agent's search backend(s): `openrouter-web:<model>`, `sonar:<model>`, `tavily:basic` / `tavily:advanced` (needs `TAVILY_API_KEY`), comma-separated to merge |
| `MARINA_ARENA_RESEARCH_JUDGE` | `jev` (with an OpenRouter key) | `jev`, `decisions` (the configured `MARINA_DECISIONS` backend; falls back to `jev`) or `none` |
| `MARINA_ARENA_RESEARCH_TRUST` | `0.5` | most of the judged move the research agent takes |
| `MARINA_ARENA_PROPOSAL_JUDGE` | `on` | delphi / symbiosis with verified research: judged support weights the move and lowers trust; `observe` records only, `off` skips |
| `MARINA_ARENA_PROPOSAL_JUDGE_MODEL` | `typesafe/jev-1.13` | the proposal judge: any Decisions-API model id on OpenRouter, or `decisions` (the `MARINA_DECISIONS` backend) |
