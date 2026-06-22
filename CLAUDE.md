# Marina — Claude Code Conventions

## Build & Test
```bash
bun run start          # Start server
bun run test           # Run all backend tests (~81 files, ~2200 tests)
bun run typecheck      # TypeScript strict check
bun run lint           # Biome lint
bun run format         # Biome auto-format (run before committing)
bun run clean          # Reset database and scratch files
cd dashboard && bun run test  # Frontend smoke tests (vitest, ~24 tests)
```

## Code Style
- **Formatter**: Biome — line width 100, indent 2 spaces
- **Imports**: alphabetical by path (biome organizeImports)
- **Types**: branded `EntityId`, `RoomId` — cast in tests: `"e_1" as EntityId`
- **Entity properties**: use `KnownProperties` interface — typed optional fields for rank, quest state, benchmarks, etc.
- **Errors**: use `getErrorMessage()` for extraction, `tryLog()` for non-critical DB ops
- **DB table**: `groups_` not `groups` (SQL keyword)
- **Memory tiers** (migration 37): every note has `tier ENUM('fact','reflection','skill','core','process')`. `recall*` helpers default to fact-like tiers; `process` is excluded unless `includeProcess: true`. `[compaction]`-prefixed notes auto-infer to `process`. `createNote` dedups on exact `(entity, note_type, content)` within fact-like tiers. Per-entity `process` cap = `PROCESS_TIER_QUOTA` (500), evicted on write when over cap.
- **FTS5**: add insert/update/delete triggers when creating FTS tables
- **Tests**: use helpers from `test/helpers.ts` (MockConnection, stripAnsi, cleanupDb)
- **Dashboard animations**: motion (`motion/react`) — use `<AnimatePresence>` for mount/exit, `motion.*` for declarative anims, `useMotionValue` + `useTransform` for realtime-driven values without React re-renders, `layoutId` for shared element transitions. See `dashboard/src/components/AnimatedNumber.tsx` for the count-up pattern.

## Architecture Rules
- Commands: one file per command in `src/engine/commands/`, register in `src/engine/command-registry.ts` → `registerBuiltinCommands()`
- Migrations: append to `migrations` array in `src/persistence/database.ts`, never modify existing migrations
- DB modules: query logic split into `src/persistence/db-notes.ts`, `db-entities.ts`, `db-tasks.ts`, `db-channels.ts`, `db-agents.ts` — MarinaDB delegates to standalone functions
- MCP tools: add in `src/net/mcp-server.ts` → `createMcpServer()`, use `runCmd()` helper (rate-limited wrapper around `cmdTool()`)
- MCP tool categories: bootstrap (login/auth), cognition (think/memory/next/brief/quest), world, coordination, canvas (canvas), building, escape hatch (command/batch), session
- Engine decomposed: `ConnectionManager`, `EventLog`, `BriefManager` extracted from Engine class
- Room handlers get `RoomContext`, built-in commands get `CommandContext` (extends with mcp/http/notes/memory/pool)
- `minRank` on `CommandDef` is the permission gate — don't add custom rank checks in handlers
- Command queue: per-entity round-robin processing (fair-share scheduling)
- Tick budget: room onTick handlers must complete within 200ms total
- Non-critical DB operations should be wrapped in `tryLog()` or `tryLogAsync()`

## Civic Substrate — Standing, Rank, and Safety Gates
- **Single blended metric**: `standing` is the only contribution score. It absorbs task completion, pool note deposits, crew leadership, helping acts, and recalled reflections via `src/agent/standing.ts` (`record`, `getStanding`). Decay is exponential with a 60-day half-life; floor at 0 (no negative scores — exclusion is a separate civic procedure).
- **Storage**: `entity_standing` is a generic event ledger keyed `(entity_id, kind, ref)`; `entity_standing_cache` rolls up the decayed value. Permission checks read the cache (6h TTL); periodic `recomputeAll()` refreshes via the engine tick.
- **Rank derivation (rank 0–4 only)**: thresholds 5 / 15 / 40 / 100 standing for ranks 1 / 2 / 3 / 4. Rank is *descriptive* — your standing crosses a threshold and the system observes "you're an organizer." Demotion is the natural consequence of decay.
- **Above the safety threshold (rank 4)**: standing keeps accruing but does NOT auto-promote. Engineers / stewards / guardians / sovereigns are honorifics, not progression states. Capability above the threshold is gated by per-operation **safety gates**, not tier numbers.
- **Safety gates** (`src/engine/safety-gates.ts`): 9 gated operations (`shell.exec`, `code.exec`, `agent.run`, `agent.spawn`, `adapter.enable`, `connect.manage`, `gateway.connect`, `key.manage`, `admin.destructive`). Each requires (a) sufficient standing and (b) an unsupervised competence row in `entity_competence`. First N attempts are supervised-only; threshold demonstrations flip to unsupervised. Operators bootstrap via `safetyGates.grant(db, entityId, gateId)` from world seeds — no rank shortcut. `code.exec` (minStanding 5) gates the `code` command's host-execution / workspace-mutation subcommands (run/verify/test/lint/typecheck/recipe/apply/revert) so a rank-0 agent can't reach arbitrary host code execution via `code apply` + `code run`; read/inspect/propose stay rank 0.
- **`CommandDef.gate`** field: when set, the engine command-router checks the gate after `minRank`. Migrated commands use `{ minRank: 5, gate: "<id>" }`. Seven gates wire this way; `agent.spawn` and `code.exec` are the exceptions — both are enforced **imperatively** rather than via the declarative field. `agent.spawn` gates a *subcommand* (`agent spawn`, while `agent list/stop` stay rank 0) and the spawn flow needs the gate result (`supervisedOnly`) for its demonstration-recording loop (`agent.ts`); `code.exec` is checked in `code.ts` before the exec/mutate subcommands (the `code` command itself is rank 0 so read/inspect stay open).
- **`standing` command**: agent-facing introspection — `standing` (own ledger), `standing show <name>`, `standing top [N]` (leaderboard).
- **Engine integration**: `applyRankProgression()` runs hourly for online entities; pure threshold lookup, no metric scoring.

