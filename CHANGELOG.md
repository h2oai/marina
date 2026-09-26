# Changelog

All notable changes to Marina are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  don't redo". Measured duplicate deposits per task fell from ~3x to ~1x.
- `PATTERN_VALIDATION` records per-pattern sweep evidence beside
  `PATTERN_FIT`; `project recommend` tags each suggestion
  `[validated|partial|unvalidated]`. After the fix stack landed, all ten
  patterns are validated (every formation answers 10/10 on gsm8k; all seven
  habitat-tested formations complete 3/3 project tasks).
- Councilor, Debater, and Decomposer traits teach the explicit RESPONSE
  PROTOCOL envelope (seed-guarded — fresh worlds only).

### Changed

- `inherit` and `inheritance` merged into one `inheritance` command
  (`list | export <pool> | import <token>`); `inherit <token>` survives as an
  alias routed to `import`, which keeps its rank-2 floor.
- `ask`, `recap`, and `dig` share one retrieval core
  (`src/engine/commands/retrieval-core.ts`) for source gathering and the
  group-pool privacy guard; rendering stays per verb, and `dig` still grounds
  on personal + guide notes only.

### Fixed

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
  `\frac` arriving as backspace/formfeed control characters) before matching;
  a 9/10-correct gsm8k run previously scored 10%.
- Crew deposit-fallback timers can no longer fire into a closed database.
  `Engine.stop()` tears down crew timers even when the engine was never
  started, a timer that outlives its channel store degrades to a logged
  warning instead of an unhandled throw, and the schedule is injectable for
  tests. This leak surfaced as "Database has closed" errors between unrelated
  test files, failing the suite with zero failing tests.

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
