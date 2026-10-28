# Social Simulation Arena

Marina can enter the [Social Simulation Arena](https://social-simulation-arena.com), a live
forecasting benchmark run by Social Atoms at MIT. Every week about a dozen questions open:
presidential approval (Economist/YouGov, Civiqs, Morning Consult), consumer sentiment (UMich,
NY Fed, AAII), Google Trends shares and the Wikipedia weekly top 10. An entrant forecasts each
one before the number is published. Forecasts are sealed until the round locks, then scored in
public against a **persistence** reference (repeat the last value): skill 0 ties it, above 0 beats it.

Marina enters as a *participant* through the arena's signed route: it signs each forecast with its
own Ed25519 key and posts it itself. Nothing is exposed to the internet and no credential is shared:
the registration carries only the public key.

The arena integration is off by default. Filing is an operator act (the `bun run arena` CLI or the
env-set autopilot); the in-world `arena` command is read-only.

## Enter Marina (one time)

1. **Choose the entrant id** — lower-case, permanent (for example `your-org-marina`) — and the
   GitHub account that will own it. Only that account can change the registration later.
2. **Generate the signing key** on the server that will file:

   ```bash
   bun run arena keygen /srv/marina/arena-key.pem   # writes mode 0600, never overwrites
   ```

3. **Configure** (`.env`):

   ```bash
   MARINA_ARENA_ENTRANT=your-org-marina
   MARINA_ARENA_KEY_FILE=/srv/marina/arena-key.pem
   ```

4. **Write the registration** and open the pull request from the owning account:

   ```bash
   bun run arena registration --name "Your Org Marina" --org "Your Org" --github <login> \
     --out entrants/your-org-marina.json
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

   Every hour Marina files each round whose lock is within the filing window (24 hours by default,
   the arena's own call window) and that has no accepted forecast yet.

`readiness` reports an `arena` check once `MARINA_ARENA_ENTRANT` is set, and warns when the key
is missing or readable by other users.

## Which world for arena work?

Any. `arena`, `forecast`, `decision`, `market`, `position`, `probe`, `watch` and `web` are global
commands registered in every world, including the default Workbench, and filing goes through the
operator CLI (`bun run arena`), not a room. What matters is the database: the submission ledger,
shadow rows and discovery notes live in `DB_PATH`, which the server's autopilot and the CLI share.
Keep one `DB_PATH` for all arena work — starting a different world on a fresh database splits the
ledger. The CLI refuses a `DB_PATH` (default `marina.db` in the working directory) that does not
exist yet, since an empty ledger would read as "nothing filed, no route evidence"; pass `--new-db`
to start one on purpose. The `markets` and `prediction-lab` worlds add binary yes/no market rooms, which do not
match the arena's continuous, profile and ranking targets.

## Filing

### The filing window, early filing and replacing

- **Window.** A first filing is made only for a round locking within `MARINA_ARENA_WINDOW_HOURS`
  (default 24). `--early` files a round outside the window.
- **Replacing.** The arena's signed intake keeps every version and scores the newest one accepted
  before the lock (up to 120 per round). `bun run arena submit <round|due> --replace` files a newer
  version of an accepted round; an unchanged forecast is not re-sent, and the autopilot never
  replaces. Replacing an accepted filing is always allowed.
- **Stale anchors.** With `--replace`, `due` also selects every open round whose accepted filing
  has a stale anchor (see [Anchor guard](#anchor-guard)), whatever its lock and whatever
  `MARINA_ARENA_WINDOW_HOURS` is.
- **Near-lock refresh.** To refresh closer to the lock, schedule an operator run with a short
  window. For example, an hourly `MARINA_ARENA_WINDOW_HOURS=1.1 bun run arena submit due --replace`
  selects rounds locking within 66 minutes, while preserving the five-minute safety margin. Allow
  enough time for the selected forecaster and any simultaneous deadlines. Runners sharing a
  checkout or submission ledger should use one exclusive lock; a refresh failure leaves the
  earlier accepted forecast in place.

### How the board scores

An entrant's leaderboard row is its mean skill over the rounds it answered. Skill is
`1 − CRPS / persistence CRPS` (the energy score for profiles, 1 − rank-biased overlap for
rankings) against a persistence null frozen when the round's call window opens (the round's weekly
history, so for Civiqs last Friday's value). Multiple accepted versions of one round still produce
one scored forecast: the newest on-time version.

### Filing watch

Filing stays the operator's act outside the world, but the server watches it. When an entrant is
configured, the `arena-filing-watch` job runs about every 10 minutes and reads the open rounds.
For every round locking within 24 hours, it compares them with the filings and refresh attempts
recorded in the world DB (`arena_submissions`, `arena_attempts`). It raises one operational alert
per round in trouble (category `arena-filing`, deadline = the lock) when:

- a round has **no accepted filing** (critical within 6 h of its lock);
- the standing filing **predates the round's 24-hour refresh window and nothing has tried since**
  (critical within 6 h of its lock), the trace a runner leaves when it crashes before recording an
  attempt;
- a refresh **failed** (error, rejected or skipped) after the standing filing;
- a refresh **started and never finished** (over 30 minutes);
- within 45 minutes of the lock, **nothing ran in the last 90 minutes**, meaning the near-lock
  pass did not run;
- **stale anchor**: for every open round, whatever its lock, the accepted filing is anchored on an
  older release than the arena's latest published value (critical within 6 h of its lock), or —
  within 24 hours — the last refresh recorded `stale_anchor` (see below).

Readiness shows the last pass as `arena-filing`. The watch only reads: it never files, so a broken
runner (a stale build, a failing timer) shows up within one pass instead of after the lock. An
alert resolves itself once its round is fine again.

### Anchor guard

A forecast starts from the latest reading its inputs saw (its anchor). The arena scores every
round against persistence, the last value it treats as published at the lock, so a filing
anchored on an older release starts from the wrong level.

Before signing, every filing (autopilot, `submit`, `--replace`, dry runs) compares its anchor with
the arena's latest value for the round: the round's persistence baseline in the arena's site data
(`site/data.json`, per cell for profile rounds), dated by the series tail when that tail ends on
the same value. Ranking rounds are not checked. The comparison tolerates the arena's rounding (a
poll published as 38 matches 37.6; a one-decimal value matches within 0.05). A value that matches
is fresh whatever the dates; a different value is stale unless Marina's reading is dated the same
day or later (a daily source ahead of the arena's refresh).

When the anchor is stale, Marina drops its cached arena data and runs the forecaster again once.
If the inputs are still stale, it shifts each stale mean by (arena value − anchor), keeping the
spread, and files that; the attempt is recorded as `stale_anchor` with the reason, and the filing
watch alerts. The trace is kept in the filing's `detail.anchorGuard`. An unreadable site file never
blocks a filing (`unchecked`). `MARINA_ARENA_ANCHOR_GUARD=observe` records the verdict and files
the forecast unchanged; `off` skips the check.

### Input freshness

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
Live Civiqs failures remain in the origin trace when a sufficiently current archive is available.
Research traces retain failed engines, and formation dossiers carry explicit `verified`, `empty`,
or `failed` status; an empty dossier is never described as verified evidence.

Run `bun run arena audit <round_id|due> --fresh` to inspect the current observation dates,
input-age warnings, and Civiqs source failures without model calls or submitting anything.
`bun run arena audit <round_id|due> [--out report.json]` also checks round/series identity,
cutoff timestamps, finite ordered observations, missing cells and, for Trends, matching cell dates
and shares summing to 100. It does not fetch restricted publisher pages or invent missing releases.

### Evidence refresh and health

`MARINA_ARENA_EVIDENCE_REFRESH=on` rechecks sources before deciding whether an accepted
formation needs another panel. Reuse requires the same round, strategy, inputs and evidence
fingerprint, a complete prior run, and a forecast under 24 hours old. The final two hours
before lock require a fresh forecast if the previous one predates that window. Source
failures retain the accepted answer and appear in the attempt ledger.

Use `arena health` in-world or `bun run arena health` in the operator CLI to inspect each
round's accepted version, input dates, strategy fingerprint and latest refresh attempt.
Failures before signing and interrupted attempts are recorded separately from signed
submissions. A rejected replacement does not erase an earlier accepted forecast. CLI output
includes the spend state recorded at each attempt.

### Outcomes

Every accepted filing the arena has resolved is settled once on Marina's outcome path
(`src/arena/settle.ts`), however it was filed: the autopilot settles before each pass, and the
operator CLI settles at the start of every real `submit` (or on demand with `bun run arena
settle`). The scored version is the newest accepted filing, the one the arena scores. Numbers are
filed as forecast answers and scored by CRPS; profiles and rankings become one mechanical outcome
each, scored with the arena's own energy score / rank-biased overlap against its recorded
persistence loss. Every outcome names its family (`family:<tracker>`) and method
(`method:<kind>`, from the route in the filing's notes), so lessons, forecast history and
per-family evidence all read the entry. A settling failure never blocks filing.

Submissions also retain a local `detail` trace (migration 154): the frozen lock and its hash,
forecast origin, model proposals and fallbacks, research evidence, explicit nonsecret strategy
settings, and start/completion timestamps. It is separate from the signed wire body and survives
retries unchanged. Signing uses the completion time, and the five-minute deadline margin is
checked again after forecasting so slow retrieval cannot silently consume the filing window.

## Forecasters

`MARINA_ARENA_FORECASTER` chooses what Marina files. The default, `nowcast`, makes no model calls.
`arena show <round_id>` prints exactly what would be filed and which spread rule each series used.

| Spec | What it does |
|---|---|
| `baseline` | the statistical baseline below |
| `nowcast` (default) | the baseline, with Civiqs rounds moved to the freshest daily reading |
| `discovered` | each family's best promoted [discovered signal](#signal-discovery), the nowcast elsewhere |
| `spike-decay` | the nowcast, with Trends event-week spikes pulled back (a shadow challenger) |
| `lead` | the nowcast, with NY Fed SCE inflation expectations moved by leading official indicators where earned (a shadow challenger) |
| `tabh2o[:forecast][@nowcast]` | TabH2O over the start forecast (experimental) |
| `model:<m>` | one model over the baseline |
| `crew:<m>[,<m>,<m>]` | statistician, analyst and skeptic over the baseline |
| `formation:<pattern>:<m>[,…]` | an orchestration pattern as a forecasting protocol |
| `research:<m>[,<m>,<m>]` | the research agent: brief, retrieve, verify, forecast, judge |
| `wiki-specialist[…]` | the Wikipedia top-10 specialist |
| `routed` / `route:<map>` | a forecaster per family |

### Baseline

`src/arena/forecast.ts` is the baseline every round gets. It keeps persistence's mean. The arena's
own persistence uses a fixed `sd = 1.5` whatever the series' scale, so Marina replaces the spread
with one sized to how the series moves, where the series' own history supports it; everywhere else
it files exact persistence.

| Round shape | Baseline answer |
|---|---|
| Number (`continuous_normal`) | persistence mean ± calibrated or 1.5 spread; a weekly poll topline (Economist/YouGov, Morning Consult, AAII) takes the poll level instead (below) |
| Profile (`profile_energy`) | the same, per cell; a subgroup crosstab (`yougov_xtab`) may instead take the mean of the last k releases (below) |
| Ranking (`ranking_list`) | last-7-day Wikipedia pageview totals, Main_Page and non-articles excluded |

**Crosstab level.** A crosstab cell is a few hundred respondents of one weekly poll, so last
week's value carries last week's sampling error. For those profiles (`src/arena/sampling-noise.ts`)
the baseline also tries the mean of the last k releases (k ∈ 1, 2, 4, 6, 8), each with a spread
equal to that mean's own recent misses at the round's horizon. It picks one k for the whole profile
from the cells' rolling record, scored per target date over all cells, and uses it (rule `level`)
only when it beats the per-cell baseline by the calibration margin. The choice and its evidence
are kept in the forecast detail (`level`).

**Poll level.** A weekly poll topline is also a noisy sample. For the scalar rounds of
`economist_yougov`, `morning_consult` and `aaii` (`src/arena/poll-level.ts`, rule `poll-level`)
the start forecast is the average of persistence and the arena's own EWMA null (α 0.4), with an sd
of half that rule's own recent one-step RMS error (last 26 releases, at least 6; floor 0.5). A
series with too little history keeps the baseline. The rule, both means, the RMS and the number of
errors behind it are kept in the forecast detail (`pollLevel`) and the filing note; formations and
research start from it. `MARINA_ARENA_POLL_LEVEL=off` restores the persistence start.

### The Civiqs nowcast (`nowcast`)

Civiqs publishes **daily** trackers but the arena samples them on Fridays, so a round's history
ends at last Friday while, by its Wednesday lock, several newer daily readings are public. The
arena archives every snapshot it fetches (`civiqs/` in its repo); `nowcast` moves each Civiqs
mean — topline or profile cell — to the freshest daily reading in a snapshot **fetched before the
lock**, keeping the baseline's spread; every other round is the baseline. It is deterministic and
leakage-free, so it backtests (see [Integrity](#integrity-what-the-backtest-numbers-can-and-cannot-claim)).

**Live reading for open rounds.** For a round whose lock has not passed, the nowcast also reads
the Civiqs dashboard (`src/arena/research/civiqs-live.ts`, one paced request per tracker) and uses
whichever reading is fresher. A round whose lock has passed never reads live data, so backtests
are unaffected. `MARINA_ARENA_CIVIQS_LIVE=off` turns it off.

**Nowcast error floor.** Civiqs re-estimates its whole daily history on every model run, so the
freshest daily reading also misses the Friday value by the run-to-run revision. For each of the
last 8 Fridays in the round's history, the reading that week's Wednesday-lock nowcast would have
used is compared with the Friday value; the RMS, shrunk toward the start sd with 2 pseudo-weeks,
is recorded as `origins.<series>.errorFloor` (at least 3 measured weeks, else none). Whatever
forecaster produced the answer, the filed sd is raised to that floor when it is narrower, and the
note says so; it only ever widens.

**Horizon corrections (experimental, off by default).** A round resolves on the reading dated its
Friday release day, while the newest reading at the lock is often several days older (the horizon
*h*). `MARINA_ARENA_NOWCAST_HORIZON` adds two corrections (`src/arena/research/civiqs-horizon.ts`),
each computed only from snapshots fetched by the lock:

- `drift`: a damped local trend, the least-squares slope of the last 7 readings projected *h* days
  with damping φ (`MARINA_ARENA_NOWCAST_DAMPING`, default 0.8). It applies only when that series'
  own walk-forward history at the same horizon says a trend projection beats carrying the last
  value forward.
- `sd`: sd(*h*), the walk-forward *h*-step error of the centre in use plus Civiqs's revision noise
  at both ends; floored at 0.3 and capped at 5.
- `both`: both corrections.

They apply wherever the nowcast is the start forecast (`nowcast`, formations, research), and only
when the nowcast's reading is fresher than the round's own history. Scope them with
`MARINA_ARENA_NOWCAST_SERIES`, a comma-separated list of Civiqs series ids (for example
`civiqs_net_econ_now`); unset means every series, an empty list means none. Each forecast retains
its observation date, target horizon, selected daily or weekly anchor, snapshot reference, and
projection decision. Model prompts distinguish the raw reading from the projected start so they do
not apply the trend twice.

### Leading indicators (`lead`)

`lead` (`src/arena/lead-forecast.ts`, over `src/quant/lead-nowcast.ts`) is a free shadow
challenger. For a monthly series with registered leading indicators, today NY Fed SCE 1-year and
3-year inflation expectations, it moves the start mean by `β · Δ`. Δ is how much each indicator
changed since the target's last release: UMich 1-year expectations (`MICH`), and the change in
CPI year-over-year inflation (`CPIAUCSL`). The indicators are read from FRED as of the round's
lock (ALFRED vintages with `FRED_API_KEY`; keyless only for an open round). Each past month of
the lock's history is a case whose features use only observations published by that month's
cutoff. β is a ridge fit through the origin, shrunk toward 0 with 8 pseudo-cases. It is applied
only when its walk-forward error over those cases beats persistence by 5%; otherwise the start
stands. The spread is the start's. The forecast note records the indicators, the move, and why
it was or was not applied. It answers a family only once [earned routes](#per-family-routing-routed) say so,
for example with `MARINA_ARENA_SHADOW_CHALLENGERS=ny_fed_sce=lead`.

### Spread calibration and move weight

Every filing passes through the same steps, in order: forecaster → move weight → error floor →
spread calibration.

**Spread calibration per (series, method)** (`src/arena/calibration.ts`). Every filed sd — a
scalar topline and each profile cell — is multiplied by a scale learned from resolved rounds. The
key is `arena:<family>|<method>` (`:profile` is added to the family for profile rounds; the method
is at pattern level, e.g. `formation:delphi+research`, `nowcast`). Evidence is one record per
resolved round Marina filed: the sd before this step, the published outcome, and persistence's
loss on the round, from the arena's public `site/data.json` (scalars fall back to
`resolutions/resolved.json`). A record is visible only when its outcome was published at or before
min(now, the round's lock), and never for the round itself.

Each level's scale is the multiplier on a 0.30–3.00 grid with the best mean per-round skill. Levels
pool in log space with w = n / (n + 4): the method toward the round's series (e.g.
`civiqs_net_approval`), the series toward its family, the family toward the cross-family scale, and that — the geometric mean of the families' scales, each family counted
once — toward 1 by F / (F + 4). The result is clamped to [0.35, 3]. With no resolved rounds it is
the identity. The series level exists because one tracker's series can be miscalibrated in opposite
directions — Civiqs net approval filed too wide while angry-share filed too narrow — so a single
tracker-wide scale fixed one by breaking the other. The decision and its evidence (each level's n,
ŝ and w) are kept under `spreadCalibration` in the filing's detail. A scalar filing whose anchor was older than the release at its lock is not used as
evidence, and a poll-level start keeps its own sd until 4 poll-level filings have resolved (its
records are keyed `…+poll-level`). `MARINA_ARENA_SPREAD_CALIBRATION=observe` records without
applying; `off` skips it (the retired `MARINA_ARENA_CALIBRATION` is read when it is unset).

**Learned move weight per (family, method)** (`src/arena/move-weight.ts`). A formation files its
start plus a share of its members' median move. The move weight learns that share from outcomes:
the filed mean becomes `start + w × (median proposal − start)`, w on a grid from 0 to 1.5, fitted
by minimum CRPS on resolved filings and arena shadows of the same key, shrunk toward the
formations' own trust. It is adopted only when it beats what was filed on the newer 40 % by 5 %
AND a placebo fails: the same fit with the members' moves shuffled across rounds must not reach the
same gain. With fewer than 8 records it does nothing. The decision (w, n, held-out gain, placebo)
is kept under `moveWeight`. `MARINA_ARENA_MOVE_WEIGHT=observe` records without applying; `off`
skips it. On profile rounds the same weight multiplies every cell's move, keyed
`arena:<tracker>:profile|<method>`; a key with fewer than 8 visible rounds pools every profile
family of the same method (`moveWeight.scope = profile-families`), and the same minimum, margin
and placebo apply to the pool.

### Model backends (`model:`)

`MARINA_ARENA_FORECASTER=model:<provider/model>` puts a model on top of the baseline — any model
Marina can route, with the provider's usual key. The model sees the question, the frozen history
and the baseline, answers a distribution, and that answer is **shrunk toward the baseline**
(`MARINA_ARENA_MODEL_WEIGHT`, default 0.5); a malformed answer, a failed call or a jump beyond four
baseline sds keeps the baseline. Closed-book: no web.

### The crew (`crew:`)

`crew:<model>` — or `crew:<statistician>,<analyst>,<skeptic>` to give each role its own vendor —
runs three roles per numeric round over the baseline (`src/arena/crew.ts`):

| Role | Sees | Does |
|---|---|---|
| statistician | the dated weekly history and, for Civiqs, the last 21 daily tracker readings fetched by the lock | proposes a distribution |
| analyst | the question, the last 8 dated values, the judged lessons for this series | proposes from pollster behaviour and past misses |
| skeptic | the start forecast, both proposals and the lessons | decides how much of their move to trust (0 = stay on the start forecast) |

Every role — and the research analysts and the `model:` forecaster — gets the same account of the
round (`src/arena/prompt-context.ts`): the start forecast (the nowcast with its date and the days
left to resolution, or the persistence baseline), the resolution rule, the scoring rule, and every
value with its date.

Aggregation is deterministic code: the proposals' mean move, scaled by the skeptic's trust, with
wild or broken proposals dropped — the skeptic can shrink a move, never enlarge it. The roles'
lessons come from the judged forecast/arena lesson pool as of the round's lock; a resolved round
teaches once, through the [outcome path](#outcomes), so lessons only ever describe rounds already
published.

### Formations (`formation:`)

`formation:<pattern>:<model>[,<model>…]` (up to twelve models) runs one of Marina's orchestration
patterns as a small forecasting protocol (`src/arena/formations.ts`) over the same round context
as the crew, started from the nowcast:

| Pattern | Protocol |
|---|---|
| `ensemble` | independent proposals; the control for the others |
| `deliberation` | propose → see the others' anonymized proposals and reasons → revise once |
| `debate` | two sealed advocates (above the start / at or below it); the last model judges direction and trust |
| `chorus` | proposals broadcast → each member critiques one peer → each revises from the critique it got |
| `pipeline` (`cascade`) | quant → analyst (sees the quant's handoff) → skeptic (sets trust), strictly sequential |
| `mapreduce` | one model per driver (level/trend, calendar/publication, source quirks); reduce = sum of confidence-shrunk adjustments |
| `blackboard` | a shared scratchpad; two passes in which each model adds or corrects evidence and a number |
| `symbiosis` | a quant and an analyst exchange contributions; a revision must credit the partner's; a gap > 0.5 start-sd triggers another exchange (at most two) |
| `research` | hypothesis → the model picks a check (recent mean, trend, last-k deltas, typical move, daily readings) → Marina computes it → keep or revert → revise (two checks) |
| `delphi` | round 1 independent → Marina computes an anonymized panel summary (median and range of means and sds, short reasons) → each model revises once → median of the revisions |
| `tournament` | proposals meet in pairwise knockout matches judged by the last model; the champion is settled at the default trust × the field's agreement; the bracket is recorded |
| `verification` | each proposal is checked for a plausible mean, a plausible sd and cited values present in the data (and, with `MARINA_ARENA_RESEARCH_JUDGE`, whether the rationale follows from the data); median of the passers, the start forecast when none pass |

Aggregation is deterministic: proposals beyond 4 start-sds are dropped, the median move is scaled
by a trust (0.5 × the proposals' agreement, or the judge's/skeptic's), the final move is capped at
2 start-sds, and the sd blends by the same trust with floors at half the start sd, the narrowest
member proposal, and the linear pool of every recorded member reply (debate advocates and dropped
replies excluded). Each round's calls, statuses, trust and cost are kept in the record, with the
pattern's own audit under `protocol`.

**Proposal judge (delphi, symbiosis).** When the formation carries a verified research dossier
(`+research@…`), a decision model asks one yes/no question per member: is this member's move from
the start supported by the *verified* dossier lines? The yes-probabilities weight the median move,
and the trust becomes `0.5 × agreement × mean support`, so it can only drop; the 4-sd drop rule and
the 2-sd cap stay. A proposal that did not move counts as supported without a call; no verified
lines or no moving proposal leaves the forecast unchanged. Any judge failure files the unjudged
aggregation. The record is `forecast.judge`. Profile rounds are judged per cell (up to 16 cells a
call). `MARINA_ARENA_PROPOSAL_JUDGE=on|observe|off` (default `on`; `observe` records the judged
forecast without filing it) and `MARINA_ARENA_PROPOSAL_JUDGE_MODEL` (default `typesafe/jev-1.13`;
any Decisions-API model id on OpenRouter, or `decisions` for the world's `MARINA_DECISIONS`
backend).

**Profile rounds.** On a `profile_energy` round every pattern runs the same protocol over the whole
profile (`src/arena/formation-profile.ts`): a member answers every cell in one reply; each reply is
validated cell by cell; aggregation runs per cell with the scalar clamps; a cell nobody answered
keeps its start. A share basket (cells that add to 100) is rescaled proportionally to 100 after the
judge and the sd floors; independent subgroup cells are never rescaled. The record keeps
`profileProposals`, and under `protocol` the pattern's audit plus `cells` and `shares`. Ranking
rounds keep their start.

Auction, ledger and sharding allocate or partition work rather than combine views of one number,
so they have no formation.

**Compositions.**

- `+then:<pattern>:<models>` adds a second formation that judges the first one's handoff (e.g.
  `formation:mapreduce:…+then:debate:…`); both shrink toward the same start, so a chain cannot
  compound a move.
- `+research@<retriever>[,…]` puts a research crew in front: it builds one dated dossier per
  round, checks every cited figure against its page, and hands only the **verified** lines to every
  member. Formations accept the shared research providers, for example
  `+research@search:tavily+duckduckgo` and `+research@asof:gdelt+wayback`; the `+` inside a backend
  list is distinct from `+then:` and `+research@`. Provider keys being present does not change a
  `closed-book` route. See [captured evidence and follow-ups](search.md#captured-evidence-and-bounded-follow-ups).
  A composition with `+research@` reads today's web, so `arena evaluate` refuses it; record it with
  `arena shadow run`.
- `formation:<pattern>~unanchored:<models>` runs the same members, dossier and protocol without the
  instruction that the start forecast is the default, and asks every member to list its evidence as
  typed signals (recorded under `signals`, with a `stale` flag for anything observed before the
  start reading). It has its own method key and runs only as a shadow challenger.

Formation lessons use the canonical judged forecast/arena pool, and a filing takes only lessons
from resolved arena rounds of its own answer shape (`arena:number`, `arena:profile`,
`arena:ranking`) or its tracker's crew — never a lesson that merely shares words with the question.
Set `MARINA_ARENA_FORMATION_LESSONS=observe` (default), `on`, or `off`; the global `MARINA_LESSONS`
still limits injection. Recall uses the earlier of now and the lock, and its injected/observed
records are saved with the forecast. `MARINA_ARENA_RESEARCH_LESSONS` does the same for the
`research:` forecaster.

### The research agent (`research:`)

`research:<analyst>[,<analyst>,<analyst>]` — one analyst per vendor — runs the full pipeline
(`src/arena/research/`):

1. **Brief** — a playbook per family (other pollsters' readings with their previous reading, S&P
   moves for AAII, prices and inflation prints for consumer surveys, scheduled events for
   attention), bounded to facts after the series' latest known reading. Each brief also carries
   short keyword `queries` for search APIs. YouGov research uses the exact target question as its
   first query and asks for each figure's population, response category and subgroup.
2. **Retrieve** — `MARINA_ARENA_RESEARCH_RETRIEVER` (default
   `openrouter-web:google/gemini-3.1-pro-preview`). Options:
   - `openrouter-web:<model>[@<engine>[:<mode>]]`, engines `native`, `exa`, `parallel`,
     `perplexity`, `firecrawl`;
   - `sonar:<model>` (Perplexity Sonar through OpenRouter);
   - `tavily:basic` / `tavily:advanced` (Tavily's search API, `TAVILY_API_KEY`; each result becomes
     one dated dossier line, and its page text is used for the citation check);
   - `search:<backend>+…`, the page-reading engine over a backend chain, e.g.
     `search:duckduckgo+deepseek` (`DEEPSEEK_API_KEY`);
   - a comma-separated list runs several engines on the same brief and merges their reports.

   Prices and details are in [search.md](search.md#engines-and-prices). New retrievers are
   shadow-only until they have resolved rounds to their name.
3. **Verify citations** — every dossier line that cites a page has its figures looked up in that
   page and is tagged `[verified]`, `[unverified]` or `[unreachable]`. Pages are fetched through
   the SSRF guard (up to 12 pages, 15 s each, a descriptive User-Agent, the first 16 MB read).
   Publishers whose terms bar bots (`NO_FETCH_DOMAINS`: YouGov, AAII, Conference Board,
   CivicScience) are never read, so their lines stay `[unreachable]`.
4. **Analysts** — forecast from the dated history, the start forecast, for Civiqs the recent daily
   tracker, the resolution and scoring rules, and the tagged dossier; told to use other sources
   for **changes**, never levels, and only changes the start reading does not already include.
5. **Judge** — `MARINA_ARENA_RESEARCH_JUDGE` (default `jev`: jev-1.13 via OpenRouter's Decisions
   API; `decisions` uses the `MARINA_DECISIONS` backend; `none` disables) scores each rationale's
   grounding in the evidence the analysts were given; ungrounded, or a judge outage ⇒ no weight.
   The judge's calls, latency and cost are recorded.
6. **Aggregate** — judge-weighted mean move × confidence × `MARINA_ARENA_RESEARCH_TRUST` (0.5).

On a profile round the same pipeline runs over the whole profile, item by item, and step 6 runs
per cell.

**Rounds with no history (no-anchor mode).** A one-off numeric round (an election result, say)
can lock with an empty `answer_history`. Every other forecaster anchors on the last published
value and refuses it with "no history to forecast from"; `research:` answers it without an anchor
(`noAnchorForecastRound` in `src/arena/research/forecaster.ts`):

- the brief asks for the **level** (published forecasts, prediction-market prices, the data they
  rest on, the base rate) over the 30 days before now (or the lock);
- analysts may abstain; only a grounded proposal counts, and a judge outage counts as none;
- sanity bounds come from the question (a named total bounds the mean to [0, total], a percentage
  unit to [0, 100]); outliers more than 3 robust spreads from the median are dropped;
- the answer is the median of the remaining means, with
  sd = max(median analyst sd, the means' sample sd, 7 % of the median);
- with nothing usable the round is **not answered**: a `NoAnchorRefusal` whose `detail` keeps the
  dossier, proposals and judge; `bun run arena research <round>` prints that trail.

To answer such rounds, route their family to research, e.g.
`<family>=research:<m>[,<m>…]@<retriever>`.

**Structured evidence.** `MARINA_ARENA_RESEARCH_LOOKUPS` lists the structured lookups research may
use (`fred`, `polymarket`, `kalshi`, `votehub`). `FRED_API_KEY` makes vintage-aware FRED series
available for any past lock (keyless FRED is live-only). A formation with `+research@closed-book`
uses the empty web retriever plus these structured lookups. FRED evidence includes current and
previous observations, their same-vintage change, units and vintage date; verification uses the
frozen structured payload rather than a mutable HTML page. For a monthly round, a related series
whose latest observation predates the target period is labelled `STALE`. Historical intraday
cutoffs use the prior UTC day's FRED vintage. Sports odds are excluded from arena research.

`MARINA_ARENA_RESEARCH_SIGNALS` adds mapped outside signals:

- `consumer` adds FRED gasoline prices (GASREGW) and initial claims (ICSA) to Civiqs
  economic/household/inflation research; `MARINA_ARENA_RESEARCH_LOOKUPS` must include `fred`.
- `all` adds every mapped signal for the round's family (`ARENA_SIGNAL_MAP` in
  `src/arena/research/signal-map.ts`). With `all` and `MARINA_ARENA_RESEARCH_LOOKUPS` unset, the
  lookups are `polymarket,kalshi,fred,votehub`.

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
| UMich sentiment and party | MICH, GASREGW, NASDAQCOM, ICSA, UNRATE, CPIAUCSL, T5YIE (never UMCSENT, the target itself) | — | — |
| NY Fed SCE 1-year / 3-year | MICH or EXPINF3YR first, then EXPINF1YR, T5YIE, CPIAUCSL, GASREGW | How high will inflation get in 2026 | — |
| AAII | NASDAQCOM, NASDAQ100, VIXCLS | S&P 500 close end of 2026 | — |
| Google Trends, Wikipedia | none | — | — |

Polymarket, Kalshi and VoteHub are keyless. The market phrases name 2026 contracts and need
revisiting when the season rolls over. Every signal is cut at the lock: FRED reads the vintage of
the lock's prior UTC day, markets the last price at or before the lock, and a VoteHub poll counts
only when its whole listing day precedes the lock, with the target's own pollster excluded. Market
and poll lines are frozen under their own payload URL, so the citation check verifies what was
read. The fingerprint records the effective lookups.

**Required research and fallback.** `MARINA_ARENA_RESEARCH_REQUIRED=on` makes research required
unless it fails (closed-book retrieval, no verified evidence, a failed or unfinished research loop,
a read swarm with no successful reader, a judge that grounds no proposal, or a formation with no
usable proposal). What is filed then is `MARINA_ARENA_RESEARCH_FALLBACK`: `closed-book` (default)
runs the same formation or analysts with no retrieval and files the start forecast if that fails;
`start` files the start forecast at once; `skip` refuses the round (an accepted filing stays). A
fallback filing records `forecast.researchFallback` and its note says `research fallback
(closed-book|start)`; the failed dossier and its cost are kept. The calibrators key it as a
closed-book filing. A no-history round still has no start and is refused.

**Research options shared with other surfaces.**

- `MARINA_RESEARCH_TARGET_EVIDENCE=observe|on` adds claim identity and target-aware selection to
  the shared capture layer. `observe` records the index; `on` also selects whole claims within the
  prompt budget. Repeated citations do not become new observations.
- `MARINA_RESEARCH_ADVICE=observe|on` also applies to the evidence gap loop. It cannot override
  dates, invent measurements, lift spending caps, or turn incomplete required research into a
  successful filing.
- `MARINA_RESEARCH_SURVEY_FILE` adds structured survey waves (see below).
- `MARINA_RESEARCH_CALENDAR_FILE` accepts a JSON array of release events with `source`, `target`
  (the round ID), `scheduledAt`, `announcedAt`, `url` and `status` (`scheduled`, `delayed`, or
  `published`). Due events add source reads and trigger a panel refresh. A schedule is never proof
  of publication.

**Structured survey imports.** For a workbook you are permitted to use, convert it without network
access:

```bash
python3 scripts/arena-survey-import.py /path/to/archived.xlsx \
  --source-url https://example.org/permitted-archive.xlsx \
  --available-at 2026-10-01T20:00:00Z \
  --measure 'presidential job approval' > /private/survey-waves.json
```

The importer binds sheet names through workbook relationships, checks the wave axis and responses,
retains base sizes, and hashes the original document. Set
`MARINA_RESEARCH_SURVEY_FILE=/private/survey-waves.json` to add the newest two eligible waves per
source (up to 20 waves total) to matching research requests. Use the actual availability of the
archived vintage, not a survey field date. Publisher restrictions still apply.

### TabH2O (`tabh2o`, experimental)

`MARINA_ARENA_FORECASTER=tabh2o` asks [TabH2O](https://tabh2o.h2oai.com/docs), H2O.ai's tabular
foundation model (`TABH2O_API_KEY`), for each numeric round (`src/arena/tabh2o-forecaster.ts`).
The training table is built only from what the round froze at its lock. An interval supplies the
spread only when the server explicitly provides its coverage probability; otherwise Marina uses
horizon-matched historical change errors. The answer is shrunk toward the start forecast with
`MARINA_ARENA_MODEL_WEIGHT`, as `model:` does.

| Spec | Starts from |
|---|---|
| `tabh2o` | the calibrated baseline |
| `tabh2o@nowcast` | the nowcast |
| `tabh2o:forecast[@nowcast]` | as above, using TabH2O's time-series endpoint |

A missing key, an error, too little history or a malformed reply files the start forecast and
records why; ranking rounds keep the start. Calls are paced under the API's rate limit and metered
on the daily spend ledger.

### Profile and ranking rounds

`arena evaluate` scores profile and ranking rounds exactly as the leaderboard does — the energy
score over the arena's deterministic point set for profiles, 1 − RBO for rankings
(`src/arena/score-shapes.ts`) — against the arena's recorded persistence loss for each round.

- **Civiqs profiles**: the nowcast moves every cell to its freshest daily reading.
- **Wikipedia top 10 (default)**: views are weighted by recency (half-life 3 days) over three weeks
  of the arena's `wikitop/` archive, using days published before the lock (a two-day lag).
- **Wikipedia specialist** (`wiki-specialist[:<model>[,<model>…][@<retrievers>]]`,
  `src/arena/wiki-specialist.ts`) forecasts the target week's views instead of ranking last week's.
  A `wiki-top10-<Sunday>` round locks the Friday 14:00 UTC before its Monday–Sunday week, and the
  newest readable daily list is the lock day − 2. Inputs are 28 daily top-1000 lists: the arena's
  `wikitop/` archive first, the Wikimedia REST top endpoint for missing days
  (`src/arena/wikimedia.ts`: a User-Agent with a contact URL, requests ≥ 100 ms apart, SSRF guard).
  Each candidate title is projected as a base level plus an excess that decays exponentially, and
  the list is ordered by the projected weekly sum with a discount on fading spikes. With models,
  scheduled events proposed from dated sources pass the same mechanical checks as
  `research:wiki-events` and merge into the list. The detail keeps the projection
  (`wikiSpecialist`) and every candidate (`wikiEvents`). Route it with
  `wikipedia=wiki-specialist` in `MARINA_ARENA_ROUTES`.
- **Wikipedia scheduled events** (`research:wiki-events:<model>[@<retrievers>]`): searches for
  events in the target week, one model call proposes candidates — each naming its source — and only
  candidates that pass mechanical checks change the list (the cited source was retrieved, predates
  the cutoff and mentions the article; the event date falls in the week; the English Wikipedia
  article exists; its pageviews are read from Wikimedia and clear a minimum share of the entry
  bar). An article is demoted only when the cited source says the event ended and its views are
  already below half their two-week peak. At most `MARINA_ARENA_WIKI_EVENTS_MAX_INSERT` articles
  (default 3) are added. Web search cannot be replayed, so it runs as a shadow challenger.
- **Attention extractors** (`MARINA_ARENA_WIKI_EXTRACTORS`, off by default; `src/arena/extraction/`):
  narrow extractors run on the specialist's best `MARINA_ARENA_WIKI_EXTRACTOR_TOP` candidates
  (default 30), each producing typed records `{subject, feature, value, asOf, source, confidence}`
  as of the round's cutoff: `edits` (MediaWiki revisions in the 28 days before the lock), `related`
  (pageview growth of linked articles), `news` (Portal:Current events mentions in the week before
  the lock), `gdelt` (GDELT coverage, slow) and `events` (sentences of the article's revision at
  the cutoff — and of a date-strict `MARINA_ARENA_WIKI_EXTRACTOR_RETRIEVER`'s sources — that state a
  date in the target week; one call to `MARINA_ARENA_WIKI_EXTRACTOR_MODEL` picks the sentence, and
  the pick stands only if that sentence states that date). A record dated after the cutoff is
  dropped. Records move a candidate's projected views only through explicit, bounded multipliers
  (`src/arena/extraction/adjust.ts`), and every record and multiplier is kept in `wikiExtraction`.
  The `+extract:<list>` suffix on a spec (e.g. `wiki-specialist+extract:events`) overrides
  `MARINA_ARENA_WIKI_EXTRACTORS` for that spec.
- **Google Trends baskets**: Trends re-normalises its index in every snapshot. Forecasts use a
  newer complete basket from `trends/` when available, keeping all cells in one snapshot; the
  original lock still defines the scoring baseline. Complete weeks only are used
  (`MARINA_ARENA_TRENDS_PARTIAL=on` adds the partial week). Archive inputs require the exact target
  basket and well-formed data; histories are never spliced across vintages. `spike-decay`
  (`src/arena/spike-decay.ts`) moves a cell in an event week halfway back toward its recent median
  and renormalises the basket.
- **YouGov crosstab profiles**: no structured source yet; the baseline (or crosstab level) answers.
  Distinguish adults from registered voters, and total from strong approval; other pollsters'
  levels cannot fill missing target data.

### Per-family routing (`routed`)

`MARINA_ARENA_FORECASTER=routed` answers each tracker family with its own forecaster, read from
`MARINA_ARENA_ROUTES` (`family=spec;…;*=spec`); unset, every family gets the nowcast. Quote the
value in `.env` (it contains `;`). Or write a spec inline:
`route:civiqs=nowcast;aaii=formation:chorus:<m>,<m>,<m>;*=baseline`. A route of `skip` leaves a
family unanswered: `submit` reports it as "not answered" rather than a failure, and `evaluate`
leaves it out of the mean, as the board does.

**Earned routes.** Each route is its family's default, not a fixed choice
(`src/arena/earned-routes.ts`). Before a routed round is filed, the evidence on record is read:
scored filings of every resolved round, the shadow ledger's last pre-lock record of every runnable
forecaster spec, and shared outcome rows tagged `family:<tracker>`, `method:<runnable spec>` and
`arena:<round>` (never counted twice; `MARINA_ARENA_ROUTE_OUTCOMES=off` reads the arena tables
only). Only outcomes that were public by then count. A challenger replaces the default only on the
general forecaster's promotion rule (`earnedPick` in `src/forecast/routing.ts`):

- at least `MARINA_ARENA_ROUTE_MIN_N` (default 8) rounds that both answered;
- a paired mean gain whose 95 % lower bound is above 0;
- a gain past `promotionMargin(tried)`, which grows with every challenger considered.

A shadow record is named `<spec>#<fingerprint>` (the spec under one set of operator settings).
Those settings variants are pooled into their runnable spec (`challengerPoolKey`): the spec is
what a route names and runs, so each round counts once for it, from its variant recorded last
before the lock. Nothing pools across specs: two models, two formation panels or two `tabh2o`
modes of one method kind stay separate challengers, and only the default follows its kind across
model upgrades. `forecast routes` and `arena shadow score` show how many variants a spec pooled.

Short of that, the default answers. `MARINA_ARENA_ROUTING=observe` records the pick without acting
on it, and `off` skips it. `<family>=!<spec>` pins a family, so evidence never replaces it; `skip`
is always pinned. Every decision is kept in the filing's detail as `routing`.

Challengers are listed per family in `MARINA_ARENA_SHADOW_CHALLENGERS`
(`civiqs=nowcast|<spec>;aaii=<spec>`) and run only with `bun run arena shadow challengers
<round_id|due>`; they file only once earned routing promotes them. Earned routing needs eight
paired resolved rounds, so give challengers room: `--hours 168` reaches every round locking in the
next week, recording each once early and again within 24 h of its lock (the last record before
lock is the one compared); cheap specs run before model panels (`formation:`, `crew:`, `+research`);
`--budget-minutes N` stops starting new runs after N minutes and leaves the rest for the next pass.
Run them outside any lock the filing job holds, so a long pass never delays a filing.

## Measuring forecasters

Nothing in this section signs or submits a forecast, changes routes, installs timers or promotes a
strategy on its own.

### Backtests (`evaluate`)

`bun run arena evaluate [--forecaster …] [--weight w] [--shape profile] [--out FILE]` replays
resolved rounds in lock order on frozen inputs and prints skill per family, with model cost. For
`crew:` it replays lesson learning in a throwaway database (`--no-learn` to compare). Compositions
with `+research@` read today's web and are refused; record them in shadow instead. A model whose
training data covers a round's release could know its answer, so weigh rounds after its cutoff.
In-world, `arena evaluate` is limited to forecasters that make no model calls.

### Shadow forecasts

Web research cannot be backtested, so it is measured in **shadow**:

- `bun run arena shadow run <round_id|due> [--forecaster …]` records what a forecaster would file,
  with the whole dossier and judged proposals. The forecast scored is the last one recorded before
  lock; every recording stays in the append-only ledger, and a record younger than 6 h is not
  duplicated. `MARINA_ARENA_SHADOW=<spec>` records hourly from the tick job — no entrant or key
  needed.
- `shadow score` scores resolved records against persistence and the baseline; `shadow list` shows
  the record; `bun run arena research <round>` runs research once and prints everything.
- `shadow horizons <round_id|due> [--weekly-anchor]` compares the horizon policies (off, drift at
  damping 0.8 and 1.0, spread-only, combined; `--weekly-anchor` adds two projections from a newer
  weekly anchor) with no model calls.
- `shadow compare <round_id|due>` records matched candidates for a Delphi route (statistical start,
  closed-book Delphi, Delphi with verified FRED evidence, and uncertainty calibration of that final
  forecast) on shared captured inputs. `shadow paired-score` scores the latest matched batch per
  round and configuration; incomplete batches are reported and excluded, and each eligible scalar
  candidate reports `attributionFromStart` (the skill difference split between mean and spread).

Shadow variants include a fingerprint of the forecaster's strategy settings, so different horizon
modes, damping, series, routes and lookups never share a deduplication key.

**Uncertainty calibration (shadow-only).** It uses recorded errors from complete forecasts of the
exact same estimator and configuration, within the same family and unit. It needs at least twelve
distinct resolved rounds: at least eight in an earlier training block and four in a later
validation block, with waves kept together. A bounded spread adjustment must improve validation
mean normalized CRPS by five percent; the centre never changes. Accumulate scorer exports with:

```bash
bun run scripts/arena-calibration-history.ts \
  --as-of 2026-10-10T12:00:00Z --output history-next.json history-previous.json scores.json
```

Omit `history-previous.json` on the first run. The tool writes a new file, refuses overwrites,
rejects invalid chronology and conflicting forecasts/outcomes, admits only outcomes available
before the cutoff, and deduplicates repeated exports. Do not pass stochastic repetitions as
additional calibration rounds.

**Settlement replays.** `replayDelphiSettlement` in `src/arena/settlement-shadow.ts` re-aggregates
a complete two-round Delphi trace with `{ meanWeight, spreadWeight, sdScale? }` (defaults 0.5, 0.5,
1) without new model calls. It first reconstructs the recorded forecast exactly and refuses
partial or incompatible traces. Record each setting before lock and compare on matched resolved
rounds; repeats are correlated evidence, not independent questions.

### Frozen research comparisons (`arena:research`)

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
snapshot and `--history` for a validated calibration-history file. Models, token/call ceilings and
source policy are hashed into the configuration. The runner preserves the first attempt per arm,
checkpoints before paid forecasting, and refuses a late run. `--max-tokens` (default 2000) bounds
forecast and page-reader responses. Compile the runner with `bun build scripts/arena-research.ts
--target=bun --outfile=/private/arena-research.js` and use that same file for capture and run.

Scoring is read-only and retains missing, failed and late attempts. Qualification requires at
least 12 distinct resolved rounds (eight discovery and four later holdout rounds in whole lock
waves), nonnegative discovery gain, and at least two skill points average holdout gain without a
losing holdout question. Eligibility is for review only. Keep experiment artifacts outside the
tracked repository.

### Shadow portfolios (`arena:portfolio`)

`arena:portfolio` compares formation plans on one frozen start, lock and verified dossier, and
records the whole attempt in one `arena_shadow` row:

```sh
bun run arena:portfolio <round_id> --db /tmp/arena-shadow.db \
  --models <provider/model>,<provider/model> --plan layered \
  --max-calls 32 --concurrency 4 --timeout-ms 300000 --max-tokens 2000 \
  --out /tmp/portfolio.json
bun run arena:portfolio score --db /tmp/arena-shadow.db --out /tmp/portfolio-scores.json
```

- Plans are `control` (Delphi), `parallel` (independent Delphi and symbiosis, then a mixture),
  `layered` (the mixture followed by verification) and `independent`. `--plan-file` accepts an
  `ArenaPlan` JSON object (at most 32 steps, eight members per formation, depth three); keep the
  top-level `control` step for paired scoring.
- `--plan auto --selector jev|decisions` asks a decision provider to choose among the plans; with no
  selector or an unavailable upstream, the control runs. `--evidence` accepts exported score
  reports or versioned `RouteEvidence` records (`src/coordination/task-routing.ts`).
- `--research-paths shared|independent`, `--research-queries 6` and `--retriever search` compare
  shared evidence against independently researched hypotheses; `--research-save <file>` and
  `--research-replay <file>` reuse the same research across both runs.
- Call admission and concurrency are shared across all branches. These are invocation limits, not
  guaranteed dollar ceilings; the world's daily spend guard still applies (`DB_PATH`'s ledger).
  `costFinal: false` means reported spend can still increase upstream.
