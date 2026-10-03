# Persistence — Migrations, Row Retention, Durable Keys

**When to read this:** you are adding a table or migration, deciding how long rows live, or keying anything by entity id. `CLAUDE.md` → "Architecture Rules" keeps the rules (append-only migrations, `RETENTION_POLICIES`, never-pruned tables, `durableEntityKey()` at the delegate boundary); this page is the full retention policy table and the two durable-key passes.

## Migrations
- Migrations: append to `FORWARD_MIGRATIONS` in `src/persistence/schema.ts` (re-exported as `MIGRATIONS` by `database.ts`), never modify existing migrations. `MARINA_DB_DURABILITY=full` (fsync per commit) is the world default; migrations 96–109 are append-only like all others.

## Row retention
- **Row retention** (`src/engine/retention.ts`, hourly tick phase 2100, `runRetentionPass`): declarative `RETENTION_POLICIES` per table class — telemetry 7–30 d (`primitive_usage`, `feed_events`, `memory_service_events`, `coding_events`, `coding_service_probes`, `event_log` by row count), ledger 30–90 d (`direct_messages` acknowledged/expired, `cognitive_events`, `productivity_sessions`, `core_memory_history`, `media_jobs`, `memory_assistance_actions`, `memory_index_jobs` settled states only), audit 365 d (`witness_attestations`, `trace_judgments`, `note_verifications`, `evidence_receipts`, `association_events`), `shell_log` 90 d; `chronicle`, `entity_standing`, `memory_resolutions`, `economic_events` — and the lineage/replay logs `intellect_events`, `mesh_events`, `mesh_membership_events`, `journey_events`, `simulation_events`, `arena_submissions`, `arena_shadow`, and the benchmark ledger `benchmark_runs` / `benchmark_items` / `benchmark_promotions` / `benchmark_defaults` — are `append-only` and are never pruned (an override cannot re-enable it). `MARINA_RETENTION_OVERRIDES="table=30d,table2=0"` (0 = never). Batched deletes ≤ 5,000 rows via `db.deleteBatch` (uses `RETURNING rowid` — bun:sqlite `.changes` counts trigger writes). Missing tables/columns are skipped, not errors. Migration 116 adds the `direct_messages(deadline_at) WHERE status='delivered'` partial index plus `notes(supersedes_id)` and `note_sources(url)`.

## Benchmark ledger (migration 146)
- **Runs:** every benchmark run is a ledger row. `benchmark_runs` gains:
  - `cost_usd`, `n` and the Wilson 95 % interval (`ci_low`/`ci_high`);
  - `seed` and `slice_hash` (an order-free hash of the item ids);
  - `judge` (model plus route);
  - `target_kind` (`model` | `crew` | `population`) and `target_json`;
  - `label`, `source` (`in-world` | `import`) and `content_hash` (a unique import key).
- **Items:** `benchmark_items` keeps one outcome per item: id, correct, score, latency, cost, `trace_id`, `participants_json` (agents and models) and the judge verdict.
  - Item ids only: case content (questions, answers, responses) is never stored.
  - Rows are never rewritten; a trigger refuses `UPDATE`.
- **Writes:** one transaction through `recordBenchmarkLedgerRun`. Re-importing the same file returns the existing run.
- **Import:** `bun run benchmark:import` (`scripts/benchmark-import.ts`) records harness or Tier-0 results. It is an operator script, never an in-world command, and it drops any credential in the result's config.
- **Ranking:** the pure functions live in `src/engine/benchmark-ledger.ts` (paired comparison with exact McNemar, Pareto frontier, participant credit). They back `benchmark compare | frontier | participants` and the ledger columns of `benchmark leaderboard`.
- **Auto-filing (`POST /v1/benchmarks/runs`, `src/net/benchmarks-api.ts`):** a harness files a finished run into the Marina it measured.
  - The body is `{ result, targetKind, target, label?, judge?, costUsd? }`. Only item ids, outcomes, scores, latency, cost, judge verdict and `traceId` are kept, and the content hash is taken over that slim document, so re-filing is a no-op.
  - Auth is the model API's. The open-API sentinel may file only under the local, ungated profile; elsewhere a `MODEL_API_KEYS` credential is required (403 `open_api_read_only`).
  - The ledger source is `import`. The run's `config_json` records the attribution counts.
