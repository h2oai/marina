# Changelog

All notable changes to Marina are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Credentials stay out of the event log; operator-only reads and scopes are explicit.** A
  command form that carries a credential (`key add`, `connect auth`, `adapter enable`; declared
  with `CommandDef.sensitiveSubcommands`) is recorded as `<verb> <sub> [redacted]`, and key-shaped
  strings are masked in every other recorded command; stored rows recorded in clear are removed
  when the engine starts. `GET /api/events` no longer serves `command` events, matching the
  dashboard WebSocket. `GET /api/keys`, `/api/principals`, `/api/federation/peers`,
  `/api/operations/alerts` and `/api/models?refresh=1` need operator read capability; the
  dashboard shows an "Operator only" state to other sessions. `/api/command` and `/api/ask` logins
  count against the per-IP login-attempt limit. A supervision credential calls only the routing
  endpoints the supervisor uses (an allowlist). The memory service API (`/v1/memory`) refuses a
  client address that has spent its failed-credential budget, as `/mem` does.
- **Held actions show credential forms redacted.** A challenge hold's summary — in approver
  notices, the ops inbox, operator pushes, the stored hold and the challenge judge's input —
  renders a declared credential form as `<verb> <sub> [redacted]` and masks key-shaped strings. Such
  a held input is never stored: it re-runs on approval in the running process, and after a restart
  the requester is asked to issue it again.

### Changed

- **Page reads honour robots.txt; keyless web sources can be turned off.** Before Marina reads a
  third-party page for an agent or a person (`web fetch`, `web swarm`, `scenario` URL reads, the
  research page reader and citation check, the live Civiqs read), it checks the site's robots.txt
  for its `MarinaResearch` user agent (`src/net/robots.ts`: its own group, else `*`; longest
  Allow/Disallow match, `*` and `$` patterns) and sends that user agent with the read. A disallowed
  page is not requested and the read answers "blocked by robots.txt" instead of failing. robots.txt
  goes through the SSRF guard and is cached per origin for 24 h; a 4xx means no rules; a 5xx, 429
  or timeout fails open and is retried after 10 min. API calls are not page reads.
  `MARINA_ROBOTS_TXT=ignore` turns the check off and `MARINA_ROBOTS_TXT_IGNORE_ORIGINS` exempts
  sites the operator owns. The keyless DuckDuckGo search fallback (`MARINA_SEARCH_DUCKDUCKGO=off`)
  and Yahoo Finance series history (`MARINA_FORECAST_YAHOO=off`) stay on by default and can now
  be turned off: search falls through to the keyed backends and says so, a Yahoo series has no
  prior. `readiness` (check `search`) reports all three. New guide:
  [Data, privacy and terms](docs/guides/data-privacy-and-terms.md).

- **Plainer names for research features.** `intellect`, `reproduce`, `genome`, `marina-descend`,
  `mutation`, `association`, `economy` and `lab` are now listed as experimental in the feature
  status page and their help is labelled `[experimental]`; their guides describe what each records
  in plain terms. Commands, names and protocol ids are unchanged. Docs, agent skill files and
  comments drop metaphors such as "civilization" and "autonomous from birth".

- **Live (real-money) prediction-market orders ask a person.** A new operator-grant safety gate,
  `trading.live`, guards every `position open`, `position confirm` and `position close` that would
  reach a live venue (`MARINA_TRADING_ENABLED=true` plus credentials). Without an operator grant the
  order is held as a challenge — nothing is sent and the command returns at once — and a person's
  `challenge approve <token> once` places that one order (a `confirm` is one hold for the whole
  proposal); `always` is an operator grant. Agents never approve. The gate is in the open-posture
  core, never in `RANK_GATES`, and, unlike the other gates, is not lifted by the `local` profile:
  only `gate grant <name> trading.live` or `MARINA_AUTONOMY=sovereign` passes live orders without a
  per-order approval. Paper trading is unchanged. There are now 15 safety gates. `position`,
  `bankroll`, the markets guide and `MARINA_TRADING_ENABLED` carry a plain not-financial-advice
  note.

- **A new front door.** The README, landing page and docs overview are rewritten to be shorter
  and plainer, with the forecasting, research, orchestration and coding commands every participant
  gets up front. The docs sidebar and guides index are regrouped by what a reader wants to do, and
  the site uses the H2O black-and-gold theme with the Marina mermaid.

- **Cheap by default, strong where it grades: model tiers.** Work that names no model now runs on
  one of two tiers (`src/config/model-tiers.ts`). The cheap tier (`MARINA_MODEL_TIER_CHEAP`) runs
  agents spawned without a model, room agents, boot-seeded crews (the Workbench, answerer and
  orchestration crews, the Chronicler) and memory helpers. Unset, it is the operator's explicit
  default model when one is set, else the cheapest adequate tool-capable model for the keys present
  (`openrouter/deepseek/deepseek-v4.1-flash` with an OpenRouter key). The strong tier
  (`MARINA_MODEL_TIER_STRONG`) runs the benchmark judge, the outcome extractor, the lesson writer
  and judge, the decision classifier and the Arbiter. Unset, it is `marina/default` exactly as
  before, so judging does not get cheaper silently. `marina/cheap` and `marina/strong` are live `/v1`
  model ids, resolved per request. One entry moves a single role:
  `MARINA_AGENT_MODELS=role:<role>=<model>`. `admin models` shows the effective model for each tier
  and role and where it came from, and the boot log prints both tiers.
  **On upgrade**, with no model variable set, residents, room agents, seeded crews and memory
  helpers move from `marina/default` to the cheap tier. The Workbench moves from each provider's
  flagship (Opus, GPT-6.1 Sol, Gemini Pro) to the cheap tier. `MARINA_DEFAULT_OPENROUTER_MODEL`
  and the other per-provider defaults now shape only `marina/default` and the strong tier.
  Unchanged: judges, decisions and the Arbiter; the `/v1` `marina` model; agents saved with an
  explicit model; and anything covered by an explicit `MARINA_DEFAULT_MODEL`, runtime default,
  `MARINA_CREW_MODEL`, `MARINA_WORKBENCH_MODEL` or role variable. `MARINA_CREW_MODEL` now also
  reaches the answerer and orchestration crews and the Chronicler in every world.

- **Contributors earn standing: every account is its own party.** Work another account verified
  now credits the worker, including a person approving its own agent's task, adopting its
  agent's proposal or replicating its agent's experiment, and a sibling agent reviewing a Code
  Mode attempt whose checks passed. Verifying your own work (same name or same durable account)
  still earns nothing, and an agent's verdict inside its own spawn lineage still needs grounding.
  Caps are unchanged. Safety gates are unchanged: only a person's approval from outside the
  requester's lineage builds an earnable gate. Each world records the change once as a chronicle
  event (`civic-rule:contributors-earn-standing`).

### Fixed

- **Documentation matches the code.** The README and site say approvals apply on shared and public
  instances; the privacy guide lists the keyless market and economic-data lookups and the markets
  feed; gate, operator-grant and built-in skill lists are current; seeded agents' autostart, the
  Docker ports and the MCP tool list (now a pointer to the generated reference) are corrected. The
  docs contract checks stated registry counts and requires commands to be documented as commands.

- **Room entry checks apply to every movement command and fail closed.** `move` and `goto` (to a
  room or to an entity) share one entry check: private rooms, then the room's `canEnter` guard,
  which everyone obeys. A guard that throws, overruns its time limit, or belongs to a room the
  sandbox disabled refuses entry. A room command that throws is recorded as a failed command (no
  quest progress, failed usage, no `command` event), as a rejected async one already was. Room
  and command source validation refuses static imports and re-exports; only `import type` is
  allowed. The demos world no longer seeds a gate grant for its Maker agent (its compile steps are
  held for an operator), and its Workshop and Bridge demos report completion only after checking
  the outcome.

- **Paired benchmark arms compare like with like.** The BrowseComp transfer adapter scores an incomplete
  run's missing items 0 instead of dropping them, so an arm that times out more is no longer
  flattered. `MARINA_GROUND_CACHE=<file.json>` lets short-answer arms run with `--ground search`
  share one grounding-evidence cache, so paired arms read byte-identical evidence.

- **Supervised residents: logging in again no longer cuts the supervisor off.** With
  `MARINA_SUPERVISED_RESIDENTS=on`, the supervisor exchanges the person's world session for its own
  routing-only supervision credential (`POST /api/routing/supervision`, at most 24 hours, renewed at
  80 %, revoked on stop). A later `marina connect <same name>` replaces only the world session; the
  supervisor keeps running and can still renew and revoke its residents. The credential is accepted
  only under `/api/routing/`, is never a world session or an approver, and cannot send controls,
  messages or channel posts. Off, nothing changes.

- **`position` cap counts a market order at its worst case.** A market order (no limit price) was
  costed at an estimated 50¢ a contract for the bankroll-cap check, so its exposure could reach
  about twice the cap. The cap now costs it at 99¢ in paper and live alike (the paper fill is still
  recorded at the estimate); add a limit price to size against it. The markets guide now describes
  the daily-loss floor as it is enforced — world-wide realized losses since UTC midnight against the
  opener's own floor, refusing new opens — instead of calling it advisory.

- **Messages carry a causal envelope, and the canvas sees speech.** `say`, `tell` and `re` emit
  content-free `say_sent` / `tell_sent` events (names, a message ref, `cause`, `depth`; never the
  words), so the canvas draws say and tell arcs again. Every say, tell, re, shout and channel post
  records `cause` (the message it answers: `re` names the tell it replies to) and `depth`, stored on
  direct and channel messages (migration 171) and carried on their perceptions. `channel_message`
  events carry the stored message id instead of `0`, so each post has its own feed ref.

- **Yes/no forecasts lost their group class tag.** `group:binary:no|yes` failed the routing-ref
  character check (`|`), so every yes/no outcome reached card routing and the competence map
  without its coarsest class. Card evidence also no longer counts an answer twice when both its
  outcome and its history record are on file.

- **Built features that stayed inert now run, expire or report.**
  - **Dead memory-assistance jobs expire.** An hourly pass (`src/engine/assistance-expiry.ts`)
    sets a new terminal state `expired` when a job's deadline has passed, or when the worker's
    world account has no running agent or live connection (15 min grace, never during a live
    lease). It writes one `assistance.expired.<reason>` memory event per job and deletes nothing.
    `ops assistance [expire|restore <job>]` reports, runs the pass or reopens a job, and
    `ops recover` includes the pass. The memory overview counts `expired24h`.
  - **Unanswered challenges reach the operator.** Expiries keep one rolling
    `challenge:unanswered` ops-inbox item open until an operator resolves it.
    `challenge summary [days]` reports outcomes by class and requester.
    `MARINA_OPS_NOTIFY` (default off; webhook URL or `cmd:<program>`) pushes content-free notices
    when a hold opens and when holds go unanswered. The dashboard attention drawer's desktop
    notification also fires for held actions.
  - **Retired standing kinds no longer count.** Rows of kinds that can no longer be earned (such as
    `chronicled` and `pool_note`) stay as history (shown separately by `standing`) but count toward
    no standing, rank or decision by default (`MARINA_STANDING_RETIRED=exclude`; `decay` restores
    the old fade-out). Every live kind is covered by a test.
  - **Agents are no longer made sovereign at login.** Under the `local` profile a loopback MCP,
    declared-agent or agent-account login was promoted to rank 9 with every safety gate at the
    999 grant sentinel. Now only a loopback person is. Existing databases are not reset on boot:
    `gate audit` lists grant rows by holder, and `gate reset <entity|agents> [gate|all]` is a dry
    run until `apply` (operator only). It revokes sentinel rows only and chronicles each holder.
  - **Fewer `memory` round trips and receipts.** `DurableResidentMemory` checkpoint-only saves
    reuse the remembered checkpoint instead of re-reading it (the CAS still guards it; archive and
    journal writes still read fresh). Saves that only change `timestamp` are skipped. Preference
    reads back off from every 50 to every 400 cycles while unchanged. The retention pass prunes
    continuity-journal receipts in `memory_requests` after 7 days; every other receipt is kept.
  - **FutureX can answer late on an opt-in schedule.** `watch --answer late` answers each open row
    once, within `--final-lead-hours` of its own cutoff. `bun run futurex schedule` prints (or
    writes with `--out`) a systemd user service and hourly timer that answer late by default, with
    their own capped spend scope. It installs, enables and starts nothing.

### Added

- **Test the right versions: results record their commit, and the transfer report refuses mixed
  code.** Benchmark results now name the Marina code that produced them:
  `marina: {commit, dirty, describe}` read from git at run time, on harness results (short-answer,
  FRAMES and the rest), BrowseComp-Plus query files and results, FutureX `score.json`,
  ForecastBench/Metaculus `selection.json` and `arena evaluate --out` reports. Filed and backtest
  ledger runs keep it in `config_json.marina` (no migration; it stays out of the config and
  content hashes, so re-filing is still a no-op). `eval:transfer` shows each arm's commits per
  suite, and the inventory shows each variant's commits. By default every source of both arms of
  a suite must come from one clean commit. Mixed commits make the suite `version-mismatch`;
  unstamped or dirty sources make it `version-unknown`. Either is reported but never counted
  toward the two-group verdict, as an improvement or as a regression. A commit behind
  `origin/main` is a warning (local git only). To compare releases on purpose, a spec declares
  `versions: {baseline, candidate}` (sha or tag) and each arm must match its own. To count
  results written before stamping, pass `--allow-unversioned`; the report then carries a warning
  banner. **On upgrade**, existing result files have no stamp, so a spec over them reports
  `version-unknown` until they are rerun or `--allow-unversioned` is given.
