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
with one sized to how the series actually moves — **but only for a series whose own history says
that wins by 5 % or more on the leaderboard's own metric**, the mean of per-round skill. (Choosing
by total CRPS instead is a trap: on spiky series such as pageviews a wide spread wins the spikes
and loses nearly every ordinary week, and the leaderboard counts weeks.) Everywhere else it files
exact persistence, which ties the reference and cannot blow up. On the 58 rounds the arena had
resolved by 2026-09-25 it scores **+0.046**, with no family below −0.01.

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
with the model's cost. First result (2026-09-25, 58 rounds, $0.05): baseline +0.046, DeepSeek V4
Pro blended at 0.25 +0.045, raw −0.07 to −0.12 — no better than the baseline overall, consistently
better on AAII sentiment. Run-to-run model noise is about ±0.05 at this sample size. A model whose
training data covers a round's release could know its answer; weigh rounds after its cutoff.

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

First crew results (2026-09-25, 58 resolved rounds, DeepSeek V4 Pro in every role, ~$0.07 a run):
+0.022 with learning, +0.036 without, vs the baseline's +0.046. The crew beats persistence on far
more rounds (31 vs 12) but a few larger misses cost more than those wins earn — the leaderboard
averages per-round skill, which punishes misses when persistence happens to land close. Too few
lessons per series yet to show learning.

Multi-vendor crew — DeepSeek V4 Pro (statistician), Claude Sonnet 5 (analyst), GPT-6 Luna
(skeptic), ~$0.13 a run — two runs: **+0.059 and +0.053**, beating persistence on 34 and 32 of 58
rounds; the first forecaster above the baseline, though the margin (~0.01) is within run-to-run
noise. Its family pattern repeated in both runs: better on AAII, Trends, Wikipedia and Morning
Consult; worse on Economist/YouGov (−0.08 both), where the baseline should keep filing.

### The Civiqs nowcast (`nowcast`)

Civiqs publishes **daily** trackers but the arena samples them on Fridays, so a round's history
ends at last Friday while, by its Wednesday lock, several newer daily readings are public. The
arena archives every snapshot it fetches (`civiqs/` in its repo); `MARINA_ARENA_FORECASTER=nowcast`
(the default when unset) moves each Civiqs mean — topline or profile cell — to the freshest daily
reading in a snapshot **fetched before the lock**, keeping the baseline's spread; every other round
is the baseline.
Deterministic and leakage-free, so it backtests: on the 53 resolved rounds whose answer was not
already public at lock (2026-09-25) it scores **+0.111** overall and **+0.213 on Civiqs (15 of 20
rounds beat persistence)**, vs the baseline's +0.046 — see *Integrity* below. Structured sources like this beat web search wherever they exist.

**Live reading for open rounds (2026-09-28).** The arena's archive is pushed irregularly (a
"residential courier"), so two days before a lock its newest snapshot can be several days old —
and Civiqs republishes its whole daily history every night, so even an already-archived day's
number moves. For a round whose lock has NOT passed, the nowcast therefore also reads the Civiqs
dashboard itself (`src/arena/research/civiqs-live.ts`, a port of the arena's own reader: the
page's loader payload, fractions → points, subgroup filters verified to have applied; one request
per tracker, paced) and uses whichever reading is fresher, including a revised value for the
history's last day. A round whose lock has passed never reads live data, so every backtest number
above is unchanged. `MARINA_ARENA_CIVIQS_LIVE=off` turns it off.

**File early, then replace late.** The arena's signed intake keeps every version and scores the
newest one accepted before the lock (up to 120 per round), so file as soon as a round is open —
insurance against an outage — and file again near the lock with `bun run arena submit <round|due>
--replace`; an unchanged forecast is not re-sent, and the autopilot never replaces. For Civiqs the
late version is the one that matters: the dashboard runs a day behind and rolls over around 01:40
UTC, so on a Wednesday lock Tuesday's reading is public from about 02:00 UTC. Spread is not a
lever: on the resolved rounds every sharper sd scored worse than the baseline's (Civiqs revisions
move a value 1–2 points by Friday).

**How the board ranks (checked against the live `data.json`, 2026-09-28).** An entrant's row is
its mean skill over the rounds it answered — unanswered rounds are not counted — and skill is
`1 − CRPS / persistence CRPS` against a persistence null frozen when the round's call window opens
(the round's weekly history, so for Civiqs last Friday's value). Every model-based entrant was
negative (best −0.153); the leader (`apodex-futureflow`, +0.517 over 8 rounds) answered the Civiqs
w39 rounds with a daily-reading forecast like the nowcast, which backtests at comparable skill on
those same rounds. Answer the rounds where Marina has measured evidence of an edge.

### Profile and ranking rounds

About a third of the rounds are not single numbers. `arena evaluate` scores them exactly as the
leaderboard does — the energy score over the arena's deterministic point set for profiles, 1 − RBO
for rankings (`src/arena/score-shapes.ts`, matching the arena's published scores to 1e-4) —
against the arena's recorded persistence loss for each round.

- **Civiqs profiles**: the nowcast moves every cell to its freshest daily reading (+0.443 on the
  one scoreable resolved round).
- **Wikipedia top 10**: views are weighted by recency (half-life 3 days) over three weeks of the
  arena's `wikitop/` archive, using days published before the lock (a two-day lag; daily lists are
  final once published, and the archive was partly backfilled). Over 7 archived weeks: +0.069 vs
  the arena's persistence (a flat 7-day sum: +0.045); on the 3 resolved rounds +0.186 / +0.053 /
  −0.032.