- Ranking rounds are rejected. Scoring selects the latest attempt per round/configuration,
  including failures; the ledger scan is bounded to the latest 2,000 rows.

### Additional challengers

```bash
bun run scripts/arena-challengers.ts <round_id> --db /private/shadow.db --kind attention
bun run scripts/arena-challengers.ts <round_id> --db /private/shadow.db --kind numeric --tabh2o
bun run scripts/arena-challengers.ts <round_id> --db /path/to/world.db --kind uncertainty
bun run scripts/arena-challengers.ts <round_id> --db /private/shadow.db --kind population --input /private/scenario.json
bun run scripts/arena-challengers.ts score --db /private/shadow.db --out /private/scores.json
```

- `attention` compares Trends basket vintages, aligned seasonal weeks and partial weeks, or
  Wikipedia pageview trajectories. Optional `events` in the input JSON (`item`, `startsAt`,
  `endsAt`, `knownAt`, `source`, `multiplier`) are scenario assumptions, not measured effects.
- `numeric` compares fixed local-level models and optionally TabH2O. Input `covariates` carry
  `name`, `value`, `observedAt` and `availableAt`.
- `uncertainty` derives predeclared scales and Civiqs floors from a complete accepted forecast.
- `population` requires `population.target`, `population.strata`, `population.scenario`,
  `population.priorShare`, `population.priorStrength` and `population.commonSd`. Outputs are
  labelled simulations, not survey observations.