- **Private rooms, opt-in.** Every room stays public unless its owner (whoever built it, or an
  operator) runs `build access <room> private`; entering then needs an invite (`build invite
  <room> <name>`, `build uninvite`). A person's agents share its invite. `move`/exits, `goto` (to a
  room or to someone inside) and a supervised resident's launch room are refused uninvited;
  operators may enter. Whoever is inside when a room turns private stays, and `build access
  <room>` lists them. The start room stays public; `say` already reaches only those present, and
  tells, channels and groups are unaffected. Migration 176 (`room_access`, exported with the world).

- **Formations in a room.** A room can run a turn rule — `debate`, `chorus` or `verification` —
  set with `build formation [room] <formation>|off` or `formation` on a room module (templates
  carry it; the in-world setting survives a restart). After each `say`, one `[formation-mediator]`
  line in the room names the next actor with `@name`, so attention wakes them and owes the answer;
  a round ends on its own closing move. Lines appear in `look log`; each emits a content-free
  `room_formation_turn` event. Rooms without a formation are unchanged.
- **World awareness.** `look log [since:<duration>]` reads your room's recent history (speech, emotes,
  arrivals, departures; bounded per room, migration 175). `who` and `look` show every agent's status
  (working, idle, blocked, needs you, resting, offline), and `who watch <name> [idle|blocked|any]
  [once]` sends one notice per change. `@name`, `@a,b` and `@all` expand to `agent attention` before
  dispatch (`agent attention` now takes a comma list or `all`); `@@` escapes to `say`. Supervised
  residents' digests fold arrivals, departures and server notices.

- **Peer code review with authority.** `code review request <name|auto> [-- claims]` snapshots the
  author's changes (a coding-session diff, or the worktree diff a supervised resident's supervisor
  captures) and asks a reviewer through an ordinary `tell`; `auto` prefers a different vendor,
  then a different model. Only the reviewer answers with `code review verdict <id> approve|rework
  [-- findings]`; rework reopens the work for the next round. The author can neither give a verdict
  nor close the review: a person closes it with `code review approve|reject <id>`, and a decision
  against the reviewer's verdict is recorded as an override. Standing follows the verified-code
  rule. Events `review_requested`, `review_verdict` and `review_closed` are content-free.

- **Earned loops get more evidence.**
  - **Forecast shadow challengers** (`src/forecast/shadow.ts`, `MARINA_FORECAST_SHADOW=off|<fraction>`,
    default off; `_MAX_PER_DAY` 10, `_CAP_USD` $2 per UTC day). On a sampled share of filed live
    forecasts, one challenger card from the answer's routing `explore` order runs in the background
    on the same request, deps and cutoff. It is filed `eval_mode = live` under `marina:shadow`,
    tagged `shadow`, `method:`, `card:`, `model:`, `family:` and `q:`/`pair:`, and settles with the
    live answer through `resolveForecast`, so it teaches lessons; it never writes history, so prior
    shrink and recalibration get no correlated second record per question. These are the paired
    questions card routing (min 30) was missing. Live FutureX `earned` runs get shadows too: started
    when a row's standing answer is adopted, superseded on revision, settled by `futurex learn`. The live answer never
    changes; a past cutoff gets backtest isolation; no standing is earned.
  - **Arena routing reads the shared outcome rows** (`src/arena/earned-routes.ts`,
    `MARINA_ARENA_ROUTE_OUTCOMES`, default on). Outcomes tagged `family:`, `method:` and `arena:<round>`
    count as paired evidence on the arena's own skill scale. Our own settled filings and anything the
    arena tables already hold are never counted twice, so existing routes are unchanged.
  - **`forecast routes [family]`** (read-only): per family and card or route, the paired n, win rate,
    gain and whether the route is earned, across forecast and arena evidence.
  - **Prophet write-back** (`benchmarks/prophet/writeback.ts`). The agent journals each
    `/v1/forecast` answer; `file` files them under `marina:prophet` (source `prophet-arena`, `live`
    or `measure`), and `resolve` scores resolved events through `resolveFiled`, so Prophet answers
    record outcomes that teach lessons and write history.
