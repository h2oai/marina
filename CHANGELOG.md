# Changelog

All notable changes to Marina are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