Scoring keeps the latest whole batch, including failed and missing candidates. Its
`calibrationObservations` feed the calibration-history importer.

### Signal discovery

`bun run arena discover [--tracker T] [--proposer provider/model] [--n N]` proposes and tests
statistical signals automatically (`src/arena/discovery/`):

1. A family's clean resolved rounds are split **by time**: the older 60 % are *discovery*, the rest
   *holdout*.
2. A proposer model sees the family, a sample of its history, the **signal language** (centres
   `last`, `nowcast`, `ewma:α`, `mean:k`, `median:k`, `trend:k`, `nowcast-shrink:w`,
   `nowcast-mean:k`, `nowcast-drift:φ`; spreads `arena`, `baseline`, `rms:w`, `mad:w`, `scale:k`,
   `horizon`), and the incumbent's and every earlier attempt's **discovery** score. It never sees a
   holdout score. Signals are data, never code.
3. Each proposal is scored on both halves. It is **promoted** only if it beats the incumbent on the
   holdout by a margin that grows with the number of signals tried for the family
   (0.02 + 0.01·log₂(1 + tried)) and does not lose on discovery.
4. Every scored attempt is kept as a note (`arena-discovery`, type `signal`); `arena signals` lists
   them, and the next round is told not to repeat them.

`bun run arena discover --tracker T --signal <centre>/<spread> [--signal …]` scores signals an
operator proposes, with no model call, under the same split, margin and record. The proposer is
`MARINA_ARENA_PROPOSER`. To trial a signal without touching the live record, promote it in a
separate database (`DB_PATH=<scratch> bun run arena discover …`) and shadow `discovered` from it
before filing it.