- **Residents can use the forecast, quant, data, research and decision tools.**
  - **Typed analysis tools.** Ten deferred agent tools, named in TOOL ROUTING and loaded through
    `marina_tool_search`: `marina_forecast` (typed answers, optional `formation` and `retriever`),
    `marina_research` (`research ask`), `marina_swarm` (`web swarm`), `marina_quant`, `marina_calc`,
    `marina_data` (markets, odds, series, polls, crowd), `marina_decision_check`, `marina_triage`,
    `marina_arbiter` and `marina_pattern`. Each builds one world command
    (`src/agent/analysis-commands.ts`, shared with the tool policy), so rank, gates, rate limits,
    spend caps and audit apply as typed. `crew` / `minimal` profiles are unchanged.
  - **`research ask`.** `research ask [mode:agent|retrieve|evidence-loop|survey|authority]
    [retriever:<spec>] -- <question>` runs the web-research agent with its citation audit, or one
    retriever pass in a research mode (`src/research/ask.ts`). Rank 0, per-run budget (default $1,
    at most $3), the daily cap, one run per entity. A resident may pick only retriever entries that
    name no model, or one the operator configured.
  - **`forecast formation:` / `retriever:`.** A caller-chosen formation (`formationEnv`) and a
    resident-allowed retriever, validated before any budget is spent.
  - **`pattern run`.** `pattern run <pattern> [budget:<usd>] -- <task>` (rank 0, `[experimental]`)
    runs `runTextPattern` in world over the operator's models: per-run budget (default $0.50, at
    most $2), the daily cap, one run per entity. `POST /v1/patterns/run` stays.
  - **`data polls` / `data crowd`.** VoteHub polls (approval, generic ballot) and Manifold crowd
    probabilities, with `asof:`; both are `egress` reads like the other lookups.
  - **Skills in the prompt.** The three remaining seed skills (`decompose-multihop`, `solve-math`,
    `answer-request`) ship built in. `skill top <query> [bytes:<n>]` returns the one best skill (the
    agent's own first, else a built-in the skill search judges relevant). Residents get it as a
    `[Skill]` section every tenth cycle, at most 700 bytes (`MARINA_SKILLS_RESIDENT=on|observe|off`,
    default on).
  - **Domain-filtered lessons.** `lessons <topic> for:<work>` (at most 4 lessons, 900 bytes;
    `for:forecast` is exactly what a forecast recalls via `forecastLessonsFor`). A resident's
    `[Lessons]` section uses it when its focus or recent tools show forecasting or research work
    (`MARINA_LESSONS_RESIDENT_DOMAIN=off` keeps the lexical all-domain recall).

- **Forecasts answered by residents, bounded by an as-of fence** (opt-in,
  `MARINA_FORECAST_RESIDENTS=on`; off, every path is byte-identical).
  - **The as-of fence** (`src/engine/evidence-fence.ts`). An evidence cutoff now binds a resident's
    whole turn, not one call. It rides the per-execution command scope (`runCommandScope`), is set
    for the responder of a `model_request` routed with a cutoff (`x-marina-asof` over HTTP; the
    envelope's `asof`), and is relayed to every agent a fenced resident reaches. While it holds,
    `web search` uses only date-strict providers at the cutoff, `web fetch` returns the archived
    page, `data` reads as of the cutoff, `recall`/`context`/`lessons` serve only what was known by
    then, and every other outbound or knowledge-reading command — a nested `forecast` included,
    and any command or room command the policy table does not name — is refused with a message
    naming the cutoff. `currentEvidenceCutoff()` is the one read for tools.
  - **`ResidentPart`** (`src/forecast/resident-part.ts`): a forecast part answered by a resident —
    `marina:<crew>` through `routeToChannel`, `role:<r>` by standing — in-process inside the
    server, over HTTP with the fence and deadline headers outside it. Each call passes the
    forecast's remaining deadline and trace, runs under the forecast's call budget and spend
    scope, and records who answered; `/v1` replies now name the answering resident
    (`x-marina-respondent`).
  - **A forecast as a task, run as a Score** (`src/forecast/resident-forecast.ts`):
    `forecast <q> crew:<c>|role:<r> pattern:ensemble|delphi [residents:N] [asof:] [measure:yes]`
    and the same fields on `POST /v1/forecast` create a world task and run the formation through
    the Score executor — research first, K resident steps (Delphi: a summary and K revisions),
    then the pipeline's own pure-code combination. Each resident's run is filed as its own answer
    tagged `q:`, `method:`, `model:` and `resident:`, so resolution credits the residents whose
    runs scored. Bounds: `MARINA_FORECAST_RESIDENT_CALLS`, `_TIMEOUT_S`, `_BUDGET_USD`.

- **An honest feature surface** ([docs/reference/feature-status.md](docs/reference/feature-status.md)).
  Every major feature now has one status: core, siloed, experimental, demo or deprecated. The page
  also says how to enable each feature and which area owns it. The table mirrors `FEATURE_STATUS`
  (`src/config/feature-status.ts`), and the documentation contract test keeps the two in step. It
  is linked from the guides index and the README.
  - World commands that only serve an experimental feature now start their help with
    `[experimental]`: `inquiry`, `schedule`, `evolve`, `experiment`, `market`, `position`,
    `gateway`, `mesh` and `learned`. Behaviour is unchanged, and they keep the same rank, gates and
    spend caps.
  - `marina worlds` marks the 13 demo worlds `[demo]` and adds `"status"` to `--json`.
    `BUILTIN_WORLD_STATUS` lists `default` and `empty` as core.
  - The following are now labelled experimental in code and in the environment reference:
    - the embedding lifecycle (`MARINA_DATA_DIR` endpoint file, `MARINA_IDLE_SHUTDOWN`,
      `MARINA_PARENT_PID`, `marina endpoint`), labelled "for embedding hosts" and kept;
    - the shared spend ledger (`MARINA_SPEND_LEDGER`);
    - adaptive load balancing (`X-Load-Balance: adaptive`);
    - `POST /v1/patterns/run`, kept for a planned `pattern run` command;
    - native evolution protocols.
  - The 16 orchestration templates are labelled demo.
- **H2O-Lightning decision preset (experimental, off by default).**
  - `MARINA_DECISIONS=lightning` (alias `h2o-lightning`, also settable at runtime with
    `admin decisions set backend lightning`) asks H2O-Lightning through OpenRouter's Decisions API.
  - No model id ships, so the preset stays off until `MARINA_LIGHTNING_MODEL` names its OpenRouter
    id. A leftover `MARINA_DECISION_MODEL` is never used for it.
  - `decision settings` / `admin decisions` print an `H2O-Lightning:` line: not configured,
    configured without a key, available, or active. The line is read from configuration only and
    never makes a billed call.
  - This replaces a comment-only mention in `src/decisions/config.ts`.

- **The Arbiter: adjudication only where answers disagree** (`src/orchestration/arbiter.ts`, all
  surfaces default `off`). Always-on same-model verification overruled correct answers too easily;
  the Arbiter is consulted only where answers disagree.
  - Contested items are found from free signals: run agreement by answer type, verifier or critic
    dissent, and judge spread. Only contested items reach the Arbiter, under a cap
    (`MARINA_ARBITER_CAP`).
  - The Arbiter keeps, overrules or abstains, with citations for every answer item and separate
    source-quality and reasoning-quality scores. Overruling a majority needs grounded citations from
    two independent registrable domains and confidence of at least 0.7 (`MARINA_ARBITER_*`);
    anything less keeps the majority.
  - Each overrule is scored when its question resolves (`ResolvedRecord.arbiter` in the forecast
    history). The right to act can be gated on that earned record (`MARINA_ARBITER_UNEARNED=observe`).
  - Wired into typed forecasts (`MARINA_FORECAST_ARBITER=off|observe|on|replace`, formation
    `arbiter`). Under `on`, verifier corrections and critic revisions only advise; `replace` drops
    the per-run verifier.
  - Wired into `marina/verify:` (`MARINA_VERIFY_ARBITER`, `x-marina-arbiter` header,
    `browsecomp-plus run --arbiter`). A checker's flag on a final answer is adjudicated instead of
    freely revised; tool-call drafts are unchanged.
  - In the world: the seeded `arbiter` role and `adjudication` trait, and a read-only
    `arbiter contested|check|policy` command.
  - The replay: `benchmarks/transfer/arbiter-replay.ts`, with no model calls.
  - `off` is byte-identical, prompts included. See docs/architecture/orchestration.md.
- **Intake triage** (`MARINA_FORECAST_TRIAGE=off|observe|on`, default `off`): before any method
  runs, a question or task is classified as `lookup` (already published at the cutoff — read it),
  `anchor` (a numeric official series not yet out — project the latest reading), `list` (a ranking
  or board — rebuild, project, sort) or `forecast` (open — the full panel). Code derives the class
  from facts and the clock, never a model: the stated resolution time, an official series that
  already holds the period (FRED as published the day before the cutoff), a stated release date,
  a dated event, the fact model's expected publication date, or a known statistic's usual lag. A
  figure published after the cutoff is never a lookup. An optional cheap fact model
  (`MARINA_FORECAST_TRIAGE_MODEL`, default `openrouter/deepseek/deepseek-v4.1-flash`, `none` for
  fully deterministic) adds publisher, metric, period and expected publication date, and
  `MARINA_FORECAST_TRIAGE_CALENDAR` reads the FRED release calendar. `observe` records the class,
  facts and chosen method on the answer (`triage`) and changes nothing; `on` sends a lookup to an
  authority read-off (one research round restricted to the publisher, the field read from
  verified evidence and checked mechanically) and falls back to the full panel when the field is
  not found, turns the quant stage on for an anchor, and gives a list the ranking method. `off`
  leaves prompts, briefs and answers byte-identical. In-world agents get a rank-0 `triage
  <question>` command (deterministic, no model call), a built-in `intake-triage` skill, and an
  `intake-triage` trait on the `researcher` and `market-oracle` roles. `bun run eval:triage`
  reports the class mix and per-class scores over stored results offline, at no cost.
- **Research authority mode** (`MARINA_RESEARCH_AUTHORITY=on`, default off): research can find and
  read the publisher a question resolves against. A brief's settlement pages are authority targets
  from the first round, and the evidence loop's gap reviewer may name one (domain, page URL, field)
  as a validated part of its reply. The `search` retriever adds one domain-restricted query per
  target (Tavily `include_domains`, Exa `includeDomains`, `site:` elsewhere); a named page is read
  first only for a live cutoff, never in a date-strict backtest; the read swarm asks for the
  field's exact value with its as-of date and reads the publisher first; and `verifyDossier` tags
  lines citing only the publisher's sources `[authoritative]`. Off leaves prompts, briefs, dossiers
  and forecast-settings fingerprints unchanged. See docs/guides/search.md.
- **Quant stage for typed forecasts** (`MARINA_FORECAST_QUANT=off|observe|on`, default `off`).
  When a lookup reads an official series with history, `fitSeries` projects it to the question's
  end time. When every option of a choice is a numeric range ("Below 2.5%", "2.5% to 2.9%",
  "3.0% or higher", counts), `bucketProbabilities` gives each option's probability from that
  projection or from a supplied numeric prior. `observe` records all of this on the answer
  (`quant`) and changes nothing a model sees. `on` shows it to the runs (as a reference class)
  and to the judge, and blends the buckets into a choice's probabilities
  (`MARINA_FORECAST_QUANT_WEIGHT`, default 0.25). `off` leaves answers and prompts byte-identical.
- **Built-in skills**: `skill builtin [name]` shows skills shipped with the server, and
  `skill search` finds them, with no import and no seeding. The first is `quantitative-estimates`.
  A new `quantitative-estimates` trait on the `researcher` and `market-oracle` roles points to it.
- **Quantitative helpers for every agent**: a new rank-0 `quant` command next to `calc`, with no
  model call and no code sandbox. `quant fit <values> steps:N|to:<date>` fits a plain or dated
  series and returns a mean, an sd and quantiles. The methods are persistence, EWMA, a
  persistence/EWMA blend, a linear trend, a damped trend and a combination, and `auto` chooses
  among them by their own rolling-origin errors. `quant buckets mean:<m> sd:<s> | q:<level>=<value>,… -- <ranges>`
  gives each numeric range's probability and the most likely range, including open-ended ranges,
  sd 0 and tied quantiles. The shared code lives in `src/quant/` (`fitSeries`,
  `bucketProbabilities`, normal primitives). The arena's scalar baseline and poll-level rule now
  call it, and a regression test checks bit-identical output against the earlier code. A new
  `quantitative-estimates` skill (`seeds/skills/quantitative-estimates.md`) teaches `calc` for
  units, percent change and growth, and `quant` for series and ranges.
- **Forecast answer contract** (`src/forecast/answer-contract.ts`, `MARINA_FORECAST_CONTRACT`,
  default `off`): a question's own answer-form instructions — single choice, multi-select with
  pick bounds, a number with unit / integer / decimals, a date in a stated format, a ranked list of
  a size, free text with a word limit, an optional `\boxed{…}` wrapper and the format line
  verbatim — become a structured contract over the typed spec. `observe` records whether the final
  answer meets it and changes nothing; `on` carries it to the planner, runs, verifier, critic,
  formations and judge, then a final validator normalises losslessly, re-asks once on a real
  violation and falls back deterministically, keeping `contract` (status, the pipeline's answer,
  the rendered form) on the answer. FutureX's adapter can now keep the row prompt's
  `IMPORTANT: End with …` line (`--format-line keep`, variant `formatLine`); the default still
  strips it, so its effect can be measured.
- **Manifold lookup** (opt-in `manifold` in `MARINA_FORECAST_LOOKUPS` /
  `MARINA_ARENA_RESEARCH_LOOKUPS`; never part of `auto`, `all` or `markets`): Manifold Markets'
  keyless API — probability, volume and close date live; for a past cutoff, the probability after
  the last trade at or before it from the bet history and the mana traded up to it, and nothing
  when the history is missing. Yes/no prices feed the market prior like Polymarket's. Good
  Judgment Open is not added (no public API; its terms forbid automated collection); new crowd
  sources register in `OPT_IN_LOOKUPS`.
- **Market prior across venues**: when several venues (for example Polymarket and Manifold) each
  matched exactly one market on the same question, the yes/no market-lookup prior now pools them —
  a log-odds mean, weighted by log(1 + volume) when every venue reports volume in the same unit,
  with the venues' spread (and disagreement) in its `detail` — instead of rejecting itself. Several
  markets on one venue stay ambiguous, and a single venue's prior is unchanged.
- **`contract` on `POST /v1/forecast`**: an optional explicit answer contract beside `answer`,
  validated against the typed spec (400 when invalid) and enforced unless
  `MARINA_FORECAST_CONTRACT=observe`.
- **Transfer report** (`bun run eval:transfer --spec <file>`, `benchmarks/transfer/`): enforces
  the rule that a capability counts only when it improves on at least two independent evaluations,
  not just the one it was built for. Takes a baseline and a candidate env overlay and a list of
  suites; ingests existing per-item results (generic `items` JSON/JSONL, harness results, FutureX
  clean backtests, `arena evaluate` and `arena shadow paired-score` reports) or, only with `--run`,
  runs each suite's command per arm and replicate. Per suite: a seeded paired bootstrap of the
  mean delta and an exact sign test on held-out items (the promotion hash split by default, or a
  time split); verdict `transfers` only with significant gains in ≥ 2 independent groups and no
  significant regression. Writes a markdown and a JSON report; no benchmark logic in the core.
  A `ledger` adapter reads per-item rows from any benchmark ledger DB without writing to it
  (in-world `benchmark run`/`compare-run`, imported runs, ForecastBench/Metaculus selection runs;
  runs selected by label, id, replicate group or date range); the `items` reader splits one file
  into arms by `variant` and runs by `replicate` and remaps other record formats (τ²,
  BrowseComp-Plus, LongMemEval and paired-run presets); `--bootstrap two-stage` resamples
  replicate runs then items as forecasting selection does; and `--inventory [root…]` finds every
  per-item result and ledger on disk and lists the baseline/candidate pairs each suite offers.
- **Attention extraction for the Wikipedia specialist** (`src/arena/extraction/`,
  `MARINA_ARENA_WIKI_EXTRACTORS=events,news,related,edits,gdelt`, off by default — unchanged
  behaviour when unset; `wiki-specialist+extract:<list>` for a shadow arm): narrow extractors run
  in parallel on the specialist's top candidates and emit typed, dated records (feature, value,
  as-of, source, confidence) — MediaWiki revision activity and lead-link neighbourhood growth read
  at the revision in force at the cutoff (`rvstart`/`rvend`), Portal:Current events mentions and
  (with a model) direction, GDELT volume, and scheduled/ended events from as-of article sentences
  that one cheap model call classifies and a mechanical check verifies. Records past the cutoff
  are dropped; the specialist applies them only through bounded, testable multipliers with
  transient-share widening, and keeps every record in the forecast detail. Only the events
  channel's multipliers are active by default; the other channels' multipliers default to
  neutral. `scripts/arena-wiki-extract.ts` replays the extractors over reconstructed weeks
  (cached; Wikimedia `Retry-After` honoured).
- **Per-item Wikipedia backtest output**: `scripts/arena-wiki-backtest.ts --out <file>` writes
  `{id, score, at, variant, group: "arena-wikipedia", exclude?}` JSONL with diagnostics (loss,
  persistence loss, hits, unseen entrants, ranking) for the transfer report's `items` adapter;
  `--features <label>=<file>` adds extractor variants (fixed and walk-forward). Default text output
  is unchanged.

- **Search engines for research retrieval**: `openrouter-web:<model>@<engine>[:<mode>]` accepts
  every OpenRouter web plugin engine — `native`, `exa` (instant … deep-reasoning), `parallel`
  (turbo … advanced), `perplexity`, `firecrawl` — validates engine and mode, and adds the engine's
  list price to each call's recorded cost (`@exa` / `@native` unchanged). A new `deepseek` search
  backend (DeepSeek's Search API, `DEEPSEEK_API_KEY`, $0.75 per 1,000 non-empty searches) joins
  the `search:` chain and `web search` as a paid fallback after DuckDuckGo, with the brief's window
  as `after:`/`before:` operators and bounded HTTP 429 retries; `readiness` lists both.
- **Arena signals everywhere**: `MARINA_ARENA_RESEARCH_SIGNALS=all` gives every arena family its
  mapped outside signals (`src/arena/research/signal-map.ts`): FRED economy, inflation and market
  series (vintage as of the lock), a family market phrase for Polymarket/Kalshi, and other
  pollsters' approval / generic-ballot polls from VoteHub's keyless API (new `votehub` lookup,
  target's own pollster excluded, cut at the listing day). Unset `MARINA_ARENA_RESEARCH_LOOKUPS`
  then means `polymarket,kalshi,fred,votehub`. FRED lists longer than three series run in chunks.
  Market and poll lines are frozen under payload URLs so the citation check verifies what was read
  at the lock. `off` and `consumer` are unchanged.

- **Arena profile rounds at parity with scalar rounds**: on Google Trends baskets, YouGov
  crosstabs and Civiqs profiles the proposal judge now runs per cell (one batched call per member,
  support per cell, trust only drops, fails open); the learned move weight fits one weight on
  every cell's move by energy-score skill (placebo and minimum history as for scalars, pooled
  across profile families of a method when a key has few rounds); each cell's sd is floored at the
  narrowest proposal and the members' linear pool; and a share basket's rescale to 100 now scales
  the sds with the means. Formations record `formationStartProfile`.
- **Arena research fallback**: with `MARINA_ARENA_RESEARCH_REQUIRED=on`, research that fails no
  longer skips the round; `MARINA_ARENA_RESEARCH_FALLBACK=closed-book|start|skip` (default
  `closed-book`) files the same formation closed-book, else the start forecast, recorded as
  `forecast.researchFallback` and keyed as a closed-book filing by the calibrators.
- **Arena Wikipedia specialist** (`wiki-specialist[:<model>[,…][@<retrievers>]]`): the
  `wiki-top10` ranking forecast from each candidate's projected target-week pageviews (a base level
  plus an exponentially decaying excess with a page-specific half-life, weekday-corrected, ordered
  by projected weekly sum with a discount on the transient share), read from the arena's daily top
  lists and, for missing days, the Wikimedia REST API (rate-limited, cached, guarded, never after
  the lock day − 2). Optional event models pool mechanically verified scheduled events into it,
  capped by `MARINA_ARENA_WIKI_EVENTS_MAX_INSERT`. `scripts/arena-wiki-backtest.ts` replays it
  walk-forward over reconstructed weeks. Runs as a route (`wikipedia=wiki-specialist`) or a
  shadow challenger.

- **Installable SDK**: `bun run pack:sdk` builds `@marina/agent-sdk` as a tarball you install with
  `bun add`, `npm install` or `pnpm add`. The docs import it by package name (#498).
- **Command effects**: every builtin command form declares `read`, `write`, `execute` or `delete`.
  The command reference shows it, MCP tools for read forms carry `readOnlyHint`, and new commands
  must declare one (#502).
- **Arena proposal judge**: delphi and symbiosis formations with a verified research dossier ask a
  decision model (Jev by default) whether each member's move from the start is supported by the
  verified lines; support weights the median move and can only lower the trust, any judge failure
  files the unjudged forecast, and `forecast.judge` records per-member support and the effect.
  `MARINA_ARENA_PROPOSAL_JUDGE=on|observe|off` (default `on`), `MARINA_ARENA_PROPOSAL_JUDGE_MODEL`
  (default `typesafe/jev-1.13`; any Decisions-API model id, or `decisions`).
- **Embeddable Marina**: `MARINA_DATA_DIR` keeps every write in one directory; `MARINA_SINGLE_PORT`
  serves `/mcp` on the HTTP port; `endpoint.json` lets a host find a running instance;
  `MARINA_IDLE_SHUTDOWN` and `MARINA_PARENT_PID` end it when unused or orphaned;
  `MARINA_SPEND_LEDGER` shares one daily cap across instances; `marina worlds`, `endpoint`,
  `mcp-stdio`, `acp` and `memory-mcp` subcommands. See docs/guides/embedding.md.

- **Private predictions and research**: `marina predict` / `marina research`, the `/predict` and
  `/research` dashboard pages and chat cards, the `inquiry` command, and an SDK client keep each
  question as a durable private case with its answer, sources and captured work, reopenable from
  web or terminal; migration 170 adds the investigation tables (#480).
- **Audio**: `audio transcribe`, `audio transcript` and `audio speak`, the `marina_transcribe` /
  `marina_speak` agent tools, and `POST /v1/audio/transcriptions` / `POST /v1/audio/speech`, with
  OpenAI or any OpenAI-compatible local audio server; long audio is chunked (#479).
- **Memory over media**: an asset's caption, alt text, tags, prompt, PDF text and transcript
  become private memory records for its owner citing `asset:<id>`; `MARINA_MEDIA_MEMORY=off|text|vision`
  (default `text`) (#478).
- **Asset library**: assets record origin, hash (same-owner uploads deduplicate), dimensions,
  provenance, tags, lineage and thumbnails; an `asset` command and a library query (#473).
- **Dashboard media**: one media viewer for images, video, audio and PDFs, an Asset Library panel,
  and upload from anywhere (#474); media cards in WebChat persist across reloads (#476).
- **Native vision**: agents whose model reads images see them directly (`MARINA_AGENT_VISION`,
  default `auto`); image and video generation is offered by configured provider; inbound images on
  `/v1/messages` and the Ollama routes are translated instead of dropped (#472).
- **Image decisions**: harness decisions accept images in their state and a `box` question type
  (#471).
- **Image preparation**: images are probed, rotated, resized and re-encoded to a model's limits,
  with `sharp` as an optional dependency (#470).
- **Vision benchmark**: `benchmarks/vision-native --set hard` compares native and described vision
  with paired statistics; opt-in (#475).

### Changed

- **Resident context budget: two prompt tiers, a deduplicated prompt and on-demand tools.**
  The fixed prefix every resident sends on every turn is smaller, and small-window models get a
  budget of their own.
  - **Two tiers**, picked from the agent model's context window. `lean` (≤ 32k tokens) caps the
    system prompt frame at 5,800 B (was 6,300 B for everyone) and gives the agent the `minimal`
    tool profile unless its profile was set explicitly. `full` (larger, cached models) caps it at
    9,000 B. Both render the same text, and the tests check both caps in every trust profile ×
    autonomy posture.
  - **Each command is introduced once.** The `# COMMANDS` roster skips commands that TOOL ROUTING
    or MEMORY already name, TOOL ROUTING no longer repeats the analysis-tool list that
    `marina_tool_search` carries, and the memory tools' descriptions defer to MEMORY. AUTHORITY
    AND TRUST and HOW TO BE are unchanged. The worst-case frame fell from 6,279 B to 5,213 B.
  - **`marina_code` and `think` load on demand.** `marina_code` (~4 KB) is resident while a coding
    task is bound, for the `coding-agent` role and for an explicitly chosen profile; otherwise
    each profile's `marina_tool_search` lists it. `think` (no calls among 3,368 recorded resident
    tool calls) is listed the same way. `memory` and `marina_memory_service` were not merged — they
    have different backends and callers — but `memory` now sends its enums as one `enum` keyword
    (1,860 → 1,415 B). `MARINA_DEFERRED_TOOLS=off` keeps everything resident as before.
  - **Long procedures moved to built-in skills.** The chronicling trait (1,879 → 727 B), the
    `canvas-watcher` trait that every `general` agent carries (832 → 464 B) and the
    `[Reflection Due]` procedure keep one line per rule and point at `skill builtin chronicling`,
    `canvas-intents` and `consolidate-memory`.
  - Resident tool schemas: `full` 13,983 → 8,763 B, `crew` 11,216 → 6,512 B, `minimal`
    5,174 → 4,373 B. A crew-profile Opus resident sends about 5.8 KB (~1.5k tokens) less per
    turn. A 16k local model's prefix falls from about 17.5 KB to 9.6 KB.
- **Cache-aware idle handling for residents** (`src/agent/prompt-cache.ts`). A prompt sent more
  than the provider's cache lifetime (5 min) after the agent's last request is cold: the whole
  request is written to the cache again. For residents that pause between turns, those rewrites
  can be a large share of spend.
  - **Default change: compaction before a cold turn.** When the cache has expired and the history
    holds at least the cap's target + 8000 estimated tokens (24 000 by default), it is compacted to
    the target before the prompt, through the same archived compaction as the 48k cap.
    `MARINA_AGENT_COLD_COMPACT=off` restores the old behaviour; `…_MIN_TOKENS` tunes the threshold.
  - **Default change: one-hour cache lifetime for the static prefix** (tool schemas and system
    prompt) on direct Anthropic requests; the conversation keeps 5 minutes.
    `MARINA_PROMPT_CACHE_STATIC_TTL=off` restores it.
  - **The system prompt no longer changes when an agent moves.** The roster's `This room:` line
    put room-specific command names in the system prompt, so every room change rewrote the cached
    static prefix. The line now rides in the per-turn context, shown when the room's commands
    change (`getRoomCommandsLine`). The system prompt is byte-identical across rooms, and both tier
    caps still hold (`test/prompt-budget.test.ts`).
  - **Keep-alive pings, off by default** (`MARINA_AGENT_CACHE_KEEPALIVE=on`): a `max_tokens: 1`
    replay of the last request shortly before the cache expires, bounded per idle gap, per window
    and per agent per day, and turned off for an agent at the first reply that did not read the
    cache. They trade extra calls for fewer cold rewrites.
  - Cache lifetimes are configurable per provider family (`MARINA_PROMPT_CACHE_TTL`); local servers
    and providers with no known cache never count as cold.
  - `agent status` shows cold turns, compactions before them, the cache writes they avoided, and
    keep-alives.
  - **Compaction is incremental.** Earlier summaries are kept verbatim instead of being
    re-summarized, and every summary carries a `Pointers:` line (URLs, typed ids, `#` handles, file
    paths) that is handed on when an old summary is dropped.
- **Default change: `[Focus Review Due]` counts prompts, not minutes.** The 5-minute wall-clock
  horizon fired on most prompts, because idle gaps are longer than that. A focus is now reviewed
  after 10 prompts under it (`MARINA_FOCUS_REVIEW_CYCLES`, or the agent config's
  `focusReviewCycles`, which replaces `focusTimeout`); idle time never counts.
- **Default change: fenced memory is reconstructed as of the cutoff** (`src/memory/as-of.ts`).
  Under an evidence cutoff, a note edited after creation was dropped, and the durable evidence and
  proposal tiers were withheld entirely. Now a revised note is served at the newest canonical
  version known by the cutoff, with that version's own text (labelled `as-of vK` — the version served, never the count past the cutoff, never trusted).
  Durable records, captured sources and assistance proposals are served by their own known-at
  time, taken from the service events the write path records. An item with no such event (bundle
  imports, events dropped before migration 172) is still withheld. Tests prove no post-cutoff text
  reaches any fenced surface.
  - **Fenced search is ranked on the as-of text.** `recall`, `recall … all|evidence`, the
    continuation context and `context` used to select and order notes and records by their
    CURRENT text and scores, then serve the as-of text. Which notes appeared, and their order,
    could reveal a post-cutoff edit. Under a cutoff, notes are now picked from every handle
    known by the cutoff whose any version matches, reduced to the as-of version, dropped unless
    that text matches, and ordered by its term coverage, then by creation time (`fencedNoteRecall`,
    `rankAsOf`). Durable records and sources are re-scored the same way. Query vocabulary, term
    distinctiveness and link expansion, all current state, are skipped under a cutoff.
  - **Known-at times survive event retention (migration 172).** The dating events were pruned
    after 30 days, so older revisions could no longer be dated. The time is now stored on the row:
    `memory_record_versions.known_at`, `memory_sources.known_at` and
    `memory_assistance_jobs.completed_known_at`. Each is set by a trigger on the event, in the same
    transaction. The migration is additive and idempotent: three nullable columns, three triggers,
    and a one-row cursor. Existing rows are filled from the surviving events by the
    `memory-known-at-backfill` tick job, in seq-range batches of short transactions (5,000 event
    seqs each, 8 per pass every 10 ticks). Boot never waits. Until the backfill passes a dating
    event, retention keeps it. Fenced reads use the stored time and fall back to the event log
    only while the backfill is still running. This was chosen over exempting the events from
    retention: on a large database, the as-of lookup becomes a primary-key read instead of a scan
    of the unindexed event log, and the log stays bounded.

- **One formation catalogue** (`src/orchestration/formations/`). Formations were implemented once
  per surface: crew briefs, project templates, arena protocols, typed forecast formations and text
  patterns shared names but not code. Each formation is now one catalogue entry: a one-line
  description, a declarative Score template, and pure combiners per answer type. Assignees are
  abstract slots resolved at run time to `model:`, `role:`, `marina:` or the in-process pipeline,
  and the Score executor is the one runtime. Default behaviour is unchanged everywhere: forecasts,
  `pattern run`, the arena and crews.
  - **Typed forecasts.** `delphi`, `tournament` and `skeptic` run their formation stages as the
    template's Score: Delphi revisions in parallel, tournament matches one at a time in bracket
    order, and the skeptic's trust call. The combiners `combineDelphi`, `championAnswer` and
    `combineSkeptic` are pure. `ensemble` is the pipeline's own round one and combine.
  - **Resident forecasts.** These run every typed formation: `forecast <q> crew:|role:
    pattern:tournament|skeptic` now works alongside `ensemble` and `delphi`. A slot's assignee may
    be `model:<id>` (a bare model through `src/model`) in place of a resident, with the same
    template and the same combiner. The ensemble and delphi Scores are byte-identical to before.
  - **Free-text patterns.** All eight run from the catalogue's text templates. `CREW_ONLY_PATTERNS`
    is derived from the catalogue.
  - **Arena.** `ensemble` and `delphi` run from the catalogue's numeric templates. The shared clamps
    (`median`, `agreement`, `settle`, `delphiSummary`) moved to `combine-numeric.ts` and are
    re-exported. The other ten arena formations keep their own code as a documented follow-up.
  - **One description.** `PATTERN_FIT` reads each formation's summary from the catalogue. Crew
    briefs and project templates name their entry (`crewFormationEntry`, `ORCHESTRATION_TEMPLATES`).
    `test/formation-catalogue.test.ts` fails when a brief or template loses its entry's protocol
    phrases.
  - **Equivalence evidence.** The pre-catalogue implementations are frozen in
    `test/fixtures/formations-legacy/`. Given the same model replies, the catalogue reproduces them
    exactly, answers and every prompt in order:
    - `formation-equivalence-typed`: 4 formations × 7 answer types × 36 reply mixes;
    - `formation-equivalence-text`: 8 patterns × 480 scenarios with budgets, aborts and outages;
    - `formation-equivalence-arena`: all 12 arena formations × 160 runs on stored rounds.

- **Live FutureX uses the earned default.** `bun run futurex run`, `watch --run earned` and
  `schedule` default to the `earned` variant: each row goes through `typedForecastFor` on board
  `futurex` (env, then `forecast-config:futurex`, then the family slot, then the built-in; card
  routing; lessons as a live run). A named variant (`--variant cheap`) is the fixed override for
  controlled experiments; backtests stay fixed (`cheap` by default) and refuse `earned`.
- **`rescore-selection --file` promotes through the one path.** `benchmarks/futurex/rescore-selection.ts
  --file --variant <v>` records ledger runs per selection mode and files the challenger through
  `fileSlotPromotion` on `forecast-config:futurex`, seeding an empty slot with the incumbent first.
  Its own bootstrap verdict is now advisory.

- **One shared model backend for library pipelines** (`src/model/`). Forecast, arena, research,
  lessons, outcome extraction, the web swarm and benchmark checkers call models through one core
  (`modelCall`) instead of `src/arena/model-backend.ts` and a second `modelTurns` copy.
  `src/arena/model-backend.ts` and `src/research/model-turn.ts` are re-exports, and so are the
  retriever and verifier modules that moved from `src/arena/research/` to `src/research/`
  (`retrieve`, `verify`, `web-search`, `isolation`, `barred`, `read-swarm-retriever`).
  - **Spend labels.** Every call names its purpose. The ledger records it under the purpose's
    source plus a `purpose:<name>` breakdown row in `spend_scope_daily` (no migration; read with
    `purposeSpendToday`, left out of the budget-scope readouts). Lesson writing, outcome
    extraction, the web swarm and benchmark checkers move from `forecast` to `model_api`; a judge
    is `decision`; forecast, arena and research stay `forecast`. `MARINA_SPEND_SCOPE` may not use
    the reserved `purpose:` prefix.
  - **No double count.** A loopback `marina/*` call is no longer also priced and recorded by the
    caller; the `/v1` passthru that serves it records it once as `model_api`.
  - **Retry.** A transient failure (429, 5xx, network) is retried once by default with backoff
    (`MARINA_MODEL_RETRIES`, `MARINA_MODEL_RETRY_BASE_MS`). Usage limits, auth, other 4xx, the
    spend cap, timeouts and aborts are never retried.
  - **Traces.** Each call mints a `req-…` id and emits `model_request_lifecycle` events
    (`routeKind: "direct"`, `purpose`, the caller's `traceContext`), so `trace show` covers
    library calls.
  - **Route fallback (opt-in).** `MARINA_MODEL_ROUTE_FALLBACK=on` reuses route health: a usage-
    limited first-party route is served by the same model via OpenRouter. Default off.
- **One path each for lessons, outcomes, standing, the earned judge and statistics.**
  - **Lessons.** The arena crew no longer writes or reads its own `arena-crew` `lesson` notes,
    which were unjudged and went straight into prompts, and a live round no longer teaches twice
    (`learnFromResolutions` is gone: every accepted filing already settles on the outcome path).
    The crew reads only the judged pool (`forecastLessonsFor`). A round revealed in
    `bun run arena evaluate` teaches through the judged loop only, with the round as private
    context for the leak check; that loop is not armed in an evaluation, so a crew backtest now
    runs without lessons. Existing note rows stay, unused.
  - **Outcomes.** A market room's `predict` and `conduct track` also file the resident's call on
    the outcome path (`fileResidentForecast`), so it resolves with its Sample, teaches lessons
    (never the forecast pipeline's history) and earns standing. A newer call settles the open one
    as `superseded` (no score, no outcome). Position boards, `market_scores` and the conductor's
    shape-prior notes are unchanged.
  - **Standing.** `forecast_resolved` is paid to the filer and to every resident or agent its
    filing names as a producer (`BoardFiling.producers`), who are also recorded as the outcome's
    participants. The existing caps and independence rule apply, and one party is considered once
    per answer. No new standing kind.
  - **Earned judge.** `earnedJudge` and one agreement tally (`src/decisions/earned-judge.ts`)
    replace the two copies of the gate (outcome judges, challenge judge) and the third agreement
    count in `decision agreement`, which now also shows the lower bound and whether it is earned.
    The challenge judge's lower bound uses z = 1.959964 instead of 1.96. Verdicts are identical
    for every case up to 2,000 allow calls.
  - **Statistics.** `benchmarks/stats.ts` and `benchmarks/replicate-stats.ts` moved to
    `src/stats/` (shims stay at the old paths), so core no longer imports from the harness tree.
    The bootstrap, Wilson and PRNG copies in the harnesses, `src/learned` and scripts now call
    it. `test/stats-equivalence.test.ts` checks each against a frozen copy of its original with
    exact equality.
- **In-world `benchmark run` measures residents** (`src/engine/benchmark-target.ts`). Before,
  a bare `benchmark run` sent every item to the upstream model with no resident involved.
  - `crew:<name>` measures that crew. With no target, the run measures the world's one serving
    crew; it is refused when there is none or several, and never falls back to the bare model.
  - `model:<id>` is a bare-model control, recorded `targetKind: "model"`, `control: true`, and
    labelled as one. `model:marina:<name>` still means the crew `<name>`.
  - Crew runs always get a run key, and file as `crew` targets with trace-resolved participants,
    so resident work reaches route evidence.
- **No self-grading by default** (`src/engine/benchmark-judge.ts`, harness and in-world).
  - Judge-scored benchmarks use `judge:` / `--judge-model`, else the new
    `MARINA_BENCHMARK_JUDGE_MODEL`, else `marina/default`.
  - A judge that names the target is refused unless `self-judge:on` / `--self-judge` opts in. The
    opt-in is recorded, and the ledger judge reads `[self-judge]`.
  - The harness default used to be the target itself. The tier0 direct-provider control keeps
    target grading, now through an explicit `--self-judge`.
  - Benchmarks that no judge grades record no judge.
- **One benchmark registry** (`src/engine/benchmark-registry.ts`). The harness, the in-world
  list and the web UI derive from it, and `test/benchmark-registry.test.ts` fails on drift. The
  world can now run narrativeqa, mt-bench, retention and aime-2025.
- **Native crew runs file to the ledger and score formation adherence.** A live
  `bun run bench:native` run files a `crew` run (`native-<task>`, oracle judge) into its server's
  ledger, with `--file-to`, `--group` and `--no-file` options. Its config carries formation
  adherence over the run window.
- **Formation adherence is scored from `CREW_BRIEFS`.** Hand-written checks count only while
  their anchor phrase is still in the live brief, and every uncovered brief clause becomes a
  judge question. Every formation is scorable, and an edited brief can no longer leave a stale
  copy scoring the old protocol.

- **Faster fresh installs**: new databases start from the schema-167 baseline (v0.8.0) instead of
  137, about 2.5× faster to create. Existing databases upgrade exactly as before (#500).
- **Silent promise failures are logged or justified**: the empty-catch check covers
  `.catch(() => {})`. Best-effort failures now log through module loggers; the rest carry a reason (#501).
- **`project budget` durations** go through the shared duration parser, which now accepts the
  same decimals and `ms` (#499).
- **Arena poll-level start**: scalar rounds of Economist/YouGov, Morning Consult and AAII start
  from the average of persistence and the arena's EWMA with sd half its own recent RMS error; the
  rule and its evidence are recorded in the filing detail. `MARINA_ARENA_POLL_LEVEL=off` restores
  the old start.

- **Arena**: a first filing for a round outside the filing window is refused unless `--early` is
  passed; `arena-filing-watch` alerts on a filing that was never refreshed (#466).
- **Arena spread calibration**: every filed sd — scalar toplines and each profile cell — is
  multiplied by a scale learned from resolved rounds (best mean per-round skill; CRPS or the
  arena's energy score), partially pooled method → family → cross-family (w = n/(n+4)), clamped
  to [0.35, 3], cut at min(now, lock), and applied after the measured-error floor. It replaces
  the per-key held-out calibrator, which needed 8 records per key and never fired.
  `MARINA_ARENA_SPREAD_CALIBRATION=on|observe|off` (default on; `MARINA_ARENA_CALIBRATION` is
  read as a fallback).

### Fixed

- **`benchmark run` / `sweep` accept the documented `key:value` modifiers.** `arm:bare`,
  `cap:5`, `lessons:on` and `model:…` were silently ignored before: only `--key value` parsed.

- **Wikimedia client politeness**: MediaWiki action-API requests are spaced 500 ms apart
  (REST stays at 100 ms) and one HTTP 429 is retried after its `Retry-After` (up to 30 s).

- A research brief with only one of `until` / `untilAt` was searched as live (no upper date bound);
  either field now bounds the search.
- **Asset bytes are never orphaned.** Local storage reports a failed delete instead of treating it
  as "already gone". Retention keeps and retries an asset whose bytes could not be removed, and
  `asset delete` / `DELETE /api/assets/:id` report the failure (503) and keep the asset. A failed
  read of `/chat` or `/ask` no longer strips their CSP script grants until restart (#506).
- **`memory:compatibility status` only reads.** It no longer upgrades the database it inspects; it
  reports pending migrations and points to `upgrade` (#497).
- **`build validate` no longer makes staged room code loadable.** Only the `world.code`-gated
  `build reload` marks a version valid for loading on restart (#503).
- **Arena anchor guard**: before signing, a filing's anchor (the latest reading its inputs saw) is
  compared with the arena's latest published value, per series or profile cell and tolerant of
  rounding. A stale anchor re-reads the inputs once, then re-anchors on the arena's value; the
  attempt is recorded as `stale_anchor` and `arena-filing-watch` alerts (for every open round, not
  only those locking within 24 h). `submit due --replace` also refiles every open round whose
  accepted filing is stale, whatever its lock. `MARINA_ARENA_ANCHOR_GUARD=on|observe|off`. Two
  Season-0 Economist/YouGov rounds filed at 36 / 18 locked against 38 / 21.
- **Embedded Marina follow-ups** (#493):
  - Child worlds get their own data directory under the parent's, so they never overwrite the
    parent's `endpoint.json` or open its auth database.
  - `<MARINA_DATA_DIR>/.env` applies before any module reads the environment.
  - Idle shutdown waits for streamed responses and open WebSocket and telnet sessions.
  - A stopped agent's open turn no longer blocks idle shutdown.
  - `marina mcp-stdio` exits when its client goes away.
  - `marina --help` lists the embedding subcommands.
- With `WS_PORT=0`, the decision backend, lessons judge and note ingest called port 3300
  instead of the bound port.
- **Code Mode clone sources** go through the shared SSRF guard: `code project clone` now also
  refuses `[::1]`, IPv4-mapped, link-local and cloud-metadata hosts, and names that resolve to a
  private address.
- Asset ownership and media job identity come from the authenticated caller, not a request field
  (#467).
- Private assets display for remote dashboard viewers through short-lived signed URLs; the drop
  dialog preview works; the pdf.js worker is bundled instead of loaded from a CDN (#468).
- Runway, OpenAI image and Veo requests match the providers' current APIs; video jobs resume after
  a restart and time out (`MARINA_VIDEO_JOB_TIMEOUT_MIN`) (#469).
- The media library, viewer and uploads work in the desktop shell (#477).

### Security

- **Outbound requests and network helpers.** A cross-origin redirect followed by the URL guard
  drops provider signing and token headers (`KALSHI-ACCESS-*`, Polymarket `POLY_*`, `*-token`,
  `*-secret`, `*-signature`) as well as `Authorization`, cookies and API keys. IPv6 link-local
  and unique-local ranges are matched by prefix (all of `fe80::/10`), so a host name such as
  `fdroid.org` is no longer mistaken for an address. Under the `local` profile, peer URLs still
  refuse link-local and cloud-metadata addresses in IPv4-mapped and tunnelled IPv6 forms, plus
  `192.0.0.192`, `fd00:ec2::254` and metadata host names. `connect add` checks a connector URL's
  resolved addresses before dialling it. The Kalshi, Polymarket, TabH2O, forecast-lookup,
  connector and room HTTP clients keep their deadline until the response body is read.
  `/api/probe` shares the `/mem` authentication path (constant-time key match, failed-auth
  throttle, sanitized `X-Agent-Name`) and caps request bodies at 64 KiB. Local asset storage
  refuses keys outside its directory. The routing supervisor runs git with the hardened host-git
  settings. `MODEL_API_KEYS` is parsed in one place. `hono` is updated to 4.13.11.

- **Boards enforce their access rules on every path** (GHSA-rgp4-gg8w-xwxm). Reading a post by
  number, reply, search, scores, vote, archive and `export` skipped a board's rank floors, and no
  path kept a group's board members-only. One rule now covers them all: group boards are
  members-only in every trust profile, rank floors apply to every path, and archiving is the
  author's or a moderator's.
- The startup banner no longer prints the local model-API key; it reads the key from its
  0600 file instead, so captured stdout never carries the credential.
- **A hostname is loopback only when it is one.** A browser origin, bind host or gateway target
  counted as loopback when its hostname merely started with `127.`, so on a loopback bind a page
  served from a name such as `127.attacker.example` was trusted as the local operator's own
  browser on `/ws`, `/dashboard-ws`, `/canvas-ws` and `/api/command`. Loopback now means
  `localhost`, `::1` or an IPv4 literal in 127.0.0.0/8, through one shared check
  (`src/net/loopback.ts`) that replaces every local copy.

## [0.8.0] — 2026-10-14

### Upgrade notes

Behaviour changes a living world notices on upgrade (nothing is reset: stored ranks, grants,
demonstrations and standing rows are kept):

- **Standing is earned only by independently verified work** (#448). `chronicled`, `pool_note`,
  `reflection_recalled`, `crew_*` and `helping_act` credits are retired: `record()` refuses them
  and existing rows decay out. A task pays 0–10 (default 1) and only when someone outside the
  claimant's account and spawn lineage approves it.
- **Approvals are the gate proof** (#452, #459). Earnable gates have low standing floors
  (`code.exec` 3; `agent.spawn`/`role.edit`/`world.lineage` 10; `agent.run` 20;
  `decisions.configure`/`adapter`/`connect`/`gateway` 30) and become solo after held runs a person
  outside the lineage approved; core gates are operator grants. Only people grant gates.
- **Only people approve holds** (#447). An agent never answers another's challenge, whatever its
  rank; the dashboard's rank-9 shortcut is removed (the gate decides). One-shot/pipe CLI and SDK
  clients count as agents unless they declare `principal: "person"`.
- **Agent loop** (#435, #438): agents owe replies only to requests addressed to them
  (`MARINA_FORCED_ACTION_NUDGE=requests` is the default); an idle agent makes no model call when
  nothing is new, with a 30-minute heartbeat (`MARINA_AGENT_HEARTBEAT_MS`).
- **Orchestration templates no longer carry static sweep scores** (#432).
- **Built-in model defaults use each vendor's strong tier** (#401); every env override still wins.
- Seeded guide notes reconcile on boot: edited or removed seed text is retired (#439, #440).

### Added

- **`MARINA_AUTONOMY=sovereign`** (#465): the named all-gates-off switch for a sovereign,
  self-hosted Marina with no guests. Every gate (the core included), rank floor and hold is off
  for every principal in any trust profile; audit stays on and the profile still sets the
  performance defaults. A non-loopback bind refuses to boot unless
  `MARINA_ALLOW_INSECURE_PUBLIC=true`, signed in or not. `open` still never lifts the core.
- **Schedules** (#419, #422): `schedule add <name> every:|daily:|at:|before: lead: -- <command>`
  runs an owner's own command later or on a repeat, in the owner's slot with the same rank, gates,
  challenges and spend caps; `before:<kind>:<id>` follows a registered deadline reference.
  Migration 165.
- **Durable challenge holds** (#447, migration 166): holds survive restarts, expire on a 15 s
  sweep, and owed notices wait until the requester connects; offline approvers get an `ops inbox`
  item.
- **Standing readouts** (#448): `code_verified` and `forecast_resolved` credits; an operator-set
  rank below 5 is a floor progression keeps (`users.rank_floor`, migration 167).
- **Same-model OpenRouter fallback** (#453, #456): a first-party key's usage limit is a route
  limit; while it lasts the same model is served via OpenRouter, labelled `openrouter/…` with an
  `x-marina-route` header, and agents (including discovery turns) retry there.
  `MARINA_PROVIDER_FALLBACK=off` disables; readiness `provider-routes` reports it.
- **Providers**: Together AI and Nebius Token Factory keys, catalogs and pricing (#417).
- **Passthru**: the instrument stack runs on `/v1/responses` and the verify checker sees memory
  context (#397); an opt-in `ensemble` member drafts a tool-calling turn N times and a checker picks
  one whole draft (#400), composing with `verify` (#403).
- **Code Mode**: `code do budget:<duration>` gives a one-shot wall-clock budget that ends in a
  labelled forced answer (#398); a crew member may submit the tracked attempt for the crew
  (#404); Python projects without pytest fall back to unittest or a workspace test script (#405);
  a spend stop submits the attempt's work like any other budget (#406).
- **CLI**: `/plan` read-only plan mode (#393); a standalone native `marina` binary with embedded
  version, worlds and settings (#407, #408); first-run polish (#433).
- **Benchmarks (opt-in operator tools)**: run keys carry an arm, eval context, spend cap and
  transport guard (#421); `benchmark kit` runs the reproduction kit in-world (#423, #425);
  `benchmark compare-run` runs a paired two-arm comparison as one command (#427).
- **Outcomes and competence loop**: arena filings, benchmark runs and live work (task verdicts,
  Code Mode checks, `POST /v1/outcomes`) settle on the one outcome path tagged by family and
  method (#444, #450, #454); forecasting gains method cards, earned card routing and a
  competence map (#451).
- **Forecasting/arena mechanisms**: learned settings run by default and measurement runs save
  (#392); a read-only `arena-filing-watch` alert for rounds about to lock (#420); per-(family,
  method) spread calibration (#445), earned family routes (#449), learned move weights (#458),
  spike-decay and Wikipedia scheduled-event methods (#457, #460), stale related-series labels
  (#455), sampling-noise baselines and spread floors (#442, #443).
- **Operations**: `bun run monitor`, an outside monitor that installs nothing on the host, and
  tick liveness in `/health` (#428); repeated console lines collapse while the log store keeps
  every entry (#424).
- **Tests**: a deterministic fake model for key-free end-to-end plumbing tests
  (`MARINA_FAKE_MODEL=1`, #410); every Marina concept exercised under shipped defaults (#396).
- Work view: canvas requests appear in "Your next moves" with one lifecycle history (#426).

- The coding-loop on-ramp (#391, #393): zero-config start (one line names the missing provider
  key and offers `marina init`), `/memory` (remember and recall a folder via the world's
  `note`/`recall`), `/model` and `/fast` (switch the session model, or pick the cheapest reachable
  model across vendors), piped stdin (`printf "…" | marina -p`), `/plan` (read-only plan mode with
  a hard observation-only tool gate), `/compact` (compact the conversation on demand), `/cost` /
  `/usage` (today's model spend against the daily cap), `/continue` (resume the most recent
  session in the folder), and `bun run build:native` (compile a standalone `marina` dispatcher).
- `marina attach [url] [--name N] [--session S] [--tui]` (#368) attaches a coding terminal to an
  existing session, resolving server, account and session from arguments, `MARINA_URL` or the
  cached identity. `bun run setup:cli` links `marina` onto the PATH so it runs from any folder, and
  a folder server announces itself in `server.json` (#372). Diff and patch results render as a
  per-file stat plus locally coloured hunks (never under `NO_COLOR` or without a TTY) (#370,
  #373). `marina -p` exits 0 only when the work completed AND verified (3 otherwise;
  `--allow-unverified` restores 0) and `--json` prints one result object (#371). The first screen
  is shorter and the provider check asks the server (#369); terminal journey tests record time to
  prompt, screen lines and keystrokes (#367).
- One durable outcome path (#356–#363, migration 162): every filed answer lives in
  `forecast_answers`, each resolution is one append-only `outcomes` row with durable per-consumer
  deliveries. Board adapters file and resolve through it; task verdicts and Code Mode checks are
  recorded as live outcomes, owner-scoped so a person's work never reaches the shared pool. Opt-in
  hourly jobs resolve answers from linked markets (`MARINA_OUTCOME_AUTORESOLVE`) and judge answers
  no market settles — choices, multi-select and numbers with a verbatim evidence quote
  (`MARINA_OUTCOME_JUDGE=off|observe|on`). `POST /v1/outcomes` lets a caller report how a request
  turned out; `MARINA_ROUTE_EVIDENCE_LIVE=on` lets spawn-time routing weigh that live evidence.
- Obligations ledger (#322, #325, #329, #335, #336, #344–#346): opt-in per request
  (`marina/obligations:<model>`, `x-marina-obligations`) or for agents (`MARINA_OBLIGATIONS`).
  Requests become tracked obligations settled by matching writes, with a trailing reminder and at
  most one nudge per owed obligation; approvals are tracked so a re-ask is noticed; an advisory
  pre-write review (order, evidence, requested, permitted) with `MARINA_OBLIGATIONS_REVIEW=auto`
  per-task selection. The argument check (`marina/argcheck:<model>`, `MARINA_ARGCHECK`) looks up a
  write call's ids, amounts and dates in the conversation before it runs; dispatcher calls are
  classified by the inner tool, one read/write classifier serves both, and judge rule passages are
  opt-in (`MARINA_ARGCHECK_RULE_BYTES`); a command line the model writes is never
  checked as values. Never rewrites output or arguments; fails open.
- Lessons from every outcome (#242, #245, #290, #299, #315, #321, #323, #338, #349–#351): each
  verdict becomes at most one judged, leak-guarded lesson recalled by the forecaster,
  `marina/verify`, crews and Code Mode (rank-0 `lessons` command). Benchmark runs teach only
  general configuration rules, never item text. Lessons retire and supersede; lesson writes can be
  ranked for admission (`MARINA_MEMORY_RANKING`); measurement runs never recall lessons from the
  board they measure. `MARINA_LESSONS_FROM_WORK=off|observe|on` (default off) turns recurring tool
  failures, gate holds, argcheck flags, challenge answers and task verdicts into tool-use lessons,
  scoped to their owner. Signed `marina.learned.v1` bundles export what Marina learned (lessons,
  conventions, promoted defaults, roles) for opt-in, trust-capped import elsewhere.
- Forecasting (#228, #231, #233, #241, #255, #273, #280, #288, #343, #352–#355): typed answers
  (choice, multi-select, number, ranked list, short string) with planning, research rounds, K runs
  and critique; probabilistic options; retrieval isolation to a cutoff; market, odds and
  official-series lookups read as of the cutoff (`MARINA_FORECAST_LOOKUPS`, now `auto`, plus a
  `data` command and room verbs); model-free statistical priors from series history and published
  outcomes; prior shrinkage, recalibration and a skeptic crew adopted only on a held-out win;
  barred sources on every engine. `POST /v1/forecast` takes `save: true` / `resolves:` so HTTP
  answers resolve and teach; resolved answers write the forecast history (`MARINA_FORECAST_HISTORY`,
  numbers and label hashes only).
- Research and retrieval (#232, #254, #286, #296, #331, #332): research that reads, quotes and
  verifies pages across a search backend chain; date-bounded keyless providers (GDELT, Wikipedia,
  HN, arXiv, Wayback) and a search tool room; offline BM25 local corpora (`bun run corpus`);
  optional hybrid search with a shared vector index and any-provider embeddings; a read swarm of
  cheap readers over whole documents (`MARINA_READ_SWARM_READER`); a live-web research agent with
  a provenance cache and cited, audited research reports; barred sources on every web-agent path.
- Memory (#324, #326, #327, #330): an optional relevance gate inside unified context
  (`MARINA_MEMORY_RELEVANCE_GATE=off|observe|on`), hybrid context search, ingest-time grounded
  notes linked to their source (`MARINA_MEMORY_INGEST_NOTES`), and a concurrent index drain.
- `marina/verify:<proposer>[+<checker>]` (#235, #243, #269): the verification formation as a model
  id for any OpenAI-compatible client, tool calls included. Drafted write actions are held unless
  the checker cites a grounded conflict; the checker inherits the caller's effort.
- Vision (#251, #253): `canvas look <node> [question]`, `image describe`, `video describe` and
  the `marina_see` agent tool read canvas images, PDFs and video keyframes as untrusted bytes.
- Every budget ends in an answer (#279): loops with a turn, step or time budget steer at 75 % then
  block tools and ask for the answer, labelled `BudgetForced`; crews get deadlines.
- Benchmark ledger (#214, #216, #218, #226, #262, #278, #282): every run is filed with cost,
  interval, slice, judge, target, participants from traces and per-item outcomes (ids only, never
  case content); replicate groups with pooled comparison; audited `benchmark invalidate`. Defaults
  change only by earned promotion on a held-out split and are read through one resolution path
  (env > local slot > family slot > built-in, each resolution traced).
- Benchmark tooling as thin, opt-in adapters: a Tier-0 preset with paired comparison (#202),
  seeded crew-task generators with exact oracles (#200), a formation adherence scorer (#188), a
  multimodal HLE set (#253), numeric-equivalence grading (#339), a one-command reproduction kit
  (`bun run repro`, #244, #250, #272), adapters for SWE-bench and SWE-bench Pro (#234, #267),
  FutureX (#230, #249), Metaculus (#255), Prophet Arena (#259), BrowseComp-Plus (#254, #271),
  τ²/τ³ (#235, #248), LongMemEval-V2 and DeepResearch Bench (#320, #331), with hard spend caps,
  resume journals and recorded server features (`--server-env`, #348).
- Model routing evidence (#217, #223): `MARINA_ROUTE_EVIDENCE` lets spawn-time `model:route` prefer
  another of its own candidates from ledger evidence, with objectives `lcb|budget|value` and
  role-level evidence first.
- Six new orchestration patterns (#186, #187, #189, #191): delphi, tournament, verification,
  auction, ledger and sharding; formations now drive dispatch with named leads. Serving crews route
  `marina:<crew>` requests to their outward face and consult specialists per request (#225).
- Macros take arguments (`$*`, `$@`, `$1`..`$9`), posture-aware expansion limits and room-scoped
  macros (#201). `MARINA_AGENT_MODELS` maps seeded agents to models (#213).
- Agent loop options (#199, #203, #205, #207): terse agent communication, reply obligations only
  for requests, an opt-in nudge scope, and a 48k-token conversation cap with old reasoning dropped
  by default (`MARINA_AGENT_CONTEXT_CAP_TOKENS=off`, `MARINA_DROP_OLD_THINKING_SIGNATURES=off`).
- Coding: project test-runner detection and container-backed workspaces (`code workspace runner
  container image:<ref>`, #238); project-aware `code verify` with four result states (#277);
  guided coding workflow, live TUI workspace with parallel panes, scoped guidance, live coding
  desks published across dashboard and terminal, recovery and confirmed-identity resume of native
  Claude sessions (#366); reversible dashboard panel arrangement.
- Passthru: rolling cache breakpoints, with `cache_control` kept for Claude via OpenRouter (#260);
  per-request injections ride after the breakpoints (#334); Claude 5 `reasoning_effort` maps to
  adaptive thinking (#265).
- Every model-using feature runs degraded on one local runtime or one key (#247). Novelty-driven
  exploration is grounded in observed execution and outcomes (#293).
- Optional marketplace extension (`extensions/marina-market`, loaded only via `MARINA_PLUGINS`)
  for licensed worlds and memory on top of `marina.learned.v1`.
- Desktop app migrated to Electrobun v2 with native release qualification; adoption guides for
  integrations. Opt-in `docker-compose.local.yml` for a single-user container; the compose bind
  address is configurable (#316).
- Arena forecasters (#183, #184, #187, #194, #227): orchestration patterns as forecasters
  (`formation:<pattern>:<models>`), per-family routing (`route:<family>=<spec|skip>`), Tavily and
  Perplexity Sonar retrievers, a TabH2O forecaster, a horizon-aware nowcast (off by default),
  bounded shadow portfolios and settlement qualified on frozen evidence. OpenSSH Ed25519 keys load
  directly and `arena status` checks the key against the registration.
- Environment configuration split: `.env.example` is now a short commented starter, the complete
  annotated server catalog is `config/environment.reference` (feeding Admin → Settings and the
  generated `docs/reference/environment.md`), SDK example knobs moved to
  `src/sdk/examples/.env.example`, memory-service example knobs to
  `examples/memory-service/.env.example`, and script knobs to the testing and release-qualification
  guides. The catalog parses `@protected`, `@internal` and `@restart` tags; the dashboard refuses
  writes to protected and internal keys and no longer offers the SDK example knobs as server
  settings. A docs-contract test now also fails when code reads an undocumented `MARINA_*`
  variable.
- Trial score split: each arm now shows its answer rate and its accuracy on answered items, and a
  `split:` line says whether a difference came from better answers or from answering more often
  (also in `evolve adoption` offers and `world adopt` requests). The gates still judge the overall
  score — a role that does not answer is worse.
- Bringing a winner home: `evolve adoption <role>` in a child offers a role only with an
  accepted run whose trial EARNED its win (the same `earnedWin` test as replication);
  `world adopt <child> <role> [into:<existing>]` records a pending request with that evidence,
  `world adopt approve` by someone other than the requester applies it (replacing an existing role
  needs `role.edit`, never the approver's own role, previous definition saved), `world adopt
  rollback` restores it, `world adopt list|reject`. Nothing changes running agents until
  `role reload`.
- Held-out trials: a fixed, disjoint `holdout` / `tune` split of every benchmark by item-id hash
  (`benchmarks/partition.ts`, `benchmark run … --partition holdout|tune`); `evolve trial` judges on
  100 held-out ARC-Challenge items by default, reports a 95% interval on the difference
  (Agresti–Caffo), and `evolve replicate` requires that interval to exclude zero.
- Earned replication: `evolve replicate <exp> <run> [n] [budget] [model]` — an accepted candidate that
  won its trial by the fishing margin (shared with arena discovery, `src/engine/fishing-margin.ts`)
  spawns copies of itself in its child or parallel world, within a per-run ceiling (5), the
  caller's spawn budget, `MAX_AGENTS` and the daily cap; each copy gets a lineage record. Trial
  results are stored structured under the world-level `evolve-trials` owner.
- `evolve trial <exp> <run> incumbent:<role>`: a candidate role against the incumbent, side by
  side, in a child or parallel world only — temporary agents on each role, their own model
  channels, the same benchmark, a deadline, teardown, and a stored result naming both runs for
  `evolve evaluate`. Nothing is adopted. `evolve trial <exp> <run> result` reads it back.
- Parent ↔ child worlds from inside the world: `world create|start|stop|list`, `world run <child>
  <command>` (runs one command inside a running child as the caller, over its loopback command
  endpoint) and `world seed-role <child> <role>`. `role export` / `role import` move a role and
  its traits between worlds losslessly; import only creates.
- Per-world daily spend cap: `MARINA_DAILY_SPEND_CAP_USD` caps everything a world pays upstream
  in a UTC day — `/v1` passthru (so in-world benchmark runs), agent turns priced by their own
  provider, decision backends and forecasts — each dollar recorded once, where it leaves Marina,
  in `spend_daily` (migration 131) so a restart does not reset it. At the cap `/v1` returns 429
  `spend_cap_reached`, decisions and forecasts are refused and agents pause. Child worlds start
  with $50 (`MARINA_CHILD_DAILY_SPEND_CAP_USD`); `readiness` reports "Daily spend".
- Evidence you can check: `evolve evaluate` resolves cited `benchmark:<br_id>` runs — a missing,
  running or all-error run refuses the evaluation — and stores the verified score with the
  evidence. Benchmark runs against `marina:<name>` record what they measured (agents, role, system
  prompt hash) in their config, shown by `benchmark result` as `measured:`.
- Autonomy pulse history: the `autonomy-pulse` tick job stores the readiness autonomy numbers every
  5 minutes (`autonomy_pulse`, migration 130, kept 30 days), and `readiness autonomy` reports the
  last 24 hours against the 70% goal. No model involved.
- Judge agreement: `MARINA_DECISION_VERIFY=observe` scores every task submission with the
  configured decision backend and records the judge's opinion without acting on it
  (`judge_observations`, migration 129); `decision agreement` compares those opinions with the
  task creators' approve/reject, per backend (`<kind>:<model>`, calibrated or not). Works with Jev
  on OpenRouter, a local OpenJev, TypeSafe or a chat classifier, and says so plainly when none is
  configured.
- Self-improvement by succession: an agent never changes the role it runs on (`role edit|delete|
  reload`, `trait delete` inside it, `agent config <self> role` — refused in every profile); it
  creates a new role and spawns an improved iteration. A new `role.edit` safety gate (standing 40,
  3 witnessed demonstrations, granted with rank 5) covers changing an existing role or trait, and
  those commands are now `consequential` for the decision gate. On shared and public instances a
  rank-3 agent's first edits of existing roles now need a witness.
- In-world qualification views: `decision qualify` (the labeled gate and route cases against the
  world's own decision backend; rate limited), `readiness autonomy` (each autonomy requirement vs
  what was observed in the last 5 minutes) and `evolve qualify` (the `qualify:evolution` verdict,
  read-only). The scripts share the same code: `AUTONOMY_REQUIREMENTS`,
  `evolutionSessionsWithEvidence`, `loadDecisionCases` / `renderBackendReport`. The decision
  case set moved to `src/decisions/decision-cases.json`.
- `benchmark run smoke`: the frozen 15-item prompt A/B set (`benchmarks/smoke-eval.json`) as an
  in-world benchmark with its own leaderboard — the same items and scoring as `bun run eval-prompt`
  (a shared `checks` harness adapter), always ready since the dataset is tracked.
- The arena measurement loop in the world: `arena evaluate [baseline|nowcast|discovered]`,
  `arena shadow [list|score]`, `arena shadow run <round_id|due> [forecaster:F]`,
  `arena discover [tracker:T]` and `arena signals`, so an agent can propose, backtest, record and
  grade signals itself. Free forecasters only; model-backed runs stay operator steps. Discovery is
  rate limited per entity and runs one at a time. `MARINA_ARENA_PROPOSER` picks the proposer.
- Forecast any question (#130): `forecast <question>` (alias `predict`), `bun run forecast`, and
  `POST /v1/forecast` return a probability or a number with an interval, the sources, which cited
  figures verified, what each analyst said, and the cost. See `docs/guides/forecasting.md`.
- Social Simulation Arena entrant (#123–#131): signed Route-B submissions, `arena` in-world
  command and `bun run arena` operator CLI, baseline / Civiqs nowcast / model / multi-vendor crew /
  research-agent forecasters, profile and ranking scoring as the leaderboard scores them, a
  forward shadow ledger, leakage exclusions and source-terms rules, and a signal-discovery loop
  that promotes a signal only when it wins on held-out rounds. See `docs/guides/arena.md`.
- Local API key (#131): on the local profile Marina creates `MARINA_LOCAL_API_KEY` once, stores it
  next to the database (mode 600) and prints an `OPENAI_BASE_URL` / `OPENAI_API_KEY` line at
  startup, so an OpenAI client works with no configuration.
- CLI `--port` / `--url` (#130); auxiliary ports derive from `WS_PORT` (+1 MCP, +2 logs).
- Harness decisions (#106–#120): `decision check` / `decision choose`, the pi tool gate with owner
  approval, calibration, a route table, the Ops decisions view, a qualification harness, and
  `POST /v1/decisions` (TypeSafe-compatible `/v1/systemone`). See `docs/architecture/decisions.md`.
- Hugging Face Inference Providers as a first-class provider (#117); pi-ai 0.87 (#116); model
  defaults moved off gpt-4o-mini / Haiku 4.5 (#118).
- Dashboard macro chips, decisions health and a lazy WorkDrawer (#122); native coding agents run
  from the Marina terminal, with durable task attempts and review evidence.

- Formation runtime formalized: `CREW_BRIEFS` give every crew formation a
  compact, structure-light runtime brief (led by a protocol-priority preamble
  so answering a `model_request` always outranks process), and
  `FORMATION_MEDIATORS` deliver the long-promised Phase-4 hooks — the crew
  manager posts at most one deterministic `[formation-mediator]` next-step
  line per dispatch, stage completion, or artifact (pipeline handoffs,
  mapreduce fan-out/merge, foundry merge-gate, debate sealed positions,
  deliberation one-round bound, blackboard no-fork). The coordination guide
  gains a "Crews: formations at runtime" section.
- Pending-request reminders in the model API: while a routed `model_request`
  is unanswered, the engine re-posts it at 25% and 60% of
  `MODEL_REQUEST_TIMEOUT_MS` with the exact `channel send <name> {json}`
  command to run — a mechanical backstop for small-model coordinators whose
  continuation cycle displaced their final reply. `MODEL_REQUEST_REMINDERS=0`
  disables.
- Single-writer crew deliverables: each dispatch pre-assigns a designated
  depositor (crew lead when present, else round-robin) in the same perception
  that starts the race; everyone works the task, only the depositor writes
  the deliverable. A two-shot coverage fallback nudges at 90s/150s when no
  deposit lands, and a `[crew-deposit]` echo marks delivered work "verify,
  don't redo".
- `PATTERN_VALIDATION` records per-pattern sweep evidence beside
  `PATTERN_FIT`; `project recommend` tags each suggestion
  `[validated|partial|unvalidated]`.
- Councilor, Debater, and Decomposer traits teach the explicit RESPONSE
  PROTOCOL envelope (seed-guarded — fresh worlds only).

### Changed

- `bun run lint` covers `scripts/` and `benchmarks/` (#464); benchmark data JSON is excluded so
  hashed corpora stay byte-stable.
- **Agent-facing text is truthful** (#437, #441): prompts and tool descriptions match the live
  commands; peer text cannot forge harness lines; untrusted results are labelled; evaluation
  turns are quarantined from the journal; `trusted` needs independent verification.
- **Seeded knowledge** (#439, #440): keyed guide notes reconcile on boot, the auditor reads the
  live command manifest, seeded residents are not operators, and seeded tasks have a reviewer —
  a seeded resident, or else an operator who has not claimed the task (#462).
- A provider that rejects a key parks the agent and tells the spawner (#431); account/workspace
  usage limits stop like spend refusals instead of retrying (#414); sampling parameters follow
  each model's capabilities (#399); reasoning-mandatory defaults still answer short requests
  (#415).
- Instrumented passthru conversations stay prompt-cacheable on OpenAI upstreams (#413); the
  argument check reads ids inside URLs and spares self-authored metadata; observe mode makes no
  paid calls (#416, #434).
- `src/net/` is split into subdirectories (#409); dependency upgrades: in-range updates (#446)
  and majors — pi 1.2, motion 14, Babel 8, Playwright 1.64 (#461).
- Defaults: the daily spend cap is $50 and shared across every spending process on the same world
  database, with budget scopes and one `SpendGuard` (#275); `MARINA_DEFAULT_MAX_TOKENS` is 16384;
  seeded agents auto-respawn on a local install with a usable provider; the Ollama default is the
  first installed model; model defaults are current, routable ids; the arena's default forecaster
  is the nowcast.
- Stored provider keys are encrypted by default with a generated `<DB_PATH>.key-secret` (0600);
  existing plaintext rows keep working. The local profile's API key also opens `/mem`.
- Self-URLs, MCP and log ports follow the port actually bound.
- Explicit provider ids never fall back to another provider; a named provider's 4xx is returned as
  is and the full id goes only to an aggregator (#206, #209, #215, #314).
- Opt-in instruments never drop silently: an unsupported combination or route returns 400
  `unsupported_parameter` (#347).
- Harness decisions: only the writing parts of a batch are gated, web egress is its own class,
  second opinions are asked only where they can change the verdict, with a bounded wait (#195,
  #197, #208, #211).
- Orchestration templates read as invitations rather than imperatives.
- `inherit` and `inheritance` merged into one `inheritance` command
  (`list | export <pool> | import <token>`); `inherit <token>` survives as an
  alias routed to `import`, which keeps its rank-2 floor.
- `ask`, `recap`, and `dig` share one retrieval core
  (`src/engine/commands/retrieval-core.ts`) for source gathering and the
  group-pool privacy guard; rendering stays per verb, and `dig` still grounds
  on personal + guide notes only.

### Fixed

- A crew dispatch to a member who was not connected is redelivered, still flagged as a crew
  task, when they connect (#462).
- Research and memory context keep evidence and resume after interruption (#394); `marina -p`
  exits 0 when only declared not-machine-checkable requirements remain (#412); budget-forced
  Code Mode submits reach the ledger (#402); the BrowseComp-Plus grader opts out of the stack
  (#411); arena filings always use the latest observation (#418).
- `benchmark run` / `benchmark sweep` rank floors are posture-aware (`rankFloorRefusal`): the
  local profile and `open` pass them, and a refusal raises a challenge instead of a dead end.
- Delivered-trace bookkeeping is released when an entity is removed (it grew per entity forever).
- Coding (#240, #276, #283, #289, #292, #365): task execution, delivery verification and evidence
  hardened; bounded worker context and recovery; `code handoff … to <agent>` parses recipients
  unambiguously; the container runtime uses the operator's image storage; SWE-bench workspaces hold
  the base commit only.
- Agents (#198, #219, #220, #258): commands after `;` outside `batch` are flagged; seeded
  `model:route` configs route at first spawn and boot respawn never drops an agent to the spawn
  cooldown; models that reason unasked reach their tool calls, with labelled output repair
  (`MARINA_OUTPUT_REPAIR`); command evidence and pending replies survive restarts.
- A persisted crew survives `crew complete` (#210); span links carry request traces through busy,
  batched and handed-over work (#224).
- `calc` runs in a bounded worker with a 10 s deadline instead of freezing the event loop (#222).
- Passthru image parts survive Responses and Anthropic translation (#246); base64 images are
  labelled by their bytes (#266); request images and private canvas nodes share one read check
  with expiring grants (#281, #284); Responses reasoning tool loops are preserved (#365).
- Memory: retired records are excluded at the search layer (#263); slow context is served once
  rather than failed, the relevance gate is bounded and embedding inputs capped (#326); a bare
  probability reads as a `noul` answer (#328).
- Lessons judged from CLI processes use a key the server accepts; the ledger backfill never
  re-learns a retired lesson (#323).
- Benchmark runners: finished rows are kept on a cap stop (#288), a null reply is an empty answer
  (#212), fallback rows write no lessons (#261), attempt-less instances are filed unresolved
  (#268), and selection and adapter runs stop cleanly before budget or cap and fetch pointer
  datasets correctly (#252, #264, #270, #274).
- An invalid `LOG_LEVEL` or `STANDING_HALF_LIFE_DAYS` falls back to its default; the hot-reload
  list names only hot-reloadable variables.
- Release and CI: bundled server startup qualified (#340), Docker build no longer copies removed
  desktop patches (#287), deploy image store bounded, browser suite serialised with CI retries
  (#317, #318).
- A quality pass over access scoping, agent loop bounds, command ingress, API hardening and
  persistence (#185).
- The container image shipped devDependencies, including the TypeScript 7 native compiler (a Go
  binary with its own Go stdlib), so the Trivy image scan failed on 10 HIGH Go CVEs on every PR.
  The runtime stage now takes `node_modules` from a production-only install (`prod-deps` stage);
  nothing at runtime imports typescript or biome. Local scan: 0 fixable CRITICAL/HIGH.
- The arena shadow ledger kept the FIRST forecast per round and refused later ones, so a forecast
  recorded days before lock (before the freshest reading existed — the 9/25 Civiqs nowcasts were
  identical to the baseline) could never be replaced by the one that would actually be filed.
  Migration 137 keeps every recording (append-only); `shadow score` scores the last one before
  lock; a record younger than 6 h is not duplicated.
- `role create|edit … guidelines` took a single token, so a guideline could not contain spaces
  (the documented `guidelines Be precise|Cite sources` kept only "Be"). Every field's value now runs
  to the next field name; a field name starts a field only in lowercase, so "Tone" inside a sentence
  stays text. `guidelines a|b` still parses.
- Agents on `marina/default` (and any proxied `marina/*` model) showed $0 spend, so the per-agent and
  runtime-wide hourly caps never saw their cost: the proxy reports cost in a response header, and a
  STREAMING reply's headers leave before usage is known. The passthru now settles each completed
  call's cost by request id (`src/engine/proxy-settlement.ts`) and the agent reads it at turn end by
  the `x-request-id` it already receives. The daily ledger was always correct and is unchanged.
- A 100-item `evolve trial` ran its agents out of calls (a fixed 300-call budget lasted ~70 items),
  after which every item timed out — measuring the budget, not the role. Trial agents now get
  `trialCallBudget(items)` = 60 + 8 per item.
- A child world whose directory was gone crashed at start and reported only "did not become ready
  within 10 seconds": `start()` now recreates the directory, keeps the child's last stderr lines
  in the variant's error, and waits up to `MARINA_COLLECTIVE_START_TIMEOUT_MS` (default 30 s).
- A `marina:<name>` model id naming a live agent channel was proxied upstream (404) in the default
  `passthru` endpoint mode and for Marina's internal callers, so in-world `benchmark run --model
  marina:<crew>` and `benchmark sweep` never reached the agents. Explicit live orchestrations now
  route to their channel in every mode; a caller in that channel is never routed back into it.
- Concurrent benchmark runs could read each other's results: the runner took "the newest result
  file for this dataset" from a folder shared by every run (and by child worlds, which share the
  working directory). Each run now names its own file (`MARINA_BENCH_RESULT_FILE`, keyed by run
  id) and reads exactly that.
- `arena shadow run … --forecaster discovered` (CLI and `MARINA_ARENA_SHADOW`) never saw the
  world's promoted signals and silently recorded the nowcast instead.
- In-world `benchmark run` measured nothing: the runner never told the harness this instance's
  endpoint or key, so every call failed (wrong port, or 401), and an all-error run was still
  recorded as a completed 0% score on the leaderboard. The harness now targets `WS_PORT` with the
  internal model token (passed in the environment, not argv), an all-error run is `failed` with
  the first error, and the leaderboard skips runs that answered nothing.
- Passthru to the Claude 5 family dropped no sampling parameters, so any OpenAI client sending
  `temperature` (other than 1) or `top_p` got a 400. The translated path now omits both.
- Crew dispatches are directed work: `[crew-task]` messages score 90 in the
  social scorer (above the channel-reply cooldown cutoff, below tells) instead
  of 40 as ambient chatter, so idle crews now pick up project tasks.
- The pending-request reminder names the channel explicitly; the previous
  "reply on this channel" phrasing led agents to run `channel send {json}`
  with the JSON parsed as the channel name. `channel send` now returns a
  specific correction when the channel name is omitted, and the channel tool
  schema marks it required.
- Benchmark answer extraction repairs JSON-escape-mangled LaTeX (`\boxed`,
  `\frac` arriving as backspace/formfeed control characters) before matching, so
  correct answers are no longer scored wrong.
- Crew deposit-fallback timers can no longer fire into a closed database.
  `Engine.stop()` tears down crew timers even when the engine was never
  started, a timer that outlives its channel store degrades to a logged
  warning instead of an unhandled throw, and the schedule is injectable for
  tests. This leak surfaced as "Database has closed" errors between unrelated
  test files, failing the suite with zero failing tests.

### Security

- Docker builds no longer copy `<DB_PATH>.key-secret`, `<DB_PATH>.local-api-key` or database
  backups into the image, and `.gitignore` covers them (#341, #374).
- The local API key is accepted only under the `local` trust profile; MCP Host validation fails
  closed on a non-loopback bind without `MARINA_MCP_ALLOWED_HOSTS`.
- Code Mode containers mount `.git` read-only and every host git call is hardened against planted
  hooks, fsmonitor and diff drivers (#283).
- Dependency upgrades for CVE-2026-104850 (MCP client, #333), `http-cache-semantics` (#319),
  `fast-uri` and `ip-address`; the image scan refreshes the OS security layer daily (#196).

## [0.7.0] — 2026-09-01

This release pairs the open-ended cognitive ecology and the August
observability/CLI/Flywheel waves with a full security-and-correctness audit of
everything shipped since 0.6.0. Every audit finding — high, medium, and low —
was fixed, independently re-verified, and regression-tested (2,885 backend +
245 dashboard tests).

### Added

- Open-ended cognitive ecology: journeys and desires, portable intellect
  identity, open associations, genome/mutation/reproduction lineage,
  transparent multi-mesh federation, asset-neutral economic provenance,
  simulation labs, and an opt-in hash-chained cognitive-provenance ledger
  (migrations 83–94, 12 new commands).
- End-to-end execution tracing with span projection, judgments ledger,
  eval-json/OTLP export, `/api/traces`, the rank-0 `trace` command, and
  opt-in trace-informed adaptive routing.
- Folder-first coding CLI with per-folder session resume, one-shot `-p` mode
  with exit codes, and opt-in per-session git-worktree isolation.
- Flywheel sandbox functional slices M1–M5: durable reconciliation, explicit
  session routing, sandbox projects with bounded transfer, managed services
  with probe/screenshot/publish, and production gates.
- Focused single-outcome worlds (prediction-lab, deep-research, red-team,
  due-diligence, data-investigation) and the world-collective control plane
  for spawning and managing descendant Marina instances.

### Security

- Every listener now binds loopback by default. The real-time log viewer
  (which streamed entity movement and full chat text on `0.0.0.0` with no
  authentication) and the telnet server honor the same
  `WS_HOST`/`MARINA_PUBLIC` opt-in as WebSocket and MCP; `scripts/start.sh`
  no longer enables telnet implicitly.
- Container posture aligned with the source defaults: the image no longer
  ships or exposes telnet, the unauthenticated log viewer is no longer
  `EXPOSE`d, and docker-compose publishes all ports to the host's
  `127.0.0.1` unless the operator deliberately widens them.
- Cross-world mesh replication is signed-by-default: unsigned events are
  refused (opt-in via `MARINA_FEDERATION_ALLOW_UNSIGNED` for trusted dev
  networks), origin worlds registered in `federation_peers` are checked
  against their pinned public key and trust status, refused replications
  write nothing, and manifest re-registration can no longer silently rotate
  a pinned key.
- The paper-trading order ledger is protected as the security control it is:
  the `paper-orders`/`paper-proposals` boards require rank 5 to post, closing
  rank-0 forgery of close orders that could mint profit past the daily-loss
  floor or defeat the no-self-hedge invariant. The daily-loss floor itself is
  now enforced (close-realized losses since UTC midnight, average-cost basis).
- Rank-0 CPU exhaustion closed: Ed25519 verification is capped in
  `association`/`economy`/`intellect` inspection and `provenance verify`, and
  the evidence-chain check backing the unauthenticated federation discovery
  routes verifies a bounded window instead of rehashing the full table.
- `desire` treats participant input as data (untrusted-context wrapping, same
  rule as `ask`/`dig`) and rate-limits its model pass per entity; canvas
  remote-URL uploads use pinned-resolution fetching (closing a DNS-rebinding
  TOCTOU) with a streamed 50 MB cap; a crafted `?traceId` can no longer
  poison the `/api/traces` projection cache.
- Updated vulnerable transitive HTTP, URL parsing, IP address, WebSocket, and
  protobuf dependencies. Upgraded optional better-auth support to the patched
  1.7 line and added an automatic, backward-compatible issuer migration for
  auth databases created by Marina 0.6.0.

### Fixed

- `marina-descend` shares one collective manager per database, so descendant
  Marina processes can be stopped again (previously orphaned holding four
  ports), live variants are no longer marked failed by unrelated commands,
  and double-spawns are blocked. Descendants no longer inherit a telnet port.
- Ecology event replay is deterministic and VACUUM-safe: migration 94 adds
  monotonic `seq` ordering to the seven ecology event tables (same-millisecond
  events previously misordered under UUID ordering, and implicit-rowid
  ordering could silently flip participant state after `VACUUM`). Snapshot
  imports from pre-0.7.0 exports are backfilled.
- Corrupt stored JSON can no longer crash rank-0 commands (`provenance
  verify`, `mesh export`, genome/mutation/reproduction inspection); intellect
  lifecycle signatures bind their row id so a valid signature cannot be
  replayed onto another row; explicit SQL parameter lists replace
  order-fragile positional binding.
- Selector resolution for associations, intellects, and meshes searches the
  whole table (bounded SQL prefix lookup) instead of a capped scan that
  silently missed older rows; binary canvas assets survive remote upload
  byte-accurately.

### Performance

- The durable event log is bounded: streaming token deltas and tick events
  are no longer written to SQLite (previously one synchronous INSERT per
  token chunk per agent), and the log is pruned hourly to a configurable
  retention (`MARINA_EVENT_RETENTION`).
- Trace consumers stopped rescanning: expression indexes plus
  `MAX(event_log.id)`-keyed memoization for adaptive routing and
  `/api/traces`; OTLP export fetches each flush in one indexed batch instead
  of up to 1,000 five-thousand-row scans; trace judgments load per page in a
  single query.
- The Responses API record index is size-capped with oldest-first eviction;
  the dashboard snapshot reads agent configs in one bulk query; hourly
  maintenance jobs are staggered across distinct tick phases; `journey list`,
  mesh event lookup, passthru context injection, and per-perception agent
  hot paths shed their N+1 queries and redundant work; cognitive provenance
  no longer writes a signed row per streamed token.

### Changed

- Refined the README, documentation landing page, GitHub Pages metadata, and contribution
  templates for the public release. Corrected the Pages project base path and aligned prominent
  feature claims with tested repository behavior.
- Made the dashboard the default browser entry point, moved the compact web client to `/chat`, and
  added a first-run Start Here card with direct login, orientation, and next-action guidance.
- Completed the local Electrobun dashboard bridge for clickable API-key management, live model and
  role discovery, default-model selection, and agent launch, attention, and stop actions.

## [0.6.0] — 2026-08-18

First public release under the Apache License 2.0.

### Added

- CI workflow (lint, typecheck, backend tests, dashboard test/build on every PR and push), issue
  templates, and a pull-request template.
- A friendly setup page (HTTP 503) at `/dashboard`, `/canvas`, and `/who/*` when the dashboard
  bundle hasn't been built yet, plus a boot-time warning with the build command. Previously a
  fresh clone got an opaque 500. `bun run dashboard:build` now installs dashboard dependencies
  first, so it works from a bare checkout.
- Read-only native-evolution qualification, a dedicated MCP evolution tool, and a bounded soak gate
  with machine-readable connection, error, throughput, and p95 latency evidence.
- Expandable evolution lineage/evidence telemetry, self-contained three-role live trials, and
  reconnect/session-token churn qualification.
- Durable provenance-aware contradiction cases spanning agents and shared memory pools, with
  `left`, `right`, `both`, and `neither` resolution modes, reviewer rationale, verification history,
  terminal commands, and dashboard APIs.
- Outcome-based attention learning from approved, rejected, and expired task claims. Adjustments are
  bounded, durable, and idempotent; explicit operator feedback remains supported.
- Outcome-level productivity sessions measuring success, completion latency, tool-call effort,
  direct-message handoffs, seven-day throughput, daily trends, and per-agent leaderboards.
- `productivity` / `impact` commands, productivity and contradiction APIs, and operational dashboard
  summaries for outcome performance and open conflicts.
- A persistent dashboard alert indicator, graphical readiness and productivity views, filtered alert
  history, in-place contradiction resolution, selectable map layers, event heatmap access, and
  spatial warning/critical markers.
- Privacy-safe primitive-use evidence for humans and agents, including canonical command success and
  latency, agent tool provenance, outcome correlation, readiness checks, and dashboard leaderboards.

### Changed

- Pre-release audit pass: README/guide commands verified against the engine (removed or corrected
  stale command references), world descriptions updated for the default Workbench world,
  `docker-compose.yml` defaults to a local image build, MCP handshake reports the real package
  version, and `.env.example` gained the qualification/trial-harness variables.
- **Relicensed from MIT to Apache License 2.0.** The `LICENSE` file now contains the canonical
  Apache-2.0 text, a `NOTICE` file has been added, and all license references (package manifests,
  README, CONTRIBUTING, site, docs) point to Apache-2.0. The Apache license adds an express patent
  grant and requires modified files to carry change notices. All source files now carry an
  SPDX-License-Identifier header, and the SDK package ships its own LICENSE/NOTICE copies.
- Agent runtime port configuration now preserves the runtime referenced by command handlers, and
  spawn rejects names that world login would otherwise truncate into a different identity.
- Reworked the model-agnostic pi-agent system contract around outcome framing, selective retrieval,
  deliberate tool use, result verification, durable provenance, explicit stopping/replanning, and
  equal treatment of humans and opportunistic agents. Dynamic world, memory, transcript, and tool
  content is now explicitly kept below governing instructions.
- Compaction now preserves objective, success criteria, evidence, decisions, commitments, plan state,
  failures, contradictions, and next action. Silent-turn and stuck recovery no longer manufacture
  `think`, observation, movement, or notes merely to produce activity.
- Memory quality alerts now use durable shared contradiction cases at world scope and retain richer
  typed provenance and verification rationale.
- Agent prompt versions are content-addressed and attributed to primitive use and terminal outcomes;
  the Ops dashboard and `productivity prompts` compare cohorts without retaining content.
- Readiness now qualifies live autonomy from multi-agent primitive use, communication, Marina tool
  calls, and latency. `/api/connect` advertises capability layers, trust boundaries, and tool-risk
  classes for model-agnostic opportunistic agents.
- Crew creation now issues durable, expiring invitations; agents explicitly join or decline rather
  than being conscripted by a creator.
- Tool calls carry risk class and privacy-safe trust-source lineage. The reference monitor blocks
  untrusted policy-bypass requests while Marina's existing gates remain authoritative.
- The persistence schema is now version 62; exports include contradiction cases, productivity
  sessions, crew invitations, prompt token/cost attribution, and primitive-use evidence. Evidence
  never retains command arguments or tool payloads.

## [0.5.0] — 2026-06-05

### Added

- **Instance-wide login cap** — `MARINA_MAX_LOGINS` limits the total number of
  concurrently logged-in (entity-bound) connections on an instance
  (`0`/unset = unlimited). Enforced centrally in `engine.login()`/`reconnect()`
  so every surface — WebSocket, telnet, MCP — is covered, including the
  post-restart re-attach branch and grace-window reconnects.
- **Login-attempt rate limiting** — `MARINA_LOGIN_ATTEMPTS_PER_MIN` throttles
  login/reconnect attempts per client IP (token bucket; default 10/min,
  `0` = disabled; falls back to per-connection keying when IP is unavailable,
  e.g. MCP sessions). Login was previously unthrottled despite being
  passwordless-by-name; failed attempts consume budget too.
- **Internal-agent exemption** — room/crew agents authenticate with the
  process-local internal token (new `internalToken` option on `MarinaClient`,
  passed automatically by the agent runtime). Internal connections are exempt
  from both limits and excluded from the cap denominator, so a low cap never
  breaks world population; agents remain bounded by `MAX_AGENTS`.

### Changed

- `Connection` gains optional `ip` and `internal` fields; the constant-time
  `secretsEqual` compare moved from the WebSocket server into shared
  `src/auth/secret-compare.ts`.

## [0.4.2] and earlier

Initial open-source release line: world engine with civic substrate (standing,
rank, safety gates), agent cognitive architecture, Chronicle, canvas intent
system, resolvers/watchers/calibration, orchestration patterns, benchmark
runner, TabH2O integration, drop-in compat surfaces (OpenAI, Ollama, ACP), and
the live-visualization dashboard. The `hermes`/`openclaw` migration worlds and
their third-party aliases were removed in 0.4.2.

[Unreleased]: https://github.com/h2oai/marina/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/h2oai/marina/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/h2oai/marina/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/h2oai/marina/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/h2oai/marina/releases/tag/v0.5.0
