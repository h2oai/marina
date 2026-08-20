# Changelog

All notable changes to Marina are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Refined the README, documentation landing page, GitHub Pages metadata, and contribution
  templates for the public release. Corrected the Pages project base path and aligned prominent
  feature claims with tested repository behavior.
- Made the dashboard the default browser entry point, moved the compact web client to `/chat`, and
  added a first-run Start Here card with direct login, orientation, and next-action guidance.
- Completed the local Electrobun dashboard bridge for clickable API-key management, live model and
  role discovery, default-model selection, and agent launch, attention, and stop actions.

### Security

- Updated vulnerable transitive HTTP, URL parsing, IP address, WebSocket, and protobuf
  dependencies. Upgraded optional better-auth support to the patched 1.7 line and added an
  automatic, backward-compatible issuer migration for auth databases created by Marina 0.6.0.

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