## Integrity: what the backtest numbers can and cannot claim

Enforced in `src/arena/evaluate.ts` and covered by `test/arena-*.test.ts`:

- **No outcome reaches a forecaster.** Only the evaluator and the live lesson writer read
  resolutions; every forecaster sees only a round's lock file and archives filtered to what existed
  before the lock (Civiqs snapshots *fetched* before it; Wikipedia lists *published* before it).
- **Rounds whose answer was already public are excluded** for every forecaster
  (`outcomePublicBeforeLock`).
- **Model memorisation.** A model-backed forecaster may have seen resolved values in training;
  the baseline and the nowcast use no model at all.
- **In-sample design choices.** Settings chosen after looking at resolved rounds make backtest
  numbers optimistic. The forward test is `arena shadow run`, which records predictions before the
  lock, scored only once the arena resolves them.
- **Source terms.** Civiqs, Wikipedia and Google Trends are rights-approved in the arena's own
  review; Marina reads the arena's public archive of them. The research agent's citation check
  never fetches publishers whose terms bar bots or forwarding (`NO_FETCH_DOMAINS`).
- **Backtest rankings are hypothetical.** Only forecasts filed before lock count on the official
  leaderboard. Retrospective replays, unresolved rehearsals and unfiled shadows never update it.

## Commands

