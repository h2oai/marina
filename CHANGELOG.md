# Changelog

All notable changes to Marina are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