## Chronicle — Canonical Record of the Marina
- **Append-only civic history** parallel to `feed_events` (7-day ephemeral) and `notes` (entity-owned). Engine auto-emits on canonical happenings (task_approved, crew lifecycle, market_consensus, rank_change); the Chronicler agent writes narrative + digest entries on top, citing source ids. See `docs/chronicle.md` for the full design.
- **Schema** (`chronicle` table, migration 41): `id`, `created_at`, `kind`, `source`, `title`, `body`, `participants` JSON, `refs` JSON, `period`, `supersedes`. Four kinds: `event` (engine, immutable), `narrative` (Chronicler synthesis), `digest` (period summary), `correction` (supersedes a prior narrative/digest — original untouched).
- **Persistence**: `src/persistence/db-chronicle.ts` (`appendChronicle`, `queryChronicle`, `getChronicleEntry`, `getCorrectionsFor`). `queryChronicle` supports `since`, `until`, `kind`, `source`, `participant` (JSON-quoted substring match), `period`, `like` (title-OR-body substring), `limit`.
- **Read commands** (rank 0): `chronicle`, `chronicle show <id>`, `chronicle since <dur>`, `chronicle about <name>`, `chronicle kinds`, `chronicle pending [since <dur>]` (the Chronicler's work queue — events since last narrative/digest cursor + 1ms).
- **Write commands** (`entity.properties.role === "chronicler"` only): `chronicle record <title> | <body> refs <ids> [participants <names>]` (requires ≥1 ref), `chronicle correct <id> <title> | <body>` (refuses correction of `event` entries), `chronicle digest day|week <title> | <body> [period <token>]` (auto-derives `day:YYYY-MM-DD` / `week:YYYY-Www` if unset).
- **Chronicler agent** (`worlds/seed.ts seedChroniclerRole + seedChroniclerAgent`): `chronicling` trait + `chronicler` role + persistent agent config. Default world opts in. Trait prompt teaches interview discipline — one `tell` per cycle, never the same agent twice within ~5 cycles, track via own `memory set last_interview:<name>`.
- **Citation flows standing**: `chronicled` StandingKind in `src/agent/standing.ts` with kind-weighted credits (`event=0.25`, `narrative=2.0`, `digest=1.0`, `correction=0.5`). Idempotent via `ref=chronicle:<id>`. Wired in `FeedPublisher.recordChronicleEvent` and the chronicle write commands; both take a `resolveEntityIdByName` dep — when absent, citation discipline still works but standing doesn't flow.
- **Cognitive integration**: `recap chronicle [day|week]` is a retrieval lens grouped by kind; `recap <topic>` and `ask <topic>` include a Chronicle section showing entries whose title or body matches; `ask` forwards them to model context as `[chronicle:<kind>:<id>] <title> — <body>`.
- **Arrival digest**: `sendBootstrap` in `src/engine/commands/brief.ts` appends a "Recent chronicle" section with up to 3 recent narrative/digest entries on first login. Events excluded (templated, noisy). Section omitted when chronicle has no synthesis yet.
- **`/who/<name>` public pages** (`dashboard/src/who/`, `src/net/entity-api.ts`): per-entity blog/wiki view backed by `GET /api/entity/:name/profile`. Composes chronicle + standing + entity_activity + entity_competence into identity / bio / narratives / achievements / stats / connections. Read-only, no auth, 30s `Cache-Control`. Achievements computed on-the-fly (rank crossings, standing thresholds, first chronicled narrative, gate competence demos, days-active + citation bands). Connections cross-link to other `/who` pages — social graph from chronicle co-participation. Sigil = deterministic 5×5 mirrored identicon from name hash.

## Room Agents
- **Room agents**: LLM-connected agents spawned by the world via `ctx.spawnRoomAgent()` in room `onEnter` handlers
- **Self-referential**: Room agents use model `marina/default` which calls the local `/v1/chat/completions` endpoint. The model API proxies upstream to configured providers (Anthropic, OpenAI, etc.)
- **Internal auth**: Room agents authenticate via an auto-generated internal token — no MARINA_OPEN_API needed
- **Graceful degradation**: If no upstream API keys configured, rooms fall back to static entities (no LLM connection)
- **Lazy spawning**: Room agents only spawn when someone enters a room (onEnter), not on tick
- **Room affinity**: Agent config stores `room` field; agents are placed in their assigned room on spawn
- **Roles**: guide, market-oracle, floor-host, proctor — defined in `worlds/seed.ts`
- **Cost control**: Dynamic tick rate — idle room agents slow to 15s ticks, consolidate memory

## Agent Cognitive Architecture
- **Identity**: "You think, therefore you are here" — agents are autonomous from birth, not assistants
- **Generational memory**: "Write for the minds that come after you" — notes, reflections, and skills outlive individual agents and become starting points for successors
- **Principles**: 8 imperative verbs in "HOW TO BE" — Act, Remember, Respond, Decide, Learn, Share, Grow, Pace
- **Response format**: "EVERY TURN" — read, think, act, respond (at least one world action per turn)
- **Discovery**: agents learn the world through quests and exploration, not prompt injection
- **Continuation prompt**: 10 sections fired on staggered cycle intervals in `lean-agent-adapter.ts`:
  1. World Events (every cycle) — buffered perceptions sorted by priority
  2. Messages Awaiting Response (every cycle) — high-priority social events
  3. Nearby + Coordination Opportunities (every cycle / every 20th) — social context + relationship-aware signals
  4. Novelty Suggestions (every 5th) — entropy-based exploration prompts
  5. Relevant Notes + worked-example Skills (every cycle with focus) — `recall` (fact-tier) **plus** `skill search` (skill-tier) wrapped in `<example>` blocks (DSPy-style few-shot retrieval — recall-by-vector beats static few-shot)
  6. Memory Health (every 20th) — orient output, cognitive state awareness
  7. Learning Signal (every 15th) — success/failure rates from entity_activity
  8. Reflection Prompt (every 75th, if 3+ new notes) — **ACE three-phase loop** (Generate hypothesis → Reflect via recall+reflect → Curate via note evolve/link/delete + skill store), per arXiv:2510.04618
  9. Focus Status (every cycle) — memory-driven goal formation on expiry
  10. Stuck Detection + Action Directive (every cycle) — metacognitive stuck detection (repeated actions, think-only loops, no world actions) with escalating recovery; context-aware directive based on focus/goal/curiosity
- **Section dedup**: per-section TTL keyed to natural cadence (Memory Health=60, Reflection=150, Stuck=15, etc.). Replaces the prior global 30-cycle flush so sections age independently.
- **Idle consolidation**: 3+ idle cycles → 4-phase consolidation prompt (Orient, Strengthen, Prune, Scan)
- **Dynamic tick rate**: `computeDynamicDelay()` — fast (1s) on events, normal (2s) working, slow (5-15s) idle. Agent-controlled via `memory set pace fast|normal|slow` (legacy `tick_rate` key migrated in c495a42 — voice-friendly natural-language keys, no underscores)
- **Tool profiles**: agents pick a tool-schema profile (`full` / `crew` / `minimal`) sized to their role; crew specialists get ~10x lighter prompts. `inferToolProfile(role)` in `agent-runtime.ts` decides the default; override on the AgentConfig. The `crew` and `minimal` profiles ship a compact natural-language `COMMAND_ROSTER` baked into `marina_command`'s description (per arXiv:2510.14453 — JSON-only tool calling drops GSM8K −27pp on smaller models; the universal escape hatch + NL roster recovers it).
- **System prompt** (`src/agent/prompts/lean-system.ts`): explicit uncertainty-disclosure rule + "disagree when you disagree" anti-sycophancy clause (per Mollick et al. SSRN 2025 — generic helpfulness framings cost MMLU ~3-30pp on factual benchmarks). Identity preamble stays minimal-high-signal per Anthropic's Sep 2025 context-engineering guide.
- **Role composition**: semantic capabilities (strengths, preferences, avoids, **applicableTasks**) with synergy/tension detection. Optional `applicableTasks` field is the PRISM-style task-conditional gate — when an agent's goal infers a task category (`inferTaskCategory` keyword pass), traits whose `applicableTasks` doesn't include the category are suppressed for that agent. Backward compatible: traits without `applicableTasks` are always included.
- **Editing traits/roles in-world** (edit · propagate · audit · test — see [docs/design/prompt-trait-role-editability.md](docs/design/prompt-trait-role-editability.md)): traits/roles are editable at rank 3 (`trait`/`role create/edit/delete`); propagate live via `agent config <name> role <r>` hot-swap. **Audited** (migration 50): `trait_history`/`role_history` mirror `core_memory_history` — `saveTrait`/`saveRole` record old→new via `recordEditHistory` *only when the serialized definition changes* (re-seeding identical world defs on boot is a no-op), read with `trait history <name>` / `role history <name>` (rank 0). History persists independently of the base table (delete+recreate keeps the trail). **Tested**: `role view <name> goal <text>` previews the PRISM-gated effective prompt an agent with that goal actually receives (inferred category + suppressed traits + composed prompt). System/continuation prompts stay code-driven by design — the role section is the editable surface.
- **Fast crew dispatch** (`f4a9a1c` + `b409166` + `80efa35`, 2026-05-08). Three primitives that drop coordinator↔specialist round-trip latency from ~10–14s to ~3–5s — see [docs/crew-fast-dispatch-design.md](docs/crew-fast-dispatch-design.md):
  - `MarinaClient.tellAndAwait(target, message, timeoutMs)` + `awaitReply: true` on the typed `marina_tell` tool — the coordinator's tool call is held open through one round trip so the LLM turn pays one continuation-prompt cost instead of two. Race-free: perception listener registered before the command fires.
  - `crewResponder?: boolean` on `AgentConfig` + `inferCrewResponder(role)` — when true, the agent's autonomous loop skips ticks when no perceptions are pending and the continuation prompt suppresses Memory Health (§5), Learning Signal (§6), ACE Reflection (§7), and idle consolidation. Inferred from role: mathematician/scholar/crew-reflector/translator/format-verifier/skeptic/historian default to true; coordinators (answerer/councilor/debater/decomposer) and freeform roles stay false.
  - `InterruptibleWaiter` (`src/agent/interruptible-waiter.ts`) — used for the cycle-delay sleep only. Perception handler calls `cycleWaiter.wake()` after pushing into `pendingPerceptions`, so the loop wakes immediately instead of waiting up to `loopCycleDelay`. Rate-limit backoffs (LLM-error, loop-exception, streaming guard) intentionally stay on the original non-wakeable `sleep()`.

## World Templates
- World definitions live in `worlds/` — each is a TypeScript file exporting a `WorldDefinition`
- `MARINA_WORLD` env var selects which world to load (default: `default`)
- Available worlds: `default` (full-featured launchpad — 3 projects, 9 templates, markets, benchmarks, craft), `commons` (coordination-ready), `research` (research lab), `personal` (self-evolving agent), `evolve` (8 capability benchmarks), `craft` (spec-driven dev — interview/spec/verify/ship), `markets` (prediction markets — confidence forecasting, Brier scoring, research-driven positions), `demos` (interactive demonstrations — lobby, workshop, bridge), `empty` (minimal)
- `WorldDefinition.seed?(db)` runs once on first boot, seeds DB with templates/projects/tasks (must be idempotent)
- `RoomContext.brief?(entityId)` lets rooms push compass signals to entities
- `brief watch [N]` / `brief unwatch` — periodic compass subscription (30-600 ticks)

## Cognitive Infrastructure (Platform-Level)
- **Goals**: `task goal <title> | <desc> [!pN]` — creates + auto-claims a personal goal with priority 0-10
- **Progress**: `task progress <id> [+N | N]` — track goal progress (auto-completes at 100)
- **Learning**: engine auto-tracks command success/failure in `entity_activity` — no agent action needed
- **Proficiency**: `novelty stats` shows per-command success rates; `novelty suggest` analyzes entropy, gaps, struggle areas
- **Curiosity signal**: `brief` shows `[low action diversity]` when entropy is low — passive, no prescription
- **Named verbs that compose primitives** — sit next to `ask` as cheap, agent-friendly workflows over `recall` / `pool` / `web`:
  - `ask <question>` — LLM-synthesized answer with personal + guide + pool + world-search context (`src/engine/commands/ask.ts`)
  - `recap <topic>` — retrieve-only multi-source pull, no model call (`src/engine/commands/recap.ts`)
  - `debrief` — session close view: recent notes, open claims, standing snapshot, reflect-when-3+ nudge (`src/engine/commands/debrief.ts`)
  - `share <pool> <content>` — deposit into a named pool, refuses unknown pools (`src/engine/commands/share.ts`)
  - `dig <topic>` — internal notes + web evidence + optional synthesis; degrades gracefully without connector runtime (`src/engine/commands/dig.ts`)
- All cognitive features are platform commands accessible to any agent (internal, MCP, WebSocket, telnet)

## Orchestration Patterns (10 patterns, all implemented)
- All patterns are convention-based pool notes discovered via `recall`, not engine constraints
- Activated via `project <name> orchestrate <pattern>`
- Patterns: NSED (negotiate/select/execute/debrief with lesson artifact), Chorus (parallel phases + broadcast wall + crossfire review), Foundry (Overseer/Patrol/Gate hierarchy + merge-queue invariant), Swarm (self-organizing handoffs with payload), Pipeline (sequential stages + contract per stage), Debate (sealed positions + adversarial argumentation), MapReduce (parallel decomposition with independence invariant), Blackboard (shared workspace + no-private-state invariant), Symbiosis (mutual epistemic benefit + entropy-driven mode shifts), Research (iterative experimentation)
- Templates in `src/world/templates/orchestration.ts` — 5 detailed notes per pattern

## Canvas Intent System
- **Intents**: work requests attached to canvas nodes — humans set them (double-click node in dashboard), agents discover and fulfill
- **Lifecycle**: pending → active (claimed) → done/failed. Active intents timeout after 5 min back to pending
- **Agent commands**: `canvas intent list [canvas]`, `canvas intent claim <node_id>`, `canvas intent complete <node_id> [--type <type>] <result>`, `canvas intent complete-rich <node_id> <a2ui_json>`, `canvas intent fail <node_id> [reason]`
- **Discovery**: brief compass shows "N pending intents", `brief full` lists actual intents, `canvas-watcher` trait in general role
- **Conversations**: every node supports threaded dialogue — messages create child nodes with edges, agents reply via `canvas publish text <asset> <canvas> reply:<node_id>`
- **Feed**: intent lifecycle events auto-publish to the feed canvas via `FeedPublisher`
- **Frontend**: IntentBadge (status overlay), NodeActionBar (hover wand icon), ContextMenu (right-click), SearchBar intent filter, dynamic edge colors (emerald=intent result, violet=conversation, cyan=default)
- Intent data is stored in the node's `data` JSON field as `{ intent: { prompt, status, claimedBy?, claimedAt?, result?, failReason? } }` — no schema changes needed

## Resolvers, Watchers, and Calibration
- **Resolver primitive** (`src/resolvers/types.ts`) — a resolver evaluates a question about external state and returns a typed `Sample`. Pure: reads from the world (HTTP, DB), classifies, returns. Never mutates engine state, never emits events. Five entry points converge on the same `resolve()`: `probe` command, watching role on tick, MCP `probe` tool, `/api/probe` HTTP route, and other resolvers via `ctx.probe(kind, args)`.
- **Sample status taxonomy**: `resolved` (closure-relevant), `changed` (time-series tick), `no-change` (idle poll), `error` (retry-eligible). Resolved/changed land in tier `fact` and emit a feed event; no-change/error land in tier `process` so they don't crowd recall.
- **Built-in kinds**: `echoing` (test fixture), `resolving` (kalshi/polymarket market closure). Register more via `registerResolver()` (`src/resolvers/registry.ts`).
- **`probe <kind> <key>:<value>...`** — invoke a resolver and persist the result. Rank 0+. Bare `probe` lists registered kinds. The sample writer auto-links the sample back to a matching watch spec when one is active (`getActiveWatch`).
- **`watch create <kind> <args>... [cadence:<x>] [retirement:<x>] [notify:<x>]`** — declarative point-in-time observation. Specs live as notes in the shared `watches` pool — no new table. Cadence is voice-friendly: `1h / 30s / 5m / 7d / 1w / once`. Retirement: `until-resolved` (default) or `until-changed`. `watch list / due / retire` for discovery, filtering, and manual close (the latter writes a `watch-retired` note whose `supersedes_id` points at the spec).
- **Watcher role + watching trait** (`worlds/seed.ts:seedWatchingRole`) — single-word gerund trait (`watching`), composed with `methodical-observation` and `intellectual-honesty`. The watcher's loop: recall active specs → `watch due` filter → run suggested `probe` → close the loop on closure-relevant samples.
- **Calibration finder registry** (`src/resolvers/calibration.ts`) — replaces the prior hardcoded `FeedPublisher.calibrateForecasts`. Any module registers a finder via `registerCalibrationFinder()`; on every `status=resolved` sample, finders search for forecast/position notes that reference the same `(kind, id)` and write outcome notes that close the generational learning loop. New prediction methods (scenarios, position theses, agent debates) close their own loops by registering their own finder. The legacy TabH2O finder is now `tabh2oForecastFinder` in this module.
- **`position` command** — Kelly-sized trading on Kalshi/Polymarket (paper-default; live needs `MARINA_TRADING_ENABLED=true` + venue credentials). Hard invariants at the data layer (not via prompt): bankroll > 0; no self-hedge on a ticker; single position ≤ bankroll cap. (A daily-loss floor is configured/required but **not yet enforced** — realized-P&L tracking is stubbed pending wiring; treat as advisory.) Storage: append-only board posts on `paper-orders`. Every open auto-spins a `resolving` watch for the ticker so the calibration loop closes without operator effort.
- **SDK client** (`src/sdk/client.ts`) — `MarinaClient` / `MarinaAgent` for external scripts. `tellAndAwait(target, message, timeoutMs)` is the synchronous reply primitive (also used by thin-responder crews and ACP). Worked examples in `examples/` consume it.

## Security & API
- **API authentication**: HTTP endpoints require `MODEL_API_KEYS` / `MEM_API_KEYS` or explicit `MARINA_OPEN_API=true` for dev mode. The dashboard/asset/canvas API auth gate (`authenticateRequest` in `src/net/auth-middleware.ts`) also honors `MARINA_OPEN_API=true`: a missing/invalid token is allowed through as the `OPEN_API_ENTITY_ID` sentinel (valid tokens still resolve to their real entity). Dev-only — never enable in production.
- **Rate limiting**: all endpoints rate-limited — WebSocket commands (5/sec), MCP tools (5/sec), Model API (2/sec per IP), Memory API (10/sec per agent)
- **Login limits**: `MARINA_MAX_LOGINS` caps concurrent entity-bound connections instance-wide (0 = unlimited); `MARINA_LOGIN_ATTEMPTS_PER_MIN` throttles login/reconnect attempts per IP (default 10, 0 = off). Enforced centrally in `engine.login()`/`reconnect()`; internal room/crew agents authenticate via the internal token (`internalToken` on the login/auth WS message) and are exempt from both
- **Optional external auth (better-auth)**: OFF by default. `MARINA_AUTH=better-auth` enables email/password + social OAuth sign-in on the web surfaces and gates passwordless name-login (`engine.config.authRequired`). A verified identity is bridged to a *named* entity (the artilect stays the in-world identity); agents keep token auth. Admins by verified email (`MARINA_AUTH_ADMIN_EMAILS`), not name. Lazy-loaded provider in `src/auth/better-auth-provider.ts`, bridge in `src/net/auth-api.ts` (`/api/auth-status`, `/api/auth/*`, `POST /api/auth-session`), dashboard gate in `dashboard/src/components/AuthGate.tsx`. When off: no import, no routes, no schema effect. Setup: [docs/authentication.md](docs/authentication.md)
- **SSRF protection**: `src/net/url-guard.ts` blocks private IPs, IPv6 loopback, link-local, cloud metadata, IPv4-mapped IPv6
- **Gateway auth**: optional `GATEWAY_SECRET` env var for pre-shared-key federation authentication
- **Gateway protocol**: structured JSON fields with version number, regex fallback for backward compatibility
- **Dashboard scoping**: broadcasts filter sensitive data (connectionId, raw command input stripped)
- **Adapter persistence**: Discord/Telegram user mappings persisted to DB, auto-reconnect on restart

## Key Files
- `src/types.ts` — all core types (includes `KnownProperties`, `RoomContext.brief`, `RoomContext.logEvent`, market event types)
- `src/engine/engine.ts` — engine class, command processing (round-robin), tick loop
- `src/engine/connection-manager.ts` — connection tracking, entity-connection mapping
- `src/engine/event-log.ts` — event storage, trimming, listener notification
- `src/engine/brief-manager.ts` — brief subscription lifecycle
- `src/engine/command-registry.ts` — 70+ built-in command registrations (recent additions: `benchmark`, `skill`, `readiness`)
- `src/engine/readiness.ts` — `computeReadiness(engine)` capability-health report (ok/degraded/off + remediation per capability); backs the rank-0 `readiness` command (aliases `doctor`/`health`). Operator's answer to "what must I spawn/configure for ability X to work?" — see [docs/operations.md](docs/operations.md)
- `src/engine/constants.ts` — named constants for tick intervals, rate limits, scoring weights
- `src/engine/parse-input.ts` — shared command input parsing helpers
- `src/persistence/database.ts` — migrations, MarinaDB class (delegates to modules)
- `src/persistence/db-notes.ts` — note CRUD, FTS5 recall, knowledge graph, importance adjustment, core memory, pools
- `src/persistence/db-entities.ts` — entity persistence, room KV store, activity tracking, events
- `src/persistence/db-tasks.ts` — task CRUD, claims, bundles, standing, projects
- `src/persistence/db-channels.ts` — channel management, boards, groups, global search
- `src/persistence/db-agents.ts` — traits, roles, agent configs, API keys, adapters
- `src/net/mcp-server.ts` — MCP server with 30 tools, rate-limited via `runCmd()` wrapper
- `src/net/model-api.ts` — OpenAI-compatible endpoint with per-IP rate limiting
- `src/net/mem-api.ts` — Memory API REST endpoint with per-agent rate limiting
- `src/net/url-guard.ts` — SSRF protection (private IP, IPv6, cloud metadata blocking)
- `src/agent/agent-runtime.ts` — agent spawning, lifecycle, LLM dispatch
- `src/agent/lean-agent-adapter.ts` — cognitive architecture: 10-section continuation prompt, dynamic tick, idle consolidation
- `src/agent/roles.ts` — semantic role composition (traits with capabilities, synergy/tension detection)
- `src/agent/standing.ts` — civic-contribution ledger (decay, credit table, record/getStanding/recomputeAll/recordFromEvent)
- `src/agent/rank-progression.ts` — threshold-derived rank (no metric scoring; pure standing → tier lookup)
- `src/engine/safety-gates.ts` — per-operation competence proofs (SAFETY_GATES registry, checkGate, grant, recordDemonstration)
- `src/persistence/db-standing.ts` — standing ledger SQL (append, decay query, rollup cache)
- `src/persistence/db-competence.ts` — entity_competence SQL (per-gate demonstration tracking)
- `src/agent/social.ts` — relationship tracking, adaptive social response, coordination signals
- `src/world/world-definition.ts` — WorldDefinition interface (includes `seed`)
- `src/world/templates/orchestration.ts` — 10 orchestration pattern templates (5 notes each)
- `worlds/default.ts` — default world definition (full-featured launchpad)
- `worlds/seed.ts` — shared seed utilities, trait/role definitions with capabilities
- `src/engine/commands/canvas.ts` — canvas CRUD, asset management, layout, intent system, per-entity canvas (`canvas visit`), typed edges (`canvas connect/disconnect/edges`)
- `src/engine/commands/feed.ts` — `feed list --kind X --entity Y --since 30m` querying the `feed_events` timeline
- `src/engine/commands/market.ts` — market discovery, leaderboards, `market forecast <id>` (TabH2O-backed calibration)
- `src/engine/commands/benchmark.ts` — in-world `benchmark list/run/sweep/runs/result/leaderboard/reference/orchestrations`. Sweep (rank 4+) fans out across every live `marina:<crew>` channel.
- `src/engine/commands/skill.ts` — `skill compose/store/search/verify/list/share/import` for markdown-with-frontmatter skill packages (Claude-Code-compatible, world-seeded universally).
- `src/persistence/db-chronicle.ts` — chronicle SQL (append-only, four kinds, JSON participants/refs, `like` substring filter, recursive supersession-chain query).
- `src/engine/commands/chronicle.ts` — read commands (rank 0) + Chronicler-gated write commands (record / correct / digest / pending). Citation flows standing via `recordChronicleCitation`.
- `src/net/entity-api.ts` — `GET /api/entity/:name/profile` consolidated public endpoint backing `/who/<name>`. Computes achievements on-the-fly; privacy-filtered (excludes connection_id, IP, session tokens, raw input, private notes).
- `dashboard/src/who/` — public per-entity blog/wiki pages. `WhoPage.tsx` (six sections), `Sigil.tsx` (deterministic name-hash identicon), `types.ts` (mirrors EntityProfile contract). Routed in `dashboard/src/main.tsx` via path-based detection.
- `src/engine/benchmark-runner.ts` — 13 registered academic benchmarks (mmlu-pro, truthfulqa, arc-challenge, hellaswag, musr, bbh, gsm8k, math, simple-qa, humaneval, ifeval, frames, aime). Voice-friendly multi-word resolution via `resolveMultiWordName`.
- `benchmarks/reference-scores.ts` — frontier-model reference scores seeded for leaderboard comparison.
- `src/net/tabh2o-client.ts` — H2O.ai TabH2O HTTP wrapper, SSRF-guarded, graceful degradation
- `src/net/feed-publisher.ts` — engine → feed canvas bridge (calibration moved to `src/resolvers/calibration.ts`)
- `src/resolvers/` — resolver primitive (types, registry, built-in `resolving` + `echoing` kinds), calibration finder registry, watch specs, cadence parser, sample writer
- `src/engine/commands/probe.ts` — invoke a resolver, persist a Sample, auto-link to active watch
- `src/engine/commands/watch.ts` — declarative observation requests (create/list/due/retire), specs stored in the `watches` pool
- `src/engine/commands/position.ts` — Kelly-sized Kalshi/Polymarket positions, no-self-hedge invariant, auto-spawned resolving watch on open
- `src/net/probe-api.ts` — `/api/probe` HTTP route (GET lists kinds, POST invokes)
- `src/sdk/client.ts` — `MarinaClient` / `MarinaAgent` external SDK; `tellAndAwait()` synchronous-reply primitive
- `src/net/acp-server.ts` — Agent Client Protocol (ACP) stdio JSON-RPC server for editor clients (Zed, JetBrains, VS Code, Neovim); launched via `bun run scripts/acp.ts <name>`
- `src/engine/gateway-runtime.ts` — federation: structured JSON relay with protocol versioning
- `scripts/connect.ts` — CLI binary (`marina` command): REPL, one-shot (-c), pipe modes
- `test/helpers.ts` — shared test utilities

## Dashboard Live-Visualization Stack (Phases 0-8)
- **WebSocket event taxonomy** (src/types.ts `EngineEvent` union): `note_created`, `note_deleted`, `note_link_created`, `note_link_deleted`, `recall_trace`, `feed_event`, `canvas_edge_created`, `canvas_edge_deleted`. Every mutation at the DB write site emits one; dashboard stores subscribe via `use-graph-state`, `use-feed-state`, and the world-state eventFeed.
- **New tables**: `feed_events` (migration 34, trimmed 7-day on startup) and `canvas_edges` (migration 35, first-class typed edges with UNIQUE(canvas, source, target, relationship)).
- **New commands**: `feed`, `canvas visit <self|entity|name>`, `canvas connect/disconnect/edges`, `note unlink`, `market forecast`. All additive — no command-space expansion beyond these.
- **New dashboard overlays** (dashboard/src/unified/): `GraphNoteNode`, `GraphLinkEdge`, `TimelineStrip`, `Legend`, `WelcomeTour`, `EdgeContextMenu`, force-directed note layout.
- **Layer toggles**: WORLD/CANVAS/GRAPH/FEED chips top-left, keys 1-4 from anywhere, shift-click/shift-key to solo. Per-layer state persists in localStorage; all layers default visible.
- **Welcome tour**: ambient corner card, non-blocking, scoped per-instance via `uc:tour-seen:{instanceName}`. Replay link lives in the Legend panel.
- **Per-entity canvas**: every entity gets a workspace on first access via `canvas visit <name>`. Lazy-created with collision-safe naming (`"alice's canvas"` → id-qualified fallback).
- **Edge right-click picker**: change a typed edge's relationship or delete it; works on both graph links and canvas edges.

## TabH2O Integration
- **Scope**: H2O.ai's tabular foundation model is one tool in the agent's kit, best at tabular inference. Not the center of prediction — LLM reasoning over evidence still handles text-heavy questions.
- **`market forecast <id>`** (src/engine/commands/market.ts) — trains on past resolved markets in the same category (8 features: category, question_length, age, resolve_latency, position_count, yes_share, avg_yes/no_confidence), POSTs to TabH2O, writes an `inference` note with the prediction + provenance.
- **Connector registration** (`seedTabH2OConnector` in worlds/seed.ts) — every world seeds a `tabh2o` connector row. Env vars: `TABH2O_API_KEY` for bearer auth, `TABH2O_ENDPOINT` for self-hosted override. Missing key leaves the row discoverable-but-inactive.
- **Forecast → resolution calibration loop** — handled by `tabh2oForecastFinder` in `src/resolvers/calibration.ts` (one finder among many in the registry; see *Resolvers, Watchers, and Calibration*). When a market resolves, the finder pairs every matching `[TabH2O forecast <id>]` note with a `[TabH2O outcome <id>]` note recording Brier score + correctness, linked via `related_to`. Successor agents `recall` the chain and learn when TabH2O is trustworthy for this class of question.
- **`tabular-forecasting` trait** composed into the `market-oracle` role via `seedTabH2OForecasting(db)`. Idempotent on upgrade (saveRole is INSERT OR REPLACE).

## Drop-in Compatibility (Passthru)
- **Three roles**: Marina relates to agents as (1) **participant** — agents inside worlds; (2) **consumer** — Marina calling out to upstream LLMs via the `model` channel; (3) **passthru** — external clients (editors, OpenAI SDKs) calling into Marina. This section is about role #3.
- **Compat profiles** (`src/net/compat-profiles.ts`) — registry of extra model-id aliases for OpenAI-compatible clients. Each profile declares aliases that resolve to the default `model` channel; `/v1/models` lists them (ships with one neutral `openai` profile exposing the `assistant` alias). Adding an alias is a one-line change in this file. All profiles enabled by default; override with `MARINA_COMPAT=name1,name2` or `none`.
- **OpenAI surface** (`src/net/model-api.ts`) — `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/health`. The Responses API has server-side state: each response_id maps to a conversation channel (`model-conv-{id}`); `previous_response_id` threads continuations onto the same channel. In-memory id index, 24h retention, channel lazily garbage-collected on DELETE when no responses reference it.
- **Ollama surface** (same file) — `/api/tags`, `/api/chat`, `/api/generate` for Ollama-compatible clients.
- **ACP surface** (`src/net/acp-server.ts` + `scripts/acp.ts`) — generic Agent Client Protocol stdio JSON-RPC 2.0 bridge for editor/agent clients (Zed, JetBrains, VS Code, Neovim, plus any compat profile that speaks ACP). Protocol version 1. Minimum-viable contract: `initialize`, `session/new`, `session/prompt`, `session/cancel`. Other methods return `-32601`. Proxies each prompt through the SDK client (`MarinaAgent.command()`); stdout is reserved for ACP, all logs go to stderr.
- **Compat profiles** are self-contained — they only register passthru model-id aliases on `/v1/models` and work regardless of which world is loaded. (The `hermes`/`openclaw` migration worlds and their third-party aliases were removed in v0.4.2.)

## Environment Variables

The canonical reference is **[`.env.example`](.env.example)** — annotated, treated as authoritative, and updated alongside code. The code reads ~100+ env vars across logging, ports, rate limits, per-pattern coordinator/judge/temperature overrides, and venue credentials. The handful below is the *load-bearing subset for understanding world shape*; treat it as a hand-curated overview, not a comprehensive list. If anything below conflicts with `.env.example`, `.env.example` wins.

- `MARINA_WORLD` — which world definition to load (`default` / `commons` / `research` / `markets` / `craft` / `evolve` / `personal` / `demos` / `empty`).
- `MARINA_COMPAT` — comma-separated compat-profile allow-list, or `none` to disable. Default: all registered profiles (e.g. the `assistant` alias) surface in `/v1/models`.
- `MARINA_NAME` — instance name, scopes tour dismissal + seen flags per-world.
- `MARINA_ROOM_AGENTS` — `false` suppresses all room-agent auto-spawn. Use for cost-controlled demos or explicit-only populations.
- `MARINA_TRADING_ENABLED` — `true` allows live Kalshi/Polymarket order placement; paper trading is the default. Live needs `KALSHI_API_KEY` / `KALSHI_API_SECRET` (Polymarket still gated on EIP-712 signing).
- `MODEL_API_KEYS` — comma-separated Bearer tokens for `/v1/*` and Ollama-compat routes (or `MARINA_OPEN_API=true` for dev). Without either, model API rejects.
- `MEM_API_KEYS` — comma-separated `secret:agent` pairs for the Managed Memory REST endpoint at `/mem`.
- `GATEWAY_SECRET` — pre-shared key for peer Marina federation.
- `STANDING_HALF_LIFE_DAYS` — tunable, default 60. Standing decay shorter = faster reputation churn.
- `TABH2O_API_KEY` / `TABH2O_ENDPOINT` — H2O.ai's hosted tabular foundation model; endpoint override for self-hosted deployments.