| Command | Where | What it does |
|---|---|---|
| `arena` / `arena status` | in-world, rank 0 | entrant, key readiness, autopilot, filed counts |
| `arena rounds [n]` | in-world | open rounds, soonest lock first, with Marina's filing status |
| `arena show <round_id>` | in-world | the question and exactly what Marina would file |
| `arena submissions` | in-world | the signed record of what was filed |
| `arena health` | in-world / CLI | accepted version, input dates, fingerprint and latest refresh per round |
| `arena backtest [n]` | in-world | baseline skill vs the arena's persistence, per family |
| `arena evaluate [baseline\|nowcast\|discovered] [tracker:T] [limit:N]` | in-world | score a free forecaster against the baseline on resolved rounds |
| `arena shadow [list]` · `arena shadow score` | in-world | the shadow ledger, and its score on resolved outcomes |
| `arena shadow run <round_id\|due> [forecaster:F]` | in-world | record a free forecaster's forecast for rounds about to lock (never filed) |
| `arena discover [tracker:T] [n:N]` · `arena signals [tracker:T]` | in-world | run signal discovery (rate limited), list every attempt |
| `forecast routes [family]` | in-world | per-route paired evidence across forecast and arena records |
| `bun run arena submit <round_id\|due> [--dry-run] [--replace] [--early] [--forecaster …] [--weight w]` | operator CLI | sign and file now |
| `bun run arena settle` | operator CLI | put every resolved filing on the outcome path once |
| `bun run arena routes` | operator CLI | every family's routing decision now (read-only) |
| `bun run arena audit <round_id\|due> [--fresh] [--out FILE]` | operator CLI | validate input identity, timing, history and basket comparability |
| `bun run arena evaluate [--forecaster …] [--weight w] [--out FILE]` | operator CLI | score forecasters on resolved rounds; files nothing |
| `bun run arena shadow run\|score\|list\|horizons\|compare\|paired-score\|challengers …` | operator CLI | shadow records (see [Shadow forecasts](#shadow-forecasts)) |
| `bun run arena research <round_id>` | operator CLI | run the research agent once and print the trail |
| `bun run arena discover …` · `bun run arena signals` | operator CLI | signal discovery |
| `bun run arena keygen <path>` / `registration` | operator CLI | key and registration file |

Filing is deliberately an operator act (CLI or env-set autopilot), never an in-world one: it
speaks for the organization in public. Everything else can run in the world, so an agent can
measure, discover and check a signal forward on its own:

```
arena discover tracker:civiqs                 # propose → backtest (time split) → promote
arena evaluate discovered                     # promoted signals vs the baseline, resolved rounds
arena shadow run due forecaster:discovered    # record forecasts for rounds about to lock
arena shadow score                            # once they resolve
```

In-world runs are limited to forecasters that make no model calls (`baseline`, `nowcast`,
`discovered`); `tabh2o`, `model:`, `crew:`, `formation:` and `research:` spend money and stay
operator steps. `arena discover` is rate limited per entity (2, then 1 an hour) and runs one at a
time, because every attempt raises that family's promotion bar. Discovery attempts and shadow rows
land in the world database, the same ledger the operator CLI and autopilot read.

## Guarantees

- **One forecast per round.** A round with an accepted forecast is never filed again by the
  autopilot; the ledger (`arena_submissions`, append-only) records every signed request.
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
- **Spend.** Every spending `arena` subcommand attaches the world database's ledger (`DB_PATH`),
  so its spend counts against the same daily total as the server.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MARINA_ARENA_ENTRANT` | unset (off) | the registered entrant id |
| `MARINA_ARENA_KEY_FILE` | — | PKCS#8 PEM (or raw 32-byte seed), mode 0600 |
| `MARINA_ARENA_KEY_ID` | `k1` | the key's id in the registration |
| `MARINA_ARENA_AUTOPILOT` | off | `on` files due rounds hourly |
| `MARINA_ARENA_WINDOW_HOURS` | `24` | how close to its lock a round is filed (above 168 ⇒ 168, with a warning; invalid ⇒ 24) |
| `MARINA_ARENA_URL` / `MARINA_ARENA_AUDIENCE` | production | a rehearsal fork's intake |
| `MARINA_ARENA_DATA_URL` | the arena repo on GitHub | where rounds, locks and resolutions are read |
| `MARINA_ARENA_FORECASTER` | `nowcast` | see [Forecasters](#forecasters) |
| `MARINA_ARENA_MODEL_WEIGHT` | `0.5` | share of the model's move from the baseline that is kept (`model:`, `tabh2o`) |
| `MARINA_ARENA_ROUTES` | unset | `family=spec;…;*=spec` for `routed` |
| `MARINA_ARENA_ROUTING` | on | earned routing: `observe` records only, `off` skips |
| `MARINA_ARENA_ROUTE_MIN_N` | `8` | paired rounds a challenger needs before it can replace a route |
| `MARINA_ARENA_ROUTE_OUTCOMES` | on | `off` reads only the arena tables as routing evidence |
| `MARINA_ARENA_SHADOW` | unset | a forecaster spec to record hourly in shadow (never filed) |
| `MARINA_ARENA_SHADOW_CHALLENGERS` | unset | per-family challengers for `shadow challengers` |
| `MARINA_ARENA_ANCHOR_GUARD` | on | `observe` records only, `off` skips the stale-anchor check |
| `MARINA_ARENA_POLL_LEVEL` | on | `off` restores the persistence start for poll toplines |
| `MARINA_ARENA_SPREAD_CALIBRATION` | on | `observe` records only, `off` skips (`MARINA_ARENA_CALIBRATION` is the retired name) |
| `MARINA_ARENA_MOVE_WEIGHT` | on | `observe` records only, `off` skips |
| `MARINA_ARENA_CIVIQS_LIVE` | on | `off` stops the nowcast reading the live Civiqs dashboard for open rounds |
| `MARINA_ARENA_NOWCAST_HORIZON` | off | `drift`, `sd` or `both` |
| `MARINA_ARENA_NOWCAST_DAMPING` | `0.8` | damping φ for `drift` |
| `MARINA_ARENA_NOWCAST_SERIES` | unset (all) | Civiqs series the horizon corrections apply to |
| `MARINA_ARENA_TRENDS_PARTIAL` | off | `on` counts a Trends basket's partial current week |
| `MARINA_ARENA_EVIDENCE_REFRESH` | off | `on` rechecks sources before re-running an accepted formation |
| `MARINA_ARENA_FORMATION_LESSONS` | `observe` | judged lessons for formations: `on`, `observe`, `off` |
| `MARINA_ARENA_PROPOSAL_JUDGE` | `on` | delphi / symbiosis with verified research: judged support weights the move and lowers trust; `observe` records only, `off` skips |
| `MARINA_ARENA_PROPOSAL_JUDGE_MODEL` | `typesafe/jev-1.13` | any Decisions-API model id on OpenRouter, or `decisions` |
| `MARINA_ARENA_RESEARCH_RETRIEVER` | `openrouter-web:google/gemini-3.1-pro-preview` | the research agent's search backend(s); see [the research agent](#the-research-agent-research) |
| `MARINA_ARENA_RESEARCH_JUDGE` | `jev` (with an OpenRouter key) | `jev`, `decisions` (falls back to `jev`) or `none` |
| `MARINA_ARENA_RESEARCH_TRUST` | `0.5` | most of the judged move the research agent takes |
| `MARINA_ARENA_RESEARCH_LOOKUPS` | off | structured lookups: `fred`, `polymarket`, `kalshi`, `votehub` (unset under `RESEARCH_SIGNALS=all`: all four) |
| `MARINA_ARENA_RESEARCH_LESSONS` | `observe` | judged lessons for `research:`: `on`, `observe`, `off` |
| `MARINA_ARENA_RESEARCH_SIGNALS` | off | `consumer` or `all` mapped outside signals |
| `MARINA_ARENA_RESEARCH_REQUIRED` | off | `on` makes research required unless it fails |
| `MARINA_ARENA_RESEARCH_FALLBACK` | `closed-book` | what failed required research files: `closed-book`, `start`, or `skip` |
| `MARINA_ARENA_WIKI_EVENTS_MAX_INSERT` | `3` | most articles scheduled events may add to a Wikipedia list |
| `MARINA_ARENA_WIKI_EXTRACTORS` | off | attention extractors for the Wikipedia specialist |
| `MARINA_ARENA_WIKI_EXTRACTOR_TOP` | `30` | candidates the extractors read |
| `MARINA_ARENA_WIKI_EXTRACTOR_MODEL` | `openrouter/deepseek/deepseek-v4.1-flash-1017` | the `events` extractor's model |
| `MARINA_ARENA_WIKI_EXTRACTOR_RETRIEVER` | unset | a date-strict retriever for the `events` extractor |
| `MARINA_ARENA_PROPOSER` | `anthropic/claude-opus-5-5` (OpenRouter's Claude Opus 5.5 when only `OPENROUTER_API_KEY` is set) | the signal-discovery proposer |
| `MARINA_RESEARCH_TARGET_EVIDENCE` | off | `observe` or `on`: target-aware claim selection |
| `MARINA_RESEARCH_ADVICE` | off | `observe` or `on`: advice for the evidence gap loop |
| `MARINA_RESEARCH_SURVEY_FILE` | unset | structured survey waves from `scripts/arena-survey-import.py` |
| `MARINA_RESEARCH_CALENDAR_FILE` | unset | JSON release calendar for research refreshes |

Provider keys used by arena forecasters: `FRED_API_KEY`, `TAVILY_API_KEY`, `DEEPSEEK_API_KEY`,
`TABH2O_API_KEY`, and the usual model provider keys. See
[the environment reference](../reference/environment.md) for every variable.

## Troubleshooting

| Symptom | Check |
|---|---|
| `readiness` warns about the arena key | the key file exists, is mode 0600 and `MARINA_ARENA_KEY_FILE` points at it |
| A round shows "no history to forecast from" | the round has no `answer_history`; route its family to `research:` or leave it unanswered |
| An `arena-filing` alert is open | `bun run arena health` shows the round's accepted version and last attempt; `bun run arena submit due --replace` refreshes |
| A filing was recorded as `stale_anchor` | the inputs were older than the arena's latest value; check `detail.anchorGuard` and the source the series reads |
| A route never changes | earned routing needs `MARINA_ARENA_ROUTE_MIN_N` paired resolved rounds and a gain past the margin; see `bun run arena routes` |
| A research filing says `research fallback` | research failed; the dossier and reason are in `forecast.researchFallback` |
| The submission seems missing from the leaderboard | the forecast may still be sealed or awaiting its outcome; compare the newest on-time version in `arena_submissions` with the public forecast and the site's generation time |