- **Participants (`src/engine/benchmark-participants.ts`):** each item's `traceId` is the target's `x-request-id` (`traceId === requestId`), resolved against the event log. Each participant records which evidence put it there:
  - `trace`: an `agent_turn_end` serving the request. That is either its own trace (the agent received the `model_request` while idle and the request parented its prompt) or a span link to it (see [Execution traces](traces.md) → span links):
    - the request was steered into a prompt already running;
    - the prompt served several requests at once;
    - the agent acted on work handed over from the request: a tell, crew post or task notice sent by an agent working on it carries its trace, and this is transitive.

    A turn serving one request is charged to it in full. A turn serving n requests gives each 1/n of its cost and marks the participant `tracedShared` (evidence `traced-shared`). A passthru request credits the upstream model.
  - `window`: turns by the routed agent's crew-mates that ended inside the request's received→completed window and serve no request trace (neither their own nor a link). This is the fallback when nothing propagated.
  - `shared`: another request to the same crew overlapped the window (found on a ±30 min padded range). The participant is listed, but its cost is not charged to the item.
  - The filing reply and the run's `config_json` also count `tracedSharedItems`: items with at least one cost-split turn.
  - An item whose request left no lifecycle events (event log pruned, or never routed through this Marina) records no participants and counts as `none`.

## Earned promotion of defaults (migration 147)
A default configuration — a crew formation, a per-agent model map, a world's crew model, any named slot — changes only when a challenger run from the ledger earns it over the incumbent run. `src/engine/benchmark-promotion.ts` holds the rule; `benchmark defaults | challenge | promote` is the surface.
- **Tables:**
  - `benchmark_defaults` has one row per slot: value, incumbent run, `holdout_fraction`.
  - `benchmark_promotions` is the append-only history: every seed, promotion and refused attempt, with the evidence statistics. A trigger refuses `UPDATE`; both tables are part of export and restore.
  - The actor is stored as the opaque durable account key, never a display name.
  - Retention never prunes either table.
- **Holdout:** each item belongs to a slot's selection or holdout split by a stable hash of slot + item id.
  - The fraction (default ½) is fixed once the slot exists.
  - `benchmark challenge` is a dry run that shows only the selection split. The holdout is read only by a `benchmark promote` attempt.
  - Evidence that touches a selection item is refused.
- **Rule:** the challenger and incumbent must have the same benchmark, the same recorded judge and the same item slice.
  - At least 20 paired holdout items.
  - The paired 95 % interval on the accuracy difference lies above zero: Agresti–Min for single runs, the two-stage bootstrap over replicates (below) otherwise.
  - The difference clears `promotionMargin(tried)` — the fishing margin `evolve replicate` and arena signal discovery share — where `tried` counts earlier attempts on the slot, each of which read the holdout.
  - Optional `--max-cost-ratio`.
- **Who:**
  - Promotion takes `role.edit` through `checkRoleEdit`, since a default changes every agent that runs on it. A refusal raises a challenge.
  - The author of the challenger run can never promote it; the check compares durable account keys.
  - The first incumbent seeds an empty slot.
- **Replicated:** the challenger's replicate group (below) must hold at least `MARINA_PROMOTION_MIN_REPLICATES` runs (default 2) — seeding included.
  - The check runs BEFORE the holdout is read, so an unreplicated attempt neither sees the holdout nor counts as a try.
  - With replicates on either side, the interval is the two-stage bootstrap on pooled per-item outcomes, not Agresti–Min. A challenger in the incumbent's own group is refused.
- **Consumers:** `getPromotedDefault(db, slot)`. The showcase world reads slot `showcase:crew`'s `model` for its crew when `MARINA_CREW_MODEL` is unset; environment variables always win.

## Replicate groups (migration 148)
Identical runs differ: two runs of one crew on the same 200 items can disagree on a dozen. So one run — and one McNemar p-value — is a single draw. `benchmark_runs.replicate_group` lets repeated runs of ONE configuration pool (`src/engine/benchmark-replicates.ts`; statistics in `benchmarks/replicate-stats.ts`).
- **Membership:**
  - A run belongs to the group it names. It gets one from `--group` on the harness and import, `replicateGroup` on `POST /v1/benchmarks/runs`, or `--replicate-of <run>`; `bun run benchmark:import --regroup <ids> --group <key>` moves recorded runs.
  - A run that names none belongs to the automatic group of its benchmark, target (canonical JSON), item slice and judge. A run with no target or slice is its own group.
  - Groups never cross benchmarks. Members whose target, slice or judge differ are flagged.