- **Google Trends baskets**: Trends re-normalises its index in every snapshot, so the lock's own
  frozen per-cell history — what the persistence null reads — is used; the `trends/` archive only
  fills in for a lock without one, complete weeks only (`MARINA_ARENA_TRENDS_PARTIAL=on` adds the
  partial week; mixed in the backtest).
- **YouGov crosstab profiles**: no structured source yet; the baseline ties persistence.

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
   `[unreachable]`. It caught, live, a researcher reporting a poll "at 39%" whose source said 35%.
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

Web research cannot be backtested (a search run later finds the answer), so it is measured in
**shadow**: `bun run arena shadow run due` records what it would file (with the whole dossier and
judged proposals); re-running it re-records, and the forecast scored is the **last one recorded
before lock**, as a filing would be — every recording stays in the append-only ledger, and a record
younger than 6 h is not duplicated), `shadow score` scores resolved ones against
persistence and the baseline, `shadow list` shows the record, `bun run arena research <round>`
runs it once and prints everything. `MARINA_ARENA_SHADOW=<spec>` records hourly from the tick
job — no entrant or key needed.

## Signal discovery — Marina searching for its own edge

`bun run arena discover [--tracker T] [--proposer provider/model] [--n N]` runs the loop that found
the Civiqs nowcast, automatically (`src/arena/discovery/`):

1. A family's clean resolved rounds are split **by time**: the older 60 % are *discovery*, the rest
   *holdout*.
2. A proposer model sees the family, a sample of its history, the **signal language** (a menu of
   centres — `last`, `nowcast`, `ewma:α`, `mean:k`, `median:k`, `trend:k`, `nowcast-shrink:w` — and
   spreads — `arena`, `baseline`, `rms:w`, `mad:w`, `scale:k`), and the incumbent's and every earlier
   attempt's **discovery** score. It never sees a holdout score. Signals are data, never code.
3. Each new proposal is scored on both halves. It is **promoted** only if it beats the incumbent
   (the nowcast over the calibrated baseline) on the holdout by a margin that grows with the number
   of signals tried for the family (0.02 + 0.01·log₂(1 + tried)) and does not lose on discovery.
4. Every scored attempt is kept as a note (`arena-discovery`, type `signal`); `arena signals` (or
   `bun run arena signals`) lists them, and the next discovery round is told not to repeat them.

The same loop runs in the world: `arena discover [tracker:T]` (see [Operate](#operate)).

`MARINA_ARENA_FORECASTER=discovered` uses each family's best promoted signal and the nowcast
elsewhere. Promotion is necessary, not sufficient — record a promoted signal in shadow before it
files. First run (2026-09-26, Claude Sonnet 5 proposing, $0.02): 18 proposals across Civiqs, YouGov
and Morning Consult, **none promoted** — the closest (`nowcast-shrink:0.5` on Civiqs) beat the
incumbent's holdout 0.212 vs 0.181 but not the margin, and lost on discovery; every smoothing idea
lost on the holdout. AAII has too few clean rounds to split yet.

## Integrity: what the backtest numbers can and cannot claim

Audited 2026-09-25 (`src/arena/evaluate.ts`, `test/arena-*.test.ts`):

- **No outcome reaches a forecaster.** Only the evaluator and the live lesson writer read
  resolutions; every forecaster sees only a round's lock file and archives filtered to what existed
  before the lock (Civiqs snapshots *fetched* before it; Wikipedia lists *published* before it).
- **Rounds whose answer was already public are excluded** for every forecaster
  (`outcomePublicBeforeLock`). Found live: the five Civiqs week-38 rounds resolved on the 11 Sep
  reading but locked on 16 Sep, because their frozen history stopped at 4 Sep — a daily tracker's
  reading is public the next day. With them removed: nowcast **+0.111** overall, **+0.213** on
  Civiqs (15/20), vs the baseline's +0.046.
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
| `bun run arena submit <round_id\|due> [--dry-run] [--forecaster …] [--weight w]` | operator CLI | sign and file now |
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
`discovered`); `model:`, `crew:` and `research:` spend real money and stay operator steps
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
| `MARINA_ARENA_FORECASTER` | `nowcast` | no model calls; every non-Civiqs round is the baseline. Or `baseline`, `discovered`, `model:<m>`, `crew:<m>[,<m>,<m>]`, `research:<m>[,<m>,<m>]` |
| `MARINA_ARENA_MODEL_WEIGHT` | `0.5` | share of the model's move from the baseline that is kept |
| `MARINA_ARENA_SHADOW` | unset | a forecaster spec to record hourly in shadow (never filed) |
| `MARINA_ARENA_TRENDS_PARTIAL` | off | `on` counts a Trends basket's partial current week |
| `MARINA_ARENA_CIVIQS_LIVE` | on | `off` stops the nowcast reading the live Civiqs dashboard for open rounds |
| `MARINA_ARENA_RESEARCH_RETRIEVER` | `openrouter-web:openai/gpt-6-luna` | the research agent's search backend(s): `openrouter-web:<model>`, `sonar:<model>`, `tavily:basic` / `tavily:advanced` (needs `TAVILY_API_KEY`), comma-separated to merge |
| `MARINA_ARENA_RESEARCH_JUDGE` | `jev` (with an OpenRouter key) | `jev`, `decisions` (the configured `MARINA_DECISIONS` backend; falls back to `jev`) or `none` |
| `MARINA_ARENA_RESEARCH_TRUST` | `0.5` | most of the judged move the research agent takes |

## Beyond the baseline

The baseline is the floor, not the ceiling. The arena rewards consistency: on any single
question 20–50 % of forecasts beat persistence, yet almost nobody does on average. The next step
is a forecasting crew — researchers, respondent simulators and an aggregator that shrinks toward
the baseline unless evidence is grounded — promoted family by family only after it beats the
baseline in shadow mode.
