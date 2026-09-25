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
| statistician | the series | proposes a distribution from its shape |
| analyst | the question, recent values, the crew's **lessons** for this series | proposes from pollster behaviour and past misses |
| skeptic | the baseline and both proposals | decides how much of their move to trust (0 = stay on the baseline) |

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
moves each Civiqs mean — topline or profile cell — to the freshest daily reading in a snapshot
**fetched before the lock**, keeping the baseline's spread; every other round is the baseline.
Deterministic and leakage-free, so it backtests: on the 58 resolved rounds (2026-09-25) it scores
**+0.143** overall and **+0.266 on Civiqs (20 of 25 rounds beat persistence)**, vs the baseline's
+0.046. Structured sources like this beat web search wherever they exist.

### The research agent (`research:`)

`research:<analyst>[,<analyst>,<analyst>]` — one analyst per vendor — runs the full pipeline
(`src/arena/research/`):

1. **Brief** — a playbook per family (other pollsters' readings *with their previous reading*,
   S&P moves for AAII, prices and inflation prints for consumer surveys, scheduled events for
   attention), bounded to facts after the series' last value, which is stated as already known.
2. **Retrieve** — `MARINA_ARENA_RESEARCH_RETRIEVER` (default `openrouter-web:openai/gpt-6-luna`,
   OpenRouter's web search with URL citations; ~$0.03 per round).
3. **Verify citations** — every dossier line that cites a page has its figures looked up in that
   page (fetched through the SSRF guard) and is tagged `[verified]`, `[unverified]` or
   `[unreachable]`. It caught, live, a researcher reporting a poll "at 39%" whose source said 35%.
4. **Analysts** — forecast from history + the nowcast-adjusted baseline + the tagged dossier, told
   that the benchmark's own history is authoritative for its dates and to use other sources for
   **changes**, never levels (pollsters differ in population and house effect).
5. **Judge** — `MARINA_ARENA_RESEARCH_JUDGE` (default `jev`: jev-1.13 via OpenRouter's Decisions
   API) scores each rationale's quality and grounding in the *verified* lines only; ungrounded ⇒
   no weight.
6. **Aggregate** — judge-weighted mean move × confidence × `MARINA_ARENA_RESEARCH_TRUST` (0.5).

Web research cannot be backtested (a search run later finds the answer), so it is measured in
**shadow**: `bun run arena shadow run due` records what it would file (first record per round,
with the whole dossier and judged proposals), `shadow score` scores resolved ones against
persistence and the baseline, `shadow list` shows the record, `bun run arena research <round>`
runs it once and prints everything. `MARINA_ARENA_SHADOW=<spec>` records hourly from the tick
job — no entrant or key needed.

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

## Operate

| Command | Where | What it does |
|---|---|---|
| `arena` / `arena status` | in-world, rank 0 | entrant, key readiness, autopilot, filed counts |
| `arena rounds [n]` | in-world | open rounds, soonest lock first, with Marina's filing status |
| `arena show <round_id>` | in-world | the question and exactly what Marina would file |
| `arena submissions` | in-world | the signed record of what was filed |
| `arena backtest [n]` | in-world | baseline skill vs the arena's persistence, per family |
| `bun run arena submit <round_id\|due> [--dry-run] [--forecaster …] [--weight w]` | operator CLI | sign and file now |
| `bun run arena evaluate [--forecaster …] [--weight w] [--out FILE]` | operator CLI | score forecasters on resolved rounds; files nothing |
| `bun run arena keygen <path>` / `registration` | operator CLI | key and registration file |

Filing is deliberately an operator act (CLI or env-set autopilot), never an in-world one: it
speaks for the organization in public. The in-world command is read-only so every agent and
person in the world can see the questions, Marina's reasoning and its record.

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
| `MARINA_ARENA_WINDOW_HOURS` | `24` | how close to its lock a round is filed |
| `MARINA_ARENA_URL` / `MARINA_ARENA_AUDIENCE` | production | a rehearsal fork's intake |
| `MARINA_ARENA_DATA_URL` | the arena repo on GitHub | where rounds, locks and resolutions are read |
| `MARINA_ARENA_FORECASTER` | `baseline` | or `nowcast`, `model:<m>`, `crew:<m>[,<m>,<m>]`, `research:<m>[,<m>,<m>]` |
| `MARINA_ARENA_MODEL_WEIGHT` | `0.5` | share of the model's move from the baseline that is kept |
| `MARINA_ARENA_SHADOW` | unset | a forecaster spec to record hourly in shadow (never filed) |
| `MARINA_ARENA_RESEARCH_RETRIEVER` | `openrouter-web:openai/gpt-6-luna` | the research agent's search backend |
| `MARINA_ARENA_RESEARCH_JUDGE` | `jev` (with an OpenRouter key) | `jev` or `none` |
| `MARINA_ARENA_RESEARCH_TRUST` | `0.5` | most of the judged move the research agent takes |

## Beyond the baseline

The baseline is the floor, not the ceiling. The arena rewards consistency: on any single
question 20–50 % of forecasts beat persistence, yet almost nobody does on average. The next step
is a forecasting crew — researchers, respondent simulators and an aggregator that shrinks toward
the baseline unless evidence is grounded — promoted family by family only after it beats the
baseline in shadow mode.