- **Pooled view:**
  - Each item's score is the mean of its replicates' outcomes, and pooled accuracy is the mean over items. Only items in every replicate are used. A majority-vote figure is shown too.
  - Between-run variation is the SD of replicate accuracies plus per-item agreement: unanimous items, and mean pairwise agreement.
- **Comparison:** a two-stage (cluster) bootstrap resamples each group's runs, then items, giving a percentile interval and a two-sided p on the pooled difference. Resampling runs puts run-level variance — a degraded crew, a provider's bad patch — inside the interval.
  - Every replicate pair's exact McNemar p is listed, to show how far one draw can swing.
  - A side with one replicate is flagged "not replicated".
- **Surface:** `benchmark compare` adds the pooled section, `benchmark leaderboard` lists replicate groups pooled, and `benchmark replicates <run>` shows one group.

## Durable keys
- **Durable keys, second pass (migration 117)**: `group_members`, `channel_members`, `board_votes`, `task_votes`, `flywheel_bindings`, `coding_projects`, `coding_services` are rekeyed to `users.id`; `MarinaDB` delegates resolve `durableEntityKey()` on write and project back to the LIVE entity id on read (`liveEntityIdSql`), so callers keep passing entity ids. `getFlywheelBinding(entityId)` replaces the linear scan; `saveEntity` re-keys task claims by name on first persist of a new id. Migrations 118 and 119 closed the remaining transient columns (see below). `approveSubmission`, `deleteNote`, and `deleteUser` (account erasure, below) are transactional.
- **Durable key, first pass (migration 109)** — the standing, competence, and witness ledgers: see `docs/architecture/civic-substrate.md` → "Standing — the single blended metric" (entity ids are transient — evicted after the 60s reconnect grace, re-minted on the next name-login — so ledgers are keyed by `users.id`; `MarinaDB.durableEntityKey()` resolves them at the delegate boundary and ids with no account pass through unchanged).

See also: `docs/architecture/memory.md` (memory tables, twin lifecycle), `docs/guides/identity.md`.

