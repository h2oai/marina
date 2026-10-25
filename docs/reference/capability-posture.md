# Capability posture

Generated from `src/config/capability-posture.ts` by `bun run docs:api`. Do not edit by hand.

Every non-core feature in the [feature status](feature-status.md) table and every `MARINA_*`
setting whose documented default is `off`, `observe` or `false` has one posture:

| Posture | Meaning |
|---|---|
| measure | Waiting on evidence. The entry names where that evidence lands and the date by which it is promoted, kept with a new date, or reclassified. |
| by-design | Off on purpose (security, spend, an external account, a deployment shape, a demo or an alias). No deadline. |

In the world, `posture` lists each entry with its current value, the last time its evidence
source recorded anything, and the days left before its date; the `capability-posture` readiness
line is degraded while any date has passed. The dates are development deadlines; informational
on installs: that line is optional and never raises an alert. `test/capability-posture.test.ts`
fails when a new
off-by-default setting has no entry.

## Measure (66)

| Subject | Evidence | Promote when | Decide by |
|---|---|---|---|
| Orchestration › one free-text task (`pattern run`, `POST /v1/patterns/run`) | benchmark ledger (any board) | a paired `benchmark compare-run` wins on the board against the single-model control | 2026-12-01 |
| Orchestration › a room's turn rule (formations in a room) | operator choice: never automatic | a world runs a room formation in live work | 2027-01-15 |
| Forecast pipeline | outcomes kind forecast | resolved forecasts beat the plain-model baseline outside the arena | 2026-12-01 |
| Quant helpers, data lookups, read swarm | benchmark ledger forecastbench-backtest | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| Research evidence loop and survey | benchmark ledger forecastbench-backtest | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| Research web agent, cited answers, fact pass | outcomes source research:ask | cited answers are accepted in live work as often as uncited ones | 2026-12-01 |
| Resolvers, probes and watches | operator choice: never automatic | a second subsystem resolves its own outcomes through a resolver | 2027-01-15 |
| Adaptive load-balance routing | operator choice: never automatic | judged traces show adaptive picks beat least-busy | 2027-01-15 |
| Benchmark route evidence for `model:route` | benchmark ledger (any board) | a route chosen from ledger evidence wins its role's board | 2026-11-15 |
| Earned forecast routing | outcomes kind forecast | routed formations beat the default formation on resolved history | 2026-12-01 |
| Attention judges | judge ledger surface attention: | the judge earns on its surface (`judge stats`), then `on` | 2026-12-01 |
| Peer code review | outcomes source code:verify | reviewed attempts pass their checks more often than unreviewed ones | 2026-12-01 |
| Research authority mode | benchmark ledger futurex-past-clean | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| The Arbiter | judge ledger surface arbiter | overrule precision clears the earned bar | 2026-12-01 |
| Forecasts by residents (as-of fence) | outcomes kind forecast | resident-answered forecasts score at least as well as the model panel | 2027-01-15 |
| Hybrid and vector retrieval | benchmark ledger longmemeval-v2-small | a paired run on the memory board wins without a retrieval regression | 2026-12-01 |
| Typed resident analysis tools (`marina_forecast`, `marina_research`, `marina_swarm`, `marina_data`, `marina_quant`, `marina_calc`, `marina_decision_check`, `marina_triage`, `marina_arbiter`, `marina_pattern`) | benchmark ledger (any board) | a paired `benchmark compare-run` wins on the board with the tools resident vs deferred | 2026-12-01 |
| Investigations | operator choice: never automatic | investigations run in live work | 2027-01-15 |
| Schedules | operator choice: never automatic | people or agents keep schedules running in live work | 2026-11-15 |
| Evolution (coach, native protocols, `marina_evolve`, child worlds) | operator choice: never automatic | an evolve trial's adopted role beats its parent in a child world | 2027-01-15 |
| Experiments | operator choice: never automatic | replicated experiments run in live work | 2027-01-15 |
| Markets and positions | outcomes source market | paper positions resolve with positive calibrated edge | 2027-01-15 |
| Learned bundles | operator choice: never automatic | an imported bundle's lessons are served and a fresh install uses them | 2026-12-01 |
| Intellect records (identity across models and processes, lifecycle claims) | operator choice: never automatic | a world uses the records in live work (core) or nothing does (deprecate) | 2027-01-15 |
| Lineage records (derived intellects, world manifests, child worlds) | operator choice: never automatic | a world uses the records in live work (core) or nothing does (deprecate) | 2027-01-15 |
| Change records (`mutation`) | operator choice: never automatic | a world uses the records in live work (core) or nothing does (deprecate) | 2027-01-15 |
| Associations (who takes part and how they relate) | operator choice: never automatic | a world uses the records in live work (core) or nothing does (deprecate) | 2027-01-15 |
| Economic provenance records | operator choice: never automatic | a world uses the records in live work (core) or nothing does (deprecate) | 2027-01-15 |
| Simulation run records (`lab`) | operator choice: never automatic | a world uses the records in live work (core) or nothing does (deprecate) | 2027-01-15 |
| Scores (`conduct`, `marina_conduct`) | benchmark ledger (any board) | a paired `benchmark compare-run` wins on the board against the same crew without a Score | 2027-01-15 |
| Scenario boards | operator choice: never automatic | a world uses the records in live work (core) or nothing does (deprecate) | 2027-01-15 |
| `MARINA_AGENT_THINKING` | benchmark ledger (any board) | a paired `benchmark compare-run` wins on the board on cost per success | 2026-12-01 |
| `MARINA_ANTHROPIC_AUTO_CACHE` | benchmark ledger (any board) | a paired `benchmark compare-run` wins on the board on cost per success | 2026-11-15 |
| `MARINA_ARENA_EVIDENCE_REFRESH` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ARENA_FORMATION_LESSONS` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ARENA_NOWCAST_HORIZON` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ARENA_RESEARCH_LESSONS` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ARENA_RESEARCH_LOOKUPS` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ARENA_RESEARCH_REQUIRED` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ARENA_RESEARCH_SIGNALS` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ARENA_TRENDS_PARTIAL` | outcomes source arena: | a lock-ordered arena backtest beats the incumbent on mean per-round skill | 2027-01-15 |
| `MARINA_ATTENTION_JUDGE` | judge ledger surface attention: | the judge earns on its surface (`judge stats`), then `on` | 2026-12-01 |
| `MARINA_CHALLENGE_JUDGE` | judge ledger surface challenge | the judge earns on its surface (`judge stats`), then `on` | 2026-12-01 |
| `MARINA_CREW_DELIVERABLE_REVIEW` | outcomes source task:verdict | reviewed crew deliverables are approved more often by their creators | 2026-12-01 |
| `MARINA_DECISION_VERIFY` | judge ledger surface verify | the judge earns on its surface (`judge stats`), then `on` | 2026-11-15 |
| `MARINA_EVOLUTION_PROTOCOLS` | operator choice: never automatic | an evolve trial's adopted role beats its parent in a child world | 2027-01-15 |
| `MARINA_FORECAST_ARBITER` | judge ledger surface arbiter | overrule precision clears the Arbiter's earned bar | 2026-12-01 |
| `MARINA_FORECAST_CONTRACT` | benchmark ledger futurex-past-clean | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| `MARINA_FORECAST_QUANT` | benchmark ledger forecastbench-backtest | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| `MARINA_FORECAST_RESIDENTS` | outcomes kind forecast | resident-answered forecasts score at least as well as the model panel | 2027-01-15 |
| `MARINA_FORECAST_SHADOW` | operator choice: never automatic | an operator accepts the daily spend for paired live evidence | 2026-11-15 |
| `MARINA_FORECAST_TRIAGE` | benchmark ledger futurex-past-clean | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| `MARINA_JUDGE` | judge ledger (every surface) | the judge earns on its surface (`judge stats`), then `on` | 2026-12-01 |
| `MARINA_MEDIA_VERIFY` | operator choice: never automatic | the verifier's labels agree with a person's review of generated images | 2027-01-15 |
| `MARINA_MEMORY_CONTEXT_VALUE` | benchmark ledger longmemeval-v2-small | a paired run on the memory board wins without a retrieval regression | 2026-12-01 |
| `MARINA_MEMORY_INGEST_NOTES` | benchmark ledger longmemeval-v2-small | a paired run on the memory board wins without a retrieval regression | 2026-12-01 |
| `MARINA_MEMORY_RANKING` | benchmark ledger longmemeval-v2-small | a paired run on the memory board wins without a retrieval regression | 2026-12-01 |
| `MARINA_MEMORY_RELEVANCE_GATE` | benchmark ledger longmemeval-v2-small | a paired run on the memory board wins without a retrieval regression | 2026-12-01 |
| `MARINA_OBLIGATIONS_CONSENT` | benchmark ledger tau2-airline | a paired `benchmark compare-run` wins on the board | 2026-12-01 |
| `MARINA_PEER_REPLY_CHAIN` | judge ledger surface attention: | the converge judge earns and long exchanges end without lost work | 2026-12-01 |
| `MARINA_RESEARCH_ADVICE` | benchmark ledger frames | a paired `benchmark compare-run` wins on the board | 2026-12-01 |
| `MARINA_RESEARCH_AUTHORITY` | benchmark ledger futurex-past-clean | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| `MARINA_RESEARCH_EVIDENCE` | benchmark ledger forecastbench-backtest | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| `MARINA_RESEARCH_TARGET_EVIDENCE` | benchmark ledger forecastbench-backtest | a held-out forecast backtest wins by the promotion margin | 2026-12-01 |
| `MARINA_ROUTE_EVIDENCE_WINDOW` | outcomes (any) | live-work evidence picks the same or better models as the benchmark ledger | 2026-12-01 |
| `MARINA_VERIFY_ARBITER` | judge ledger surface arbiter | overrule precision clears the Arbiter's earned bar | 2026-12-01 |

## By design (40)

| Subject | Reason |
|---|---|
| Orchestration › projects (pool notes generated from the catalogue) | a demo surface for the catalogue |
| Orchestration › legacy names (`nsed`, `custom`) | compatibility aliases |
| Canvas | a view surface; its status follows use, not a measurement |
| Social Simulation Arena (routed forecaster, shadow challengers) | one external competition; filing is an operator act |
| Benchmarks | an operator's instrument; benchmarks never become defaults |
| TabH2O | needs an external account key |
| Embedding lifecycle (data dir, endpoint file, idle shutdown, parent watch) | for embedding hosts only |
| OpenShell sandbox provider | needs an operator-run gateway |
| Shared spend ledger | a deployment shape an operator chooses |
| Private rooms | an owner's choice per room; public is the default |
| H2O-Lightning decision preset | needs an operator-chosen model id |
| Federation (gateways, meshes) | needs a peer instance and a shared secret |
| Media generation jobs | needs a media-capable provider |
| Built-in worlds other than `default` and `empty` (13) | demo worlds |
| `MARINA_HOST` | deprecated alias of `WS_HOST` |
| `MARINA_AGENT_CACHE_KEEPALIVE` | spends tokens on idle pings; worth it only for known traffic |
| `MARINA_ALLOW_INSECURE_PUBLIC` | acknowledges an unauthenticated non-loopback bind |
| `MARINA_ARENA_AUTOPILOT` | filing an external competition is an operator act |
| `MARINA_CODE_CONTAINER_MODEL_API` | container egress to the model API is an operator's choice |
| `MARINA_CODE_CONTAINER_NETWORK` | container egress is an operator's sandbox choice |
| `MARINA_COGNITIVE_PROVENANCE` | records full payloads; privacy cost by default |
| `MARINA_CORPUS_EMBEDDING_LOCAL_ONLY` | a restriction an operator adds to the embedder |
| `MARINA_DECISION_GATE` | a fail-closed restriction an operator adds, never by evidence |
| `MARINA_FEDERATION_ALLOW_UNSIGNED` | accepts events whose origin cannot be verified |
| `MARINA_MEMORY_EMBEDDING_LOCAL_ONLY` | a restriction an operator adds to the embedder |
| `MARINA_MODEL_ROUTE_FALLBACK` | moves library calls (data and spend) to another route |
| `MARINA_OPEN_API` | development only: unauthenticated API access |
| `MARINA_OPS_NOTIFY` | needs an operator-supplied destination |
| `MARINA_OTLP_ALLOW_INSECURE` | plaintext export to a remote collector |
| `MARINA_OTLP_ENABLED` | needs an operator-run collector |
| `MARINA_OTLP_LOGS_ENABLED` | needs an operator-run collector |
| `MARINA_PASSTHRU_RESPONSE_CACHE` | replays an earlier answer; the caller opts in |
| `MARINA_PERCEIVE_SELF_ECHO` | a debugging aid; on puts self-echo noise back in perceptions |
| `MARINA_PUBLIC` | network exposure is the operator's choice; loopback by default |
| `MARINA_SEED_SKILLS` | a showcase-world seed option |
| `MARINA_SINGLE_PORT` | a deployment shape, not a capability |
| `MARINA_TRADING_ENABLED` | live orders move money; operator-grant `trading.live` |
| `MARINA_TRUST_PROXY` | trusting X-Forwarded-For is safe only behind a known proxy |
| `MARINA_UNIFIED_CANVAS` | a retired view kept reachable |
| `MARINA_URL_GUARD_DNS_FAIL_OPEN` | weakens the SSRF guard; restricted-DNS hosts only |