## Account erasure — the one exception to append-only
`deleteUser(id)` (`src/persistence/db-users.ts`) is the single, explicit exception to the append-only ledgers: erasing a world account removes what is keyed by its durable id instead of leaving orphans nothing can resolve. One transaction:
- **deleted** (the account's own rows): `entity_standing` and `entity_standing_cache`, `entity_competence`, `witness_attestations`, `group_members`, `channel_members`, `board_votes`, `macros`, `adapter_links`;
- **anonymized** to `ERASED_ACCOUNT` (`"[erased]"`, rows other people depend on): `tasks.creator_id`/`creator_name`, `board_posts.author_id`/`author_name`; a group the account led passes to its highest-ranked remaining member, else `ERASED_ACCOUNT`;
- **audited**: one chronicle `event` (source `account`, title `account erased`, ref `user:<id>`, body = per-table counts — never the name). The call returns the same counts (`AccountErasure`).

No other code path deletes or rewrites `entity_standing`; the former `migrateEntityId` (which rewrote it on id changes) was removed — durable keys make it unnecessary. Retention never prunes it (`append-only` policy).

## Facade and store interfaces

`src/persistence/database.ts` is a thin facade: `MarinaDB` owns the two connections (writer `db`, read-only `reader`), `open`/migrate/`close`, `transaction()`, the durable-key cache (`durableEntityKey()`), and one-line delegates. Every query lives in a standalone `fn(db: Database, …)` in a `db-*.ts` module. The facade is where entity ids resolve to durable keys — a module never calls `durableEntityKey()`; it receives an already-resolved `entityKey` (or `authorKey`) parameter and the facade passes `this.durableEntityKey(id)` at the call site. Modules that only read take `reader`; the few that write and then read back (`createCodingProject`, `snapshot`) take both.

Each module has a matching interface in `src/persistence/interfaces/` — explicit method signatures, not `Pick<MarinaDB, …>`, so a test can implement one with a plain object. `MarinaDB implements MarinaStores` (the aggregate that extends every store); consumers can start typing a dependency as `NotesStore` instead of `MarinaDB` without any runtime change. Each store file also exports a runtime tuple of its method names (`NOTES_STORE_METHODS` …) plus an `ExactKeys` compile-time proof that the tuple covers the interface; `STORE_METHOD_MANIFEST` in `interfaces/index.ts` aggregates them and `test/persistence-interfaces.test.ts` asserts that every public method on `MarinaDB.prototype` is claimed by exactly one interface (no unclaimed, no phantom, no duplicates), so the interfaces cannot drift from the facade silently.

- **Batch reads and bounded caches**: `getNotes(ids)` (`db-notes.ts`, facade, `NotesStore` + `NOTES_STORE_METHODS`) returns every existing note among `ids` with one `SELECT … WHERE id IN (…)` per `NOTES_BATCH_CHUNK_SIZE` (500) chunk, duplicates collapsed, order unspecified — the replacement for per-id `getNote` loops (first consumer: `memoryObserver().links()/sources()`, previously two `getNote` per link). `durableEntityKey()`'s transient-id → `users.id` map is an LRU bounded at `DURABLE_KEY_CACHE_MAX` (5 000): a hit is re-inserted to refresh recency, a miss past the bound evicts the oldest key (Map insertion order), ids with no account are never cached, and `deleteUser` still drops every entry that resolved to the deleted account (`test/durable-key-cache.test.ts`).

| Interface | Module(s) | Scope |
| --- | --- | --- |
| `CoreStore` | `database.ts` | `durableEntityKey`, `durableKeyForName`, `transaction`, `checkpoint`, `close` |
| `MaintenanceStore` | `db-maintenance.ts` | `tableExists`, `tableColumns`, `deleteBatch` (retention), `snapshot`, `snapshotCompacted` |
| `EntitiesStore` | `db-entities.ts` | entities, room KV, sessions, event log, trace judgments, activity, entity migration |
| `EvidenceStore` | `db-evidence.ts` | evidence receipt chain |
| `LogsStore` | `db-logs.ts` | structured logs |
| `UsersStore` | `db-users.ts` | world accounts, bans, adapter links, adapter user mappings |
| `PrincipalsStore` | `db-principals.ts` | principals, workload credentials |
| `NotesStore` | `db-notes.ts` | legacy notes, core memory, note links, pools, memory API keys, quality summary |
| `MemoryServiceStore` | `db-memory-service.ts`, `db-memory-admission.ts`, `db-memory-retention.ts`, `db-principals.ts` | repository handle, admission, credentials, receipt compaction |
| `TasksStore` | `db-tasks.ts` | tasks, claims, projects, legacy task-standing reads |
| `StandingStore` / `CompetenceStore` / `WitnessStore` | `db-standing.ts` / `db-competence.ts` / `db-witness.ts` | durable-keyed reputation ledgers |
| `ChannelsStore` | `db-channels.ts` | channels, boards, groups, global search |
| `CrewsStore` | `db-crews.ts` | crews |
| `DirectMessagesStore` | `db-direct-messages.ts` | durable direct-message receipts |
| `MacrosStore` | `db-macros.ts` | macros (`MACRO_COLUMNS` projection) |
| `RoomsStore` | `db-rooms.ts` | room sources, room templates, `clearDynamicRooms` |
| `CommandsStore` | `db-commands.ts` | dynamic commands + history, `clearDynamicCommands` |
| `ConnectorsStore` / `GatewaysStore` | `db-connectors.ts` / `db-gateways.ts` | connectors; gateways + bridges |
| `AgentsStore` | `db-agents.ts` | traits, roles, agent configs, API keys, adapters |
| `SettingsStore` | `db-agents.ts`, `db-meta.ts` | settings table, default model, `meta` key-value |
| `FederationStore` | `db-federation.ts` | peers, trust, world id |
| `WorldVariantsStore` | `db-world-variants.ts` | world variants (promotion writes an evidence receipt in one transaction) |
| `FeedStore` / `ChronicleStore` | `db-feed.ts` / `db-chronicle.ts` | feed events; chronicle |
| `BenchmarksStore` | `db-benchmarks.ts` | benchmark runs |
| `AlertsStore` | `db-alerts.ts` | operational alerts |
| `TelemetryStore` | `db-telemetry.ts` | productivity sessions, primitive usage, prompt outcomes |
| `FlywheelStore` | `db-flywheel.ts` | flywheel bindings, sandbox projects/services, probes, operations, credential bindings |
| `CodingStore` | `db-coding.ts` | coding sessions, events, artifacts |
| `ExperimentsStore` / `EvolutionStore` | `db-experiments.ts` / `db-evolution.ts` | experiments; evolution sessions and runs |
| `AssetsStore` / `MediaStore` | `db-assets.ts` / `db-media.ts` | assets; media jobs |
| `CanvasStore` | `db-canvas.ts` | canvases, nodes, edges, intents (`parseCanvasIntent`) |
| `ShellStore` | `db-shell.ts` | shell allowlist, shell log |
| `MarketsStore` | `db-markets.ts` | markets, positions, calibration scores |
| `JourneysStore`, `CognitiveEventsStore`, `IntellectsStore`, `AssociationsStore`, `ReproductionStore`, `MeshesStore`, `EconomicsStore`, `SimulationsStore`, `MutationsStore` | the same-named `db-*.ts` | one interface per module |

Adding a delegate: put the query in the module, add the one-line delegate to `MarinaDB`, add the method to the matching interface and its `*_STORE_METHODS` tuple — the `ExactKeys` check and the drift test fail until all three agree. Row types are declared in their module and re-exported from `database.ts` so importers keep one path.

## Command phase: per-entity chains and a wall-clock budget (2026-09-22)

`processCommand` is async; the round-robin used to fire it un-awaited, so one entity's queued commands could interleave past their first `await`. `Engine.dispatchQueued` now keeps a per-entity promise tail (`commandChains`): an idle entity's command starts synchronously, a busy entity's is chained after its previous one, so a single entity runs strictly FIFO while different entities still interleave. A rejection that escapes `processCommand` before the handler's own try (modal routing, parse, context build) is routed to the tick error path (`recordTickError`) instead of becoming an unhandled rejection. The command phase stops dispatching after `COMMAND_PHASE_BUDGET_MS` (150 ms, `MARINA_COMMAND_PHASE_BUDGET_MS`) and carries the per-entity remainder to the next tick in order; `MAX_COMMANDS_PER_TICK` still bounds the count. `drainCommands()` / `queuedCommandCount` are test seams. The macro fan-out stays un-awaited (its tests expect synchronous completion).

`RoomSandbox.wrapModule` returns a room command handler's value (previously the closure discarded it), so an async room command's promise reaches the chain; an async rejection is recorded as a room violation via `execHandler`, never as an unhandled rejection.

## Migration 118 and the contradiction-case twin exclusion

`groups_.leader_id` and `tasks.creator_id` are rekeyed to `users.id` (EXISTS-guarded `UPDATE OR IGNORE`); `createGroup`/`createTask` resolve `durableEntityKey()` and every group/task read projects the live id back (`GROUP_COLUMNS`, `TASK_COLUMNS`), so `GroupManager` and `TaskManager` keep comparing entity ids.

## Migration 119: board post and macro authors

`board_posts.author_id` and `macros.author_id` are rekeyed to `users.id` with the same EXISTS-guarded `UPDATE OR IGNORE`. `macros` has `UNIQUE(name, author_id)`, so a collision (the account already owns a durable macro of that name) leaves the transient row in place — a macro is content, not a mirror row, so nothing is deleted. `MarinaDB.createBoardPost` / `createMacro` resolve `durableEntityKey()` on write, the `author_id = ?` lookups (`getMacroByName`, `listMacros(authorId)` — the "my macros" path) resolve it too, and every read projects the live entity id back (`BOARD_POST_COLUMNS` in `db-channels.ts`, `MACRO_COLUMNS` in `database.ts`), so `MacroManager`'s ownership checks, `crew` result posts and the `paper-orders` board keep passing and comparing entity ids. An offline account (no live entity) reads back as the durable key itself. `room_sources.author_id` / `room_templates.author_id` stay as they are: display-only (`author_name` is what renders), never compared or looked up. With 119 no entity-keyed column is still transient.

## Migration 120: `agent_configs.thinking_level`

`ALTER TABLE agent_configs ADD COLUMN thinking_level TEXT` — nullable, NULL = never set. `saveAgentConfig` writes the level when given and otherwise keeps the stored value (`COALESCE(excluded.thinking_level, agent_configs.thinking_level)`), so a `model`/`role` reconfigure never clears an earlier `thinking` choice; `AgentRuntime.init()` and `restart()` hand the persisted level back to `spawn` via `parseAgentThinkingLevel`, and an unset column stays `undefined` (resolved at spawn by `resolveAgentThinkingLevel`, never stored as `'off'`).

`refreshContradictionCases` (`db-notes.ts`) excludes durable service-memory rows (`memory_record_versions`) from candidates and skips any pair where one note is the other's twin (`note_sources.url = marina-memory://record/<id>`), so `note conflicts` never lists a note against its own durable mirror.

## Migration 144: a stable FTS key for `markets`
`markets` had a TEXT primary key and `markets_fts` used `content_rowid=rowid`; VACUUM and VACUUM INTO (`snapshot`, `snapshotCompacted`, recovery bundles) may renumber the implicit rowid of such a table, silently pointing the external-content index at the wrong rows. Migration 144 rebuilds `markets` with `seq INTEGER PRIMARY KEY` (`id` stays the public key, `UNIQUE`, and the FK target), re-creates the FTS table on `content_rowid=seq` with its three triggers, and rebuilds the index. Because DROP TABLE on a referenced parent cascades with `foreign_keys=ON`, `market_positions` and `market_scores` are rebuilt alongside it, referencing the new parent before the rename. Any new external-content FTS table must use an INTEGER PRIMARY KEY as its `content_rowid` (`test/markets-fts-vacuum.test.ts`).

## Retired sources in `[evidence]`

`servableSourceIds(db, spaceId, sourceIds, now)` in `unified-context.ts` drops `source_search` hits whose every deriving record is retired (superseded tombstone, current note superseded, or `valid_until` past); a source with no deriving record stays (a plain capture), and a fresh record re-deriving it makes it servable again. A query failure keeps all hits — it is a guard, not an access check.


## Fresh schema and existing database upgrades

Fresh databases install `schema-baseline.ts` (version 137) in one SQLite transaction,
then apply any `FORWARD_MIGRATIONS` in `schema.ts`. This avoids replaying historical
ALTER statements, index rebuilds, data conversions and per-version disk commits on
an empty database. The baseline marker stays 137; forward migrations advance the database to the
current version. Consolidation does not reset the schema counter.

`schema-history.ts` retains the original SQL unchanged for populated databases. A
database with any existing schema takes the historical upgrade path; the baseline
is never stamped over existing tables. Pending versions still commit individually,
a failure stops at the previous version, and newer unsupported schemas fail closed.

`bun run schema:check` regenerates the baseline in a disposable in-memory database
and checks the committed artifact. FTS shadow tables are created by SQLite, not
copied as independent tables. Indexes, triggers, foreign keys and seeded allowlist
entries are included; seed timestamps remain installation timestamps. Regression
tests compare the baseline's schema and seed data with historical replay and test
populated older databases, FTS writes/deletion, and reopening.

New changes belong in `FORWARD_MIGRATIONS`, after its last version. Migration 138
converts numeric memory inside the same transaction as its DDL and version marker. Migration 139
adds `challenge_outcomes` (answered challenges, see civic-substrate.md), migration 140 carries
capability across to the `world.lineage` / `world.code` gates, migration 141 adds `roles.loop`
(JSON role-owned loop sections, see agent-cognition.md), and migration 142 rebuilds `spend_daily`
so image/video generation (`media`) joins the daily spend ledger. Migration 143 rewrites
`mem_api_keys.secret` as a `sha256:<hex>` digest; keys are looked up by digest and the raw
secret is never stored. Migration 144 gives `markets` a stable INTEGER key for its FTS index, and
migration 145 adds `forecast_answers`; migration 151 rebuilds it (SQLite cannot widen a CHECK in
place) so typed answers — `choice`, `multi`, `ranking`, `text` — join `probability` and `number`,
with a `prediction` column holding the typed answer as one string. Do not edit the baseline
or archived migrations to implement a new feature.
